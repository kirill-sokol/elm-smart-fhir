import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const files = {
  "/": [new URL("./index.html", import.meta.url), "text/html"],
  "/elm.js": [new URL("../../elm-stuff/live.js", import.meta.url), "text/javascript"],
  "/auth-bridge.mjs": [new URL("../../auth-bridge.mjs", import.meta.url), "text/javascript"]
};

createServer(async (request, response) => {
  const file = files[new URL(request.url, "http://localhost").pathname];
  if (!file) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const content = await readFile(fileURLToPath(file[0]));
    response.writeHead(200, { "content-type": file[1], "cache-control": "no-store" }).end(content);
  } catch {
    response.writeHead(500).end("Build first with npm run build:live");
  }
}).listen(8765, "127.0.0.1", () => {
  console.log("Manual SMART test: http://localhost:8765/");
});
