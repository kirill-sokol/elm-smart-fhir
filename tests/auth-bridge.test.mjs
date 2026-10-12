import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { wireSmartAuth } from "../auth-bridge.mjs";

const { Elm } = createRequire(import.meta.url)("../elm-stuff/auth-bridge-harness.js");
const config = {
  baseUri: "https://ehr.test/fhir",
  clientId: "elm-client",
  redirectUri: "http://localhost:8000/callback",
  scopes: ["launch/patient", "patient/Patient.rs", "offline_access"],
  launch: null
};
const metadata = {
  authorization_endpoint: "https://ehr.test/authorize",
  token_endpoint: "https://ehr.test/token",
  code_challenge_methods_supported: ["S256"]
};
const tokens = {
  access_token: "test-access-token",
  token_type: "Bearer",
  refresh_token: "test-refresh-token",
  expires_in: 600
};
const expectedClient = { baseUri: config.baseUri, accessToken: tokens.access_token };
const timestamp = 1000000;
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const pending = { ...config, tokenUri: metadata.token_endpoint, state: "test-state", codeVerifier: verifier };
const session = {
  ...config, tokenUri: metadata.token_endpoint,
  accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: timestamp + 600000
};
const saved = entries => new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]));
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function setup({ cache = new Map(), url = config.redirectUri, ...overrides } = {}) {
  const app = Elm.AuthBridgeHarness.init({ flags: null });
  const requests = [];
  let redirected;
  const redirect = new Promise(resolve => { redirected = resolve; });
  const location = { href: url, assign: target => redirected(new URL(target)) };
  const waiting = [];
  const results = [];
  app.ports.observedResponse.subscribe(result => {
    if (waiting.length) waiting.shift()(result);
    else results.push(result);
  });
  const next = () => results.length ? Promise.resolve(results.shift()) : new Promise(resolve => waiting.push(resolve));
  wireSmartAuth(app.ports, {
    crypto: webcrypto,
    storage: {
      getItem: key => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
      removeItem: key => cache.delete(key)
    },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return reply(url.endsWith("/.well-known/smart-configuration") ? metadata : tokens);
    },
    location,
    history: { replaceState: (_, __, url) => { location.href = url; } },
    now: () => timestamp,
    ...overrides
  });
  return {
    app, cache, requests, redirect, location,
    launch: (options = config) => app.ports.initialize.send(options),
    init: (options = config) => { const result = next(); app.ports.initialize.send(options); return result; },
    refresh: () => { const result = next(); app.ports.refreshSession.send(null); return result; }
  };
}

