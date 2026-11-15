/*global UVServiceWorker,__uv$config*/
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts(__uv$config.sw || "/uv/uv.sw.js");

const uv = new UVServiceWorker();
const PREFIX = __uv$config.prefix;

// Last page actually loaded through the proxy, used to resolve sub-resources
// whose referrer got stripped (fonts and images pulled in by CSS).
let lastReal = null;

// ---------------------------------------------------------------- headers
// The transport hands headers over as a list of name/value pairs, which
// Ultraviolet ends up storing under numeric keys ("0" => "date, Wed ...").
// Rebuild a real Headers object out of that.
const DROP = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "content-disposition",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "frame-options",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "origin-isolation",
  "feature-policy",
  "permissions-policy",
  "strict-transport-security",
  "x-content-type-options",
]);

function normalizeHeaders(headers) {
  const out = new Headers();
  let changed = false;
  for (const [key, value] of headers) {
    if (DROP.has(String(key).toLowerCase())) {
      changed = true;
      continue;
    }
    if (/^\d+$/.test(key)) {
      const comma = value.indexOf(",");
      if (comma > 0) {
        changed = true;
        const name = value.slice(0, comma).trim();
        if (DROP.has(name.toLowerCase())) continue;
        out.append(name, value.slice(comma + 1).trim());
        continue;
      }
    }
    out.append(key, value);
  }
  return changed ? out : null;
}

// ---------------------------------------------------------------- urls
function realUrl(href) {
  try {
    const u = new URL(href);
    if (!u.pathname.startsWith(PREFIX)) return null;
    const decoded = __uv$config.decodeUrl(u.pathname.slice(PREFIX.length));
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function proxied(realHref) {
  return location.origin + PREFIX + __uv$config.encodeUrl(realHref);
}

// Pages contain relative URLs ("assets/logo.png", "../img/x.svg"). Browser
// resolves those against /service/<encoded>, which Ultraviolet cannot decode.
// Resolve them against the real page URL instead and re-request through it.
function resolveRelative(request) {
  const u = new URL(request.url);
  if (!u.pathname.startsWith(PREFIX)) return null;

  const rest = u.pathname.slice(PREFIX.length) + u.search;
  let decoded = null;
  try {
    decoded = __uv$config.decodeUrl(rest);
  } catch {}
  if (decoded && /^https?:\/\//i.test(decoded)) return null; // already absolute

  const base = realUrl(request.referrer);
  if (!base) return null;

  try {
    return new URL(rest, base).href;
  } catch {
    return null;
  }
}

async function refetch(request, target) {
  const init = {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    try {
      init.body = await request.arrayBuffer();
    } catch {}
  }
  return uv.fetch({ request: new Request(proxied(target), init) });
}

// ---------------------------------------------------------------- handler
async function handle(event) {
  const request = event.request;

  let response;
  const target = resolveRelative(request);
  if (target) {
    response = await refetch(request, target).catch(() => null);
  }
  if (!response) response = await uv.fetch(event);

  const fixed = normalizeHeaders(response.headers);
  const headers = fixed || response.headers;

  // Ultraviolet passes redirects through with the raw target URL; Chromium
  // won't follow that from a service worker, so point it at the proxied URL.
  if (response.status >= 300 && response.status < 400) {
    let to = headers.get("location");
    if (to) {
      try {
        to = new URL(to, request.url).href;
      } catch {
        to = null;
      }
      if (to) {
        if (!to.startsWith(location.origin + PREFIX)) {
          if (/^https?:\/\//i.test(to)) to = proxied(to);
        }
        try {
          response.body?.cancel();
        } catch {}
        try {
          return Response.redirect(to, response.status);
        } catch {}
      }
    }
  }

  if (!fixed) return response;

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Root-relative asset URLs ("/static/app.css") escape the proxy prefix and hit
// this server directly. If such a request comes from a proxied page, resolve it
// against that page's real URL and proxy it instead.
function escapedUrl(request) {
  let u;
  try {
    u = new URL(request.url);
  } catch {
    return null;
  }
  if (u.origin !== location.origin) return null;
  if (u.pathname.startsWith(PREFIX)) return null;
  if (u.pathname === "/" || u.pathname === "/index.html") return null;

  const base = realUrl(request.referrer) || lastReal;
  if (!base) return null;

  try {
    return new URL(u.pathname + u.search, base).href;
  } catch {
    return null;
  }
}

self.addEventListener("fetch", async (event) => {
  const request = event.request;

  if (uv.route(event)) {
    if (request.destination === "document") {
      const r = realUrl(request.url);
      if (r) lastReal = r;
    }
    event.respondWith(handle(event));
    return;
  }

  const target = escapedUrl(request);
  if (!target) return;

  event.respondWith(
    (async () => {
      try {
        const response = await refetch(request, target);
        return response;
      } catch {
        return new Response("", { status: 404 });
      }
    })(),
  );
});
