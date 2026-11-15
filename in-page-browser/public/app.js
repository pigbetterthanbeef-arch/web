import { BareMuxConnection } from "/baremux/index.mjs";

/* ------------------------------------------------------------------ *
 * proxied-URL helpers
 * ------------------------------------------------------------------ */
const cfg = () => window.__uv$config;

function proxiedUrl(url) {
  return cfg().prefix + cfg().encodeUrl(url);
}

// Turn an iframe location back into the real URL it points at.
function realUrlFromHref(href) {
  try {
    const raw = href.slice(location.origin.length);
    if (!raw.startsWith(cfg().prefix)) return null;
    const decoded = cfg().decodeUrl(raw.slice(cfg().prefix.length));
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeInput(value) {
  const v = (value || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const hostLike =
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(v) ||
    /^localhost(:\d+)?(\/.*)?$/.test(v);
  if (hostLike) return "https://" + v;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(v);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * elements
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const el = {
  tabs: $("#tabs"),
  frames: $("#frames"),
  back: $("#back"),
  fwd: $("#fwd"),
  reload: $("#reload"),
  omni: $("#omni"),
  url: $("#url"),
  go: $("#go"),
  sitename: $("#sitename"),
  sitenameText: $("#sitename-text"),
  startpage: $("#startpage"),
  spForm: $("#sp-form"),
  spInput: $("#sp-input"),
  progress: $("#progress"),
};

/* ------------------------------------------------------------------ *
 * tabs
 * ------------------------------------------------------------------ */
let tabs = [];
let activeId = null;
let seq = 0;

function activeTab() {
  return tabs.find((t) => t.id === activeId) || null;
}

function createTab(url) {
  const id = ++seq;
  const frame = document.createElement("iframe");
  frame.className = "frame";
  frame.setAttribute("allow", "fullscreen; clipboard-write; clipboard-read");
  el.frames.appendChild(frame);

  const tab = {
    id,
    url: "",
    frame,
    history: [],
    index: -1,
    title: "New tab",
    timer: null,
  };

  frame.addEventListener("load", () => {
    setLoading(false);
    tab.pending = null;
    syncUrl(tab);
  });

  // Watch for navigations that happen *inside* the framed page
  // (link clicks etc). Same origin, so the location is readable.
  tab.timer = setInterval(() => syncUrl(tab), 350);

  tabs.push(tab);
  return tab;
}

function syncUrl(tab) {
  let href;
  try {
    href = tab.frame.contentWindow ? tab.frame.contentWindow.location.href : "";
  } catch {
    return;
  }
  if (!href) return;
  const real = realUrlFromHref(href);
  if (!real) return;

  // While we're loading a URL on purpose, the iframe still reports the old
  // location for a moment. Don't record that as a navigation.
  if (tab.pending) {
    if (real !== tab.pending) {
      // A redirect: fold the entry into the final URL instead of stacking
      // one history step per hop.
      if (Date.now() - (tab.navAt || 0) < 10000) {
        tab.pending = null;
        tab.url = real;
        tab.title = hostOf(real) || "New tab";
        if (tab.history[tab.index] === tab.requested) tab.history[tab.index] = real;
        else if (tab.history[tab.index] !== real) pushHistory(tab, real);
        if (tab.id === activeId) renderChrome();
        renderTabs();
      }
      return;
    }
    tab.pending = null;
  }

  if (real === tab.url) {
    if (tab.history[tab.index] !== real) pushHistory(tab, real);
    return;
  }

  tab.url = real;
  tab.title = hostOf(real) || "New tab";
  pushHistory(tab, real);
  if (tab.id === activeId) renderChrome();
  renderTabs();
}

function pushHistory(tab, url) {
  tab.history = tab.history.slice(0, tab.index + 1);
  tab.history.push(url);
  tab.index = tab.history.length - 1;
}

function go(tab, url, { push = true } = {}) {
  if (!url) return;
  tab.url = url;
  tab.pending = url;
  tab.requested = url;
  tab.navAt = Date.now();
  tab.title = hostOf(url) || "New tab";
  if (push && tab.history[tab.index] !== url) pushHistory(tab, url);

  el.startpage.classList.add("hidden");
  tabs.forEach((t) => t.frame.classList.toggle("active", t.id === tab.id));

  setLoading(true);
  tab.frame.src = proxiedUrl(url);

  renderTabs();
  if (tab.id === activeId) renderChrome();
}

function selectTab(id) {
  activeId = id;
  const tab = activeTab();
  if (!tab) return;
  tabs.forEach((t) => t.frame.classList.toggle("active", t.id === id));
  const hasPage = Boolean(tab.url);
  el.startpage.classList.toggle("hidden", hasPage);
  renderTabs();
  renderChrome();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [tab] = tabs.splice(i, 1);
  clearInterval(tab.timer);
  tab.frame.remove();
  if (!tabs.length) {
    newTab();
    return;
  }
  if (activeId === id) selectTab(tabs[Math.max(0, i - 1)].id);
}

function newTab(url) {
  const tab = createTab();
  selectTab(tab.id);
  if (url) go(tab, url);
  else {
    el.startpage.classList.remove("hidden");
    el.spInput.focus();
    el.url.value = "";
  }
  return tab;
}

/* ------------------------------------------------------------------ *
 * chrome rendering
 * ------------------------------------------------------------------ */
function renderTabs() {
  el.tabs.textContent = "";
  for (const tab of tabs) {
    const node = document.createElement("div");
    node.className = "tab" + (tab.id === activeId ? " active" : "");
    node.addEventListener("mousedown", (e) => {
      if (e.button === 0) selectTab(tab.id);
    });
    node.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeTab(tab.id);
    });

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "New tab";

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "✕";
    close.title = "Close tab";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    node.append(title, close);
    el.tabs.appendChild(node);
  }
}

function renderChrome() {
  const tab = activeTab();
  if (!tab) return;

  if (document.activeElement !== el.url) el.url.value = tab.url || "";

  const host = hostOf(tab.url);
  el.sitename.classList.toggle("hidden", !host);
  el.sitenameText.textContent = host;

  el.back.disabled = tab.index <= 0;
  el.fwd.disabled = tab.index >= tab.history.length - 1;
}

function setLoading(loading) {
  el.progress.classList.toggle("loading", loading);
  el.progress.classList.toggle("done", !loading);
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */
function reloadActive() {
  const tab = activeTab();
  if (!tab || !tab.url) return;
  setLoading(true);
  try {
    tab.frame.contentWindow.location.reload();
  } catch {
    tab.frame.src = proxiedUrl(tab.url);
  }
}

function goBack() {
  const tab = activeTab();
  if (!tab || tab.index <= 0) return;
  tab.index -= 1;
  go(tab, tab.history[tab.index], { push: false });
}

function goForward() {
  const tab = activeTab();
  if (!tab || tab.index >= tab.history.length - 1) return;
  tab.index += 1;
  go(tab, tab.history[tab.index], { push: false });
}

function navigateFromInput(value) {
  const url = normalizeInput(value);
  if (!url) return;
  const tab = activeTab() || newTab();
  el.url.blur();
  go(tab, url);
}

el.back.addEventListener("click", goBack);
el.fwd.addEventListener("click", goForward);
el.reload.addEventListener("click", reloadActive);

el.omni.addEventListener("submit", (e) => {
  e.preventDefault();
  navigateFromInput(el.url.value);
});

el.url.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    el.url.value = activeTab()?.url || "";
    el.url.blur();
  }
});

