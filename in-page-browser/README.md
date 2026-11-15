# Browser inside a website

A working browser chauffeured by your own server. Pages load in an iframe through a
proxy (Ultraviolet + Wisp + Epoxy), so:

- **Reload only reloads the inner page.** The outer tab never reloads, never re-renders.
- **The site you visit never shows up on your page.** Your tab keeps its own title,
  favicon and URL. The only place the site name appears is the address bar you own.
- Real tabs, back/forward, address bar with search fallback, Ctrl+R / Ctrl+L / Ctrl+T.

## Run

```bash
npm install
npm start
# open http://localhost:8080
```

Needs Node 18+. No build step — the proxy files are already in `public/`.

## Deploy

This is a **server**, not a static site, so Netlify/GitHub Pages won't work.
Push the folder to Render / Railway / Fly.io / a VPS and run `npm start`
(`PORT` is respected). Any Node host with a public HTTPS domain works.

### One gotcha

A service worker is required. Browsers only allow it on `localhost` or HTTPS, so
on a plain `http://` production URL the browser won't start.

## How it's wired

| Piece | Job |
|---|---|
| `server.mjs` | Serves `public/`, upgrades `/wisp/` to the Wisp tunnel |
| `public/sw.js` | Service worker: rewrites URLs, headers, redirects |
| `public/app.js` | The browser chrome: tabs, history, reload isolation |
| `public/uv/*` | Ultraviolet proxy engine |
| `public/epoxy/*` | Transport (Wisp client) |
| `public/baremux/*` | Worker bridge between page and proxy |

`public/epoxy/wrap.mjs` and the top of `public/sw.js` contain the fixes that make
Ultraviolet 3.2 behave with this transport version (header shape, redirects,
relative asset URLs). Delete them and redirects/asset loading break.

## Known limits

- Heavily JS-driven sites (Google account pages, streaming players, bot-checked
  sites) may refuse to load through a proxy. Wikipedia, Hacker News, docs sites,
  news sites, most blogs work.
- Fonts loaded from CSS sometimes 404 (cosmetic).
- Please don't point this at a network you don't control to get around its rules.
