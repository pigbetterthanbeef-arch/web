const $ = (s) => document.querySelector(s);

const canvas = $("#screen");
const ctx = canvas.getContext("2d", { alpha: false });
const urlBar = $("#url");
const statusEl = $("#status");
const startEl = $("#start");
const connectBtn = $("#connect");
const hintEl = $("#hint");

let ws = null;
let connected = false;
let pending = null; // newest frame waiting to be drawn
let drawing = false;

/* ------------------------------------------------------------------ *
 * connection
 * ------------------------------------------------------------------ */
function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const key = localStorage.getItem("cb_key") || "";
  return `${proto}//${location.host}/session${key ? "?key=" + encodeURIComponent(key) : ""}`;
}

function connect() {
  connectBtn.disabled = true;
  hintEl.textContent = "Starting Chrome…";
  statusEl.textContent = "connecting";

  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    connected = true;
    statusEl.textContent = "ready";
    hintEl.textContent = "Connected.";
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.t) {
      case "ready":
        startEl.classList.add("hidden");
        canvas.focus();
        if (!urlBar.value) urlBar.placeholder = "Search or enter address";
        break;

      case "frame":
        queueFrame(msg.d);
        break;

      case "url":
        if (document.activeElement !== urlBar) urlBar.value = msg.url;
        statusEl.textContent = "ready";
        break;

      case "loading":
        statusEl.textContent = "loading…";
        break;

      case "done":
        statusEl.textContent = "ready";
        break;

      case "error":
        statusEl.textContent = "error";
        hintEl.textContent = msg.m;
        break;

      case "closed":
        statusEl.textContent = "closed";
        break;
    }
  };

  ws.onclose = (ev) => {
    connected = false;
    connectBtn.disabled = false;
    if (ev.code === 1008 || ev.code === 1006) {
      statusEl.textContent = "disconnected";
    }
    startEl.classList.remove("hidden");
    connectBtn.textContent = "Reconnect";
    if (!hintEl.textContent || hintEl.textContent === "Connected.") {
      hintEl.textContent = "Session ended. Start again below.";
    }
  };

  ws.onerror = () => {
    hintEl.textContent = "Could not reach the browser server.";
  };
}

function send(obj) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

/* ------------------------------------------------------------------ *
 * frame rendering
 * ------------------------------------------------------------------ */
function queueFrame(base64) {
  pending = base64;
  if (!drawing) drawNext();
}

async function drawNext() {
  if (!pending) {
    drawing = false;
    return;
  }
  drawing = true;
  const data = pending;
  pending = null;

  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));

    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
  } catch {}

  drawNext();
}

/* ------------------------------------------------------------------ *
 * input
 * ------------------------------------------------------------------ */
function coords(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * canvas.width) / rect.width,
    y: ((e.clientY - rect.top) * canvas.height) / rect.height,
  };
}

canvas.addEventListener("mousemove", (e) => {
  const { x, y } = coords(e);
  send({ t: "mouse", type: "moved", x, y });
});

canvas.addEventListener("mousedown", (e) => {
  const { x, y } = coords(e);
  canvas.focus();
  send({
    t: "mouse",
    type: "pressed",
    x,
    y,
    button: e.button,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  });
});

canvas.addEventListener("mouseup", (e) => {
  const { x, y } = coords(e);
  send({
    t: "mouse",
    type: "released",
    x,
    y,
    button: e.button,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  });
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const { x, y } = coords(e);
    send({ t: "wheel", x, y, dx: e.deltaX, dy: e.deltaY });
  },
  { passive: false },
);

const SEND_KEYS = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete",
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", " ", "Shift", "Control", "Alt", "Meta",
]);

function keyPayload(e, type) {
  return {
    t: "key",
    type,
    key: e.key,
    code: e.code,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!connected) return;
    if (document.activeElement === urlBar) return;

    const printable = e.key.length === 1;
    if (!printable && !SEND_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey) return;

    e.preventDefault();
    send(keyPayload(e, "down"));
  },
  true,
);

window.addEventListener(
  "keyup",
  (e) => {
    if (!connected) return;
    if (document.activeElement === urlBar) return;
    if (e.key.length !== 1 && !SEND_KEYS.has(e.key)) return;
    e.preventDefault();
    send(keyPayload(e, "up"));
  },
  true,
);

canvas.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text");
  if (text) {
    e.preventDefault();
    send({ t: "insert", text });
  }
});

/* ------------------------------------------------------------------ *
 * chrome
 * ------------------------------------------------------------------ */
function normalize(value) {
  const v = (value || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(v) || /^localhost(:\d+)?/.test(v)) {
    return "https://" + v;
  }
  return "https://www.bing.com/search?q=" + encodeURIComponent(v);
}

$("#omni").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalize(urlBar.value);
  if (!url) return;
  urlBar.blur();
  canvas.focus();
  statusEl.textContent = "loading…";
  send({ t: "goto", url });
});

$("#back").addEventListener("click", () => send({ t: "back" }));
$("#fwd").addEventListener("click", () => send({ t: "forward" }));
$("#reload").addEventListener("click", () => send({ t: "reload" }));

urlBar.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    urlBar.blur();
    canvas.focus();
  }
});

connectBtn.addEventListener("click", connect);

// If the host sets ACCESS_KEY, ask once and remember it.
window.addEventListener("load", async () => {
  try {
    const res = await fetch("/index.html", { method: "HEAD" });
    if (res.headers.get("x-auth-required") === "1" && !localStorage.getItem("cb_key")) {
      const entered = prompt("Access key:");
      if (entered) localStorage.setItem("cb_key", entered);
    }
  } catch {}
});
