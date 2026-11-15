# Cloud Browser

A real Chromium running on your server, streamed into a web page as JPEG frames.
Nothing is rewritten, so every site works exactly like it does in Chrome.

- **Everything loads**: Google, YouTube, Instagram, logins, banking, JS apps.
- **Own chrome**: its own tabs-free single page, URL bar, back/forward/reload.
- **Isolated**: each visitor gets their own browser context; closing the tab kills it.

## Run locally

```bash
npm install
npx playwright install chromium     # once
npm start                            # http://localhost:8080
```

Set `PLAYWRIGHT_BROWSERS_PATH` only if your Chromium lives somewhere unusual.

## Deploy with Docker (recommended)

```bash
docker build -t cloud-browser .
docker run -p 8080:8080 -e ACCESS_KEY=pick-a-password cloud-browser
```

On Render: **New → Web Service → Runtime: Docker**, pick the repo, done (no build
or start command needed). On any VPS the two commands above are all you need.

### RAM matters

Chrome is not light: budget **~600 MB per browser session** plus ~150 MB for Node.

| Plan | Suggestion |
|---|---|
| Render Free (512 MB) | ❌ will OOM — Chrome gets killed |
| Render Starter 2 GB (~$7/mo) | ✅ 2 sessions comfortable |
| Oracle Always Free VM (24 GB) | ✅ best value, never sleeps |

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `ACCESS_KEY` | *(empty)* | If set, visitors must enter this key. Set it on a public URL. |
| `MAX_SESSIONS` | `2` | Concurrent browsers. Each one costs ~600 MB. |
| `VIEW_W` / `VIEW_H` | `1280` / `800` | Streamed viewport size |
| `QUALITY` | `62` | JPEG quality; lower = faster, blurrier |

## Honest limits

- **Google search may show a captcha.** Not the app's fault: Google blocks
  datacenter IPs. It's a real Chrome, so the puzzle is solvable, or use Bing.
- **Video plays but audio doesn't.** Audio needs WebRTC; this streams frames only.
- **~15 fps and 60–120 ms lag** depending on distance to the server.
- **CPU-bound.** Each viewer costs a core for JPEG encoding. Not free at scale.
