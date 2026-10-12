/**
 * Minimal public-client SMART authorization-code + S256 flow.
 * Inspired by client-js; deliberately excludes FHIR HTTP operations.
 * Wire after Elm.Main.init: wireSmartAuth(app.ports).
 */
export function wireSmartAuth(ports, {
  crypto = globalThis.crypto,
  fetch = globalThis.fetch,
  storage = globalThis.sessionStorage,
  location = globalThis.location,
  history = globalThis.history,
  now = Date.now
} = {}) {
  const pendingKey = "smart-pending";
  const sessionKey = "smart-session";
  const read = key => JSON.parse(storage.getItem(key) ?? "null");
  const write = (key, value) => storage.setItem(key, JSON.stringify(value));
  const client = session => ({ baseUri: session.baseUri, accessToken: session.accessToken });
  const base64url = bytes => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let refreshTask;

  function https(value) {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("FHIR and authorization endpoints must use HTTPS");
    return url;
  }

  function matches(session, config) {
    return session && session.baseUri === config.baseUri
      && session.clientId === config.clientId && session.redirectUri === config.redirectUri;
  }

  async function json(url, body) {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body
        ? { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }
        : { accept: "application/json" },
      ...(body ? { body: new URLSearchParams(body).toString() } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || data.error || `Auth HTTP ${response.status}`);
    return data;
  }

  function storeTokens(context, data) {
    if (typeof data.access_token !== "string" || !data.access_token
      || data.token_type?.toLowerCase() !== "bearer") {
      throw new Error("Expected a bearer access token");
    }
    const session = {
      baseUri: context.baseUri,
      clientId: context.clientId,
      redirectUri: context.redirectUri,
      tokenUri: context.tokenUri,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? context.refreshToken ?? null,
      expiresAt: now() + Math.max(0, Number(data.expires_in) || 0) * 1000
    };
    write(sessionKey, session);
    return client(session);
  }

  function refresh() {
    if (!refreshTask) {
      refreshTask = (async () => {
        const session = read(sessionKey);
        if (!session?.refreshToken) throw new Error("No refresh token; initialize authentication again");
        https(session.tokenUri);
        const data = await json(session.tokenUri, {
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
          client_id: session.clientId
        });
        return storeTokens(session, data);
      })().finally(() => { refreshTask = undefined; });
    }
    return refreshTask;
  }

  async function init(config) {
    const current = new URL(location.href);
    const params = current.searchParams;
    const pending = read(pendingKey);
    const cached = read(sessionKey);
    const ehrLaunch = params.has("launch");
    config = {
      ...config,
      baseUri: ehrLaunch ? params.get("iss") : config.baseUri || pending?.baseUri || cached?.baseUri,
      launch: ehrLaunch ? params.get("launch") : config.launch
    };
    https(config.baseUri);
    const redirect = new URL(config.redirectUri);
    if (redirect.protocol !== "https:"
      && !(redirect.protocol === "http:" && [ "localhost", "127.0.0.1", "[::1]" ].includes(redirect.hostname))) {
      throw new Error("Redirect URI must use HTTPS or localhost");
    }

    if (params.has("code") || params.has("state") || params.has("error")) {
      if (!matches(pending, config)) throw new Error("No matching pending authorization");
      if (current.origin !== redirect.origin || current.pathname !== redirect.pathname) {
        throw new Error("Unexpected callback URL");
      }
      const states = params.getAll("state");
      if (states.length !== 1 || !pending.state || states[0] !== pending.state) {
        throw new Error("Missing or mismatched callback state");
      }
      storage.removeItem(pendingKey);
      const cleanCallback = () => {
        for (const name of [ "code", "state", "error", "error_description" ]) params.delete(name);
        history?.replaceState(null, "", current.href);
      };
      if (params.has("error")) {
        const message = params.get("error_description") || params.get("error");
        cleanCallback();
        throw new Error(message);
      }
      const codes = params.getAll("code");
      if (codes.length !== 1 || !codes[0]) throw new Error("Missing authorization code");
      https(pending.tokenUri);
      const data = await json(pending.tokenUri, {
        grant_type: "authorization_code",
        code: codes[0],
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier
      });
      const result = storeTokens(pending, data);
      cleanCallback();
      return result;
    }

    if (!ehrLaunch && !config.launch && matches(cached, config)) {
      if (cached.expiresAt > now() + 10000) return client(cached);
      if (cached.refreshToken) return refresh();
    }

    const metadata = await json(config.baseUri.replace(/\/+$/, "") + "/.well-known/smart-configuration");
    if (!metadata.code_challenge_methods_supported?.includes("S256")) {
      throw new Error("The server must support PKCE S256");
    }
    const authorize = https(metadata.authorization_endpoint);
    const tokenUri = https(metadata.token_endpoint).href;
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const codeChallenge = base64url(new Uint8Array(digest));
    const fields = {
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      aud: config.baseUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    };
    if (config.launch) fields.launch = config.launch;
    for (const [name, value] of Object.entries(fields)) authorize.searchParams.set(name, value);
    authorize.hash = "";
    write(pendingKey, { ...config, tokenUri, state, codeVerifier });
    // Persist first; navigating unloads Elm, so no response is sent on this branch.
    location.assign(authorize.href);
    return new Promise(() => {});
  }

  ports.authCommand.subscribe(async command => {
    try {
      const result = command.type === "init" ? await init(command.config)
        : command.type === "refresh" ? await refresh()
        : (() => { throw new Error("Unknown auth command"); })();
      ports.authResponse.send({ type: "ready", client: result });
    } catch (error) {
      ports.authResponse.send({ type: "error", message: error.message });
    }
  });
}
