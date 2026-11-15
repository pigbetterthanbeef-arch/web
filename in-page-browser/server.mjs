import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

// Don't let the proxy be used to reach the machine it runs on.
wisp.options.allow_loopback_ips = false;
wisp.options.allow_private_ips = false;
wisp.options.allow_direct_ip = true;

const server = createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
    return;
  }

  if (path === "/") path = "/index.html";

  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
    return;
  }

  let data;
  try {
    data = await readFile(file);
  } catch {
    res
      .writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      .end("404 — not found");
    return;
  }

  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control":
      extname(file) === ".html" || path === "/sw.js"
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=3600",
    // The proxy populates pages inside an iframe, so don't block framing.
    "x-content-type-options": "nosniff",
  });
  res.end(data);
});

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  if (req.url && req.url.startsWith("/wisp/")) {
    try {
      wisp.routeRequest(req, socket, head);
    } catch {
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Browser listening on http://localhost:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