el.spForm.addEventListener("submit", (e) => {
  e.preventDefault();
  navigateFromInput(el.spInput.value);
  el.spInput.value = "";
});

for (const btn of document.querySelectorAll(".sp-links button")) {
  btn.addEventListener("click", () => navigateFromInput(btn.dataset.url));
}

document.querySelector("#newtab").addEventListener("click", () => newTab());

// Keyboard shortcuts operate on the *inner* page, never the outer tab.
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "F5" || (mod && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      reloadActive();
      return;
    }
    if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      el.url.focus();
      el.url.select();
      return;
    }
    if (mod && e.key.toLowerCase() === "t") {
      e.preventDefault();
      newTab();
      return;
    }
    if (mod && e.key.toLowerCase() === "w") {
      e.preventDefault();
      closeTab(activeId);
      return;
    }
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      goBack();
      return;
    }
    if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      goForward();
    }
  },
  true,
);

/* ------------------------------------------------------------------ *
 * boot: transport -> service worker -> first tab
 * ------------------------------------------------------------------ */
async function boot() {
  const wispUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/wisp/";

  const connection = new BareMuxConnection("/baremux/worker.js");
  await connection.setTransport("/epoxy/wrap.mjs", [{ wisp: wispUrl }]);

  // Scope must cover the app page too: the proxy worker talks to an open
  // window to get its network transport, and it can only see clients
  // inside its own scope.
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  newTab();
}

boot().catch((err) => {
  console.error(err);
  const note = document.querySelector(".sp-note");
  if (note) {
    note.textContent =
      "Browser engine failed to start: " + (err?.message || String(err));
    note.style.color = "#ff8b8b";
  }
});
