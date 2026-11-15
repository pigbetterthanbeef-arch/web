import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_KEY = process.env.ACCESS_KEY || "";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 2);
const VIEWPORT = {
  width: Number(process.env.VIEW_W || 1280),
  height: Number(process.env.VIEW_H || 800),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ------------------------------------------------------------------ *
 * one shared browser, one context+page per visitor
 * ------------------------------------------------------------------ */
let launching = null;

function browser() {
  if (!launching) {
    launching = chromium
      .launch({
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=Translate,MediaRouter",
        ],
      })
      .catch((err) => {
        launching = null;
        throw err;
      });
  }
  return launching;
}

const sessions = new Set();

// Don't let a public URL be used to reach the host's own network.
function safeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    host.endsWith(".internal")
  ) {
    return null;
  }
  return u.href;
}

const KEYMAP = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  " ": 32,
  Spacebar: 32,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
  CapsLock: 20,
  F5: 116,
  F12: 123,
};

function modifiersOf(msg) {
  return (msg.alt ? 1 : 0) | (msg.ctrl ? 2 : 0) | (msg.meta ? 4 : 0) | (msg.shift ? 8 : 0);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.closed = false;
    this.page = null;
    this.cdp = null;
    this.context = null;
    this.lastUrl = "";
  }

  send(message) {
    if (this.closed || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {}
  }

  async start() {
    const b = await browser();
    this.context = await b.newContext({
      viewport: VIEWPORT,
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    this.context.setDefaultTimeout(45000);
    this.context.on("page", (p) => {
      // Links that open a new window: keep riding the newest page.
      if (!this.closed) this.attach(p).catch(() => {});
    });
    const page = await this.context.newPage();
    await this.attach(page, { initial: true });
    this.send({ t: "ready" });
  }

  async attach(page, opts = {}) {
    if (this.closed) return;
    const previous = this.page;
    this.page = page;

    if (previous && previous !== page) {
      try {
        await previous.close();
      } catch {}
    }

    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;

    cdp.on("Page.screencastFrame", async (ev) => {
      if (this.closed) return;
      this.send({ t: "frame", d: ev.data, w: ev.metadata.deviceWidth, h: ev.metadata.deviceHeight });
      cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });

    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: Number(process.env.QUALITY || 62),
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });

    const sync = () => {
      const url = page.url();
      if (url === this.lastUrl) return;
      this.lastUrl = url;
      this.send({ t: "url", url });
    };

    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) sync();
    });
    page.on("load", sync);
    page.on("close", () => {
      if (!this.closed && page === this.page) this.send({ t: "closed" });
    });
    page.on("crash", () => this.send({ t: "error", m: "The page crashed." }));

    sync();

    if (!opts.initial) {
      this.send({ t: "loading" });
      page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  }

  async goto(url) {
    if (!this.page || this.closed) return;
    const target = safeUrl(url);
    if (!target) {
      this.send({ t: "error", m: "That address can't be opened here." });
      return;
    }
    this.send({ t: "loading" });
    try {
      await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      this.send({ t: "error", m: String(e.message || e).slice(0, 160) });
    }
    this.send({ t: "done" });
  }

  async handle(msg) {
    if (!this.page || !this.cdp) return;

    switch (msg.t) {
      case "goto":
        return this.goto(msg.url);

      case "back":
        this.send({ t: "loading" });
        await this.page.goBack({ timeout: 20000 }).catch(() => {});
        return this.send({ t: "done" });

      case "forward":
        this.send({ t: "loading" });
        await this.page.goForward({ timeout: 20000 }).catch(() => {});
        return this.send({ t: "done" });

      case "reload":
        this.send({ t: "loading" });
        await this.page.reload({ timeout: 20000 }).catch(() => {});
        return this.send({ t: "done" });

      case "mouse": {
        const button = msg.button === 2 ? "right" : msg.button === 1 ? "middle" : "left";
        if (msg.type === "moved") {
          return this.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: msg.x,
            y: msg.y,
            modifiers: modifiersOf(msg),
          });
        }
        if (msg.type === "pressed") {
          return this.cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: msg.x,
            y: msg.y,
            button,
            clickCount: 1,
            modifiers: modifiersOf(msg),
          });
        }
        if (msg.type === "released") {
          return this.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: msg.x,
            y: msg.y,
            button,
            clickCount: 1,
            modifiers: modifiersOf(msg),
          });
        }
        return;
      }

      case "wheel":
        return this.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: msg.x,
          y: msg.y,
          deltaX: msg.dx || 0,
          deltaY: msg.dy || 0,
          modifiers: modifiersOf(msg),
        });

      case "insert":
        return this.cdp.send("Input.insertText", { text: msg.text || "" });

      case "key": {
        const code = KEYMAP[msg.key] ?? 0;
        const printable = typeof msg.key === "string" && msg.key.length === 1;
        const common = {
          key: msg.key,
          code: msg.code || "",
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
          modifiers: modifiersOf(msg),
        };
        if (msg.type === "down") {
          await this.cdp.send("Input.dispatchKeyEvent", {
            type: printable && !msg.ctrl && !msg.meta ? "keyDown" : "rawKeyDown",
            text: printable && !msg.ctrl && !msg.meta ? msg.key : undefined,
            unmodifiedText: printable ? msg.key : undefined,
            ...common,
          });
        } else {
          await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
        }
        return;
      }

      default:
        return;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    sessions.delete(this);
    try {
      await this.cdp?.send("Page.stopScreencast");
    } catch {}
    try {
      await this.context?.close();
    } catch {}
  }
}

/* ------------------------------------------------------------------ *
 * http + websocket
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (path === "/") path = "/index.html";

  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let data;
  try {
    data = await readFile(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-cache",
    ...(ACCESS_KEY ? { "x-auth-required": "1" } : {}),
  });
  res.end(data);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/session") {
    socket.destroy();
    return;
  }
  if (ACCESS_KEY && url.searchParams.get("key") !== ACCESS_KEY) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (sessions.size >= MAX_SESSIONS) {
    socket.write("HTTP/1.1 503 Busy\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = new Session(ws);
    sessions.add(session);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      session.handle(msg).catch(() => {});
    });

    ws.on("close", () => session.close());
    ws.on("error", () => session.close());

    session.start().catch((err) => {
      session.send({ t: "error", m: "Could not start the browser: " + String(err.message || err) });
      session.close();
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Cloud browser on http://localhost:${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await Promise.all([...sessions].map((s) => s.close()));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