test("init discovers SMART, persists fresh PKCE state, then redirects", { timeout: 2000 }, async () => {
  const first = setup();
  first.launch();
  const target = await first.redirect;
  const transaction = JSON.parse(first.cache.get("smart-pending"));
  assert.equal(first.requests[0].url, config.baseUri + "/.well-known/smart-configuration");
  assert.equal(first.requests[0].method, "GET");
  assert.equal(target.origin + target.pathname, metadata.authorization_endpoint);
  assert.equal(target.searchParams.get("client_id"), config.clientId);
  assert.equal(target.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(target.searchParams.get("scope"), config.scopes.join(" "));
  assert.equal(target.searchParams.get("aud"), config.baseUri);
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("state"), transaction.state);
  assert.match(transaction.state, /^[A-Za-z0-9_-]{22}$/);
  assert.match(transaction.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(target.searchParams.get("code_challenge"), createHash("sha256").update(transaction.codeVerifier).digest("base64url"));
  assert.equal(target.searchParams.has("code_verifier"), false);
  assert.equal(first.cache.has("smart-session"), false);
  const another = setup();
  another.launch();
  const otherTarget = await another.redirect;
  assert.notEqual(otherTarget.searchParams.get("state"), transaction.state);
});

test("PKCE matches the RFC 7636 test vector", { timeout: 2000 }, async () => {
  const crypto = {
    getRandomValues: bytes => {
      bytes.set(bytes.length === 32 ? Buffer.from(verifier, "base64url") : new Uint8Array(16));
      return bytes;
    },
    subtle: webcrypto.subtle
  };
  const harness = setup({ crypto });
  harness.launch();
  const target = await harness.redirect;
  assert.equal(target.searchParams.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("callback exchanges code through actual Elm ports and returns FHIR.Client", { timeout: 2000 }, async () => {
  const harness = setup({ cache: saved({ "smart-pending": pending }), url: config.redirectUri + "?code=a%2Bb%26c&state=test-state" });
  assert.deepEqual(await harness.init(), { client: expectedClient });
  const request = harness.requests[0];
  assert.equal(request.url, metadata.token_endpoint);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.body)), {
    grant_type: "authorization_code", code: "a+b&c", client_id: config.clientId,
    redirect_uri: config.redirectUri, code_verifier: verifier
  });
  assert.equal(harness.cache.has("smart-pending"), false);
  assert.equal(JSON.parse(harness.cache.get("smart-session")).refreshToken, tokens.refresh_token);
  assert.equal(harness.location.href, config.redirectUri);
  const reloaded = setup({ cache: harness.cache });
  assert.deepEqual(await reloaded.init(), { client: expectedClient });
  assert.equal(reloaded.requests.length, 0);
});

test("missing, mismatched and duplicated state never reach the token endpoint", { timeout: 2000 }, async () => {
  for (const query of ["?code=test", "?code=test&state=wrong", "?code=test&state=test-state&state=test-state"]) {
    const harness = setup({ cache: saved({ "smart-pending": pending }), url: config.redirectUri + query });
    assert.deepEqual(await harness.init(), { error: "Missing or mismatched callback state" });
    assert.equal(harness.requests.length, 0);
  }
});

test("callback checks app, server, redirect location and code", { timeout: 2000 }, async () => {
  const cases = [
    { config: { ...config, clientId: "other-app" }, error: "No matching pending authorization" },
    { config: { ...config, baseUri: "https://other.test/fhir" }, error: "No matching pending authorization" },
    { url: "https://other.test/callback?code=test&state=test-state", error: "Unexpected callback URL" },
    { query: "?state=test-state", error: "Missing authorization code" },
    { query: "?state=test-state&code=a&code=b", error: "Missing authorization code" }
  ];
  for (const example of cases) {
    const harness = setup({ cache: saved({ "smart-pending": pending }), url: example.url ?? config.redirectUri + (example.query ?? "?code=test&state=test-state") });
    assert.deepEqual(await harness.init(example.config ?? config), { error: example.error });
    assert.equal(harness.requests.length, 0);
  }
});

test("reports authorization denial and consumes the pending transaction", { timeout: 2000 }, async () => {
  const harness = setup({ cache: saved({ "smart-pending": pending }), url: config.redirectUri + "?error=access_denied&state=test-state" });
  assert.deepEqual(await harness.init(), { error: "access_denied" });
  assert.equal(harness.cache.has("smart-pending"), false);
  assert.equal(harness.requests.length, 0);
});

test("requires HTTPS endpoints and S256 without downgrading", { timeout: 2000 }, async () => {
  for (const data of [
    { ...metadata, code_challenge_methods_supported: ["plain"] },
    { ...metadata, token_endpoint: "http://ehr.test/token" }
  ]) {
    const harness = setup({ fetch: async () => reply(data) });
    assert.ok((await harness.init()).error);
    assert.equal(harness.cache.has("smart-pending"), false);
  }
});

test("EHR launch starts a fresh flow with iss and launch, despite a cached session", { timeout: 2000 }, async () => {
  const harness = setup({ cache: saved({ "smart-session": session }), url: config.redirectUri + "?iss=https%3A%2F%2Fehr.test%2Ffhir&launch=chart-context" });
  harness.launch();
  const target = await harness.redirect;
  assert.equal(target.searchParams.get("launch"), "chart-context");
  assert.equal(target.searchParams.get("aud"), config.baseUri);
});

test("refresh rotates tokens; concurrent calls share one HTTP request", { timeout: 2000 }, async () => {
  let calls = 0;
  const harness = setup({ cache: saved({ "smart-session": session }), fetch: async (url, options) => {
    calls++;
    assert.equal(url, metadata.token_endpoint);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: config.clientId
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    return reply({ ...tokens, access_token: "new-access", refresh_token: "new-refresh" });
  } });
  const results = await Promise.all([harness.refresh(), harness.refresh()]);
  for (const result of results) assert.deepEqual(result, { client: { baseUri: config.baseUri, accessToken: "new-access" } });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(harness.cache.get("smart-session")).refreshToken, "new-refresh");
});

test("init refreshes an expired cached session and preserves an unrotated refresh token", { timeout: 2000 }, async () => {
  const harness = setup({ cache: saved({ "smart-session": { ...session, expiresAt: timestamp - 1 } }), fetch: async () => reply({ access_token: "renewed", token_type: "Bearer", expires_in: 600 }) });
  assert.deepEqual(await harness.init(), { client: { baseUri: config.baseUri, accessToken: "renewed" } });
  assert.equal(JSON.parse(harness.cache.get("smart-session")).refreshToken, tokens.refresh_token);
});

test("refresh without a token returns a clear error", { timeout: 2000 }, async () => {
  assert.deepEqual(await setup().refresh(), { error: "No refresh token; initialize authentication again" });
});

test("HTTP, token validation and storage failures reach the Elm subscription", { timeout: 2000 }, async () => {
  const url = config.redirectUri + "?code=test&state=test-state";
  for (const [data, status, message] of [
    [{ error: "invalid_grant" }, 400, "invalid_grant"],
    [{ access_token: "" }, 200, "Expected a bearer access token"],
    [{ access_token: "token", token_type: "MAC" }, 200, "Expected a bearer access token"]
  ]) {
    const harness = setup({ cache: saved({ "smart-pending": pending }), url, fetch: async () => reply(data, status) });
    assert.deepEqual(await harness.init(), { error: message });
    assert.equal(harness.cache.has("smart-session"), false);
  }
  const harness = setup({ storage: { getItem: () => { throw new Error("Storage unavailable"); } } });
  assert.deepEqual(await harness.init(), { error: "Storage unavailable" });
});
