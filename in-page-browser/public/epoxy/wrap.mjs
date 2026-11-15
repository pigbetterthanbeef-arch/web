// Adapter for the transport <-> Ultraviolet boundary.
//
// Ultraviolet expects `request()` to hand back a response whose headers are a
// real `Headers` object (it calls `.entries()` / `.get()` on them). Epoxy hands
// back an array of [name, value] pairs, which Ultraviolet silently mangles into
// numeric header names — so redirects, content-type and cookies all break.
// Normalise both directions here.
import EpoxyTransport from "/epoxy/index.mjs";

function toPairs(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers;
  if (typeof headers.entries === "function") return [...headers.entries()];
  const out = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) out.push([name, String(v)]);
    else if (value != null) out.push([name, String(value)]);
  }
  return out;
}

function toHeaders(headers) {
  if (!headers) return new Headers();
  if (typeof headers.get === "function" && typeof headers.entries === "function") {
    return headers instanceof Headers ? headers : new Headers(toPairs(headers));
  }
  return new Headers(toPairs(headers));
}

export default class Transport extends EpoxyTransport {
  request(remote, method, body, headers, signal) {
    return super.request(remote, method, body, toPairs(headers), signal);
  }
}
