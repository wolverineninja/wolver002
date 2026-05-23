# wolver002.com

Personal site for **wolver002** — live at https://wolver002.com.

## What's in this repo

```
├── index.html          # Homepage
├── secret.html         # Hidden chat page (Llama 3.3 + Claude BYOK)
├── CNAME               # Custom domain config for GitHub Pages
│
├── api/                # Cloudflare Worker that powers the chat
│   ├── wrangler.toml   # Worker config (binding to Workers AI, route)
│   └── src/worker.js   # Worker source: /chat and /vision endpoints
│
└── extension/          # Chrome extension: "wolver002 secret"
    ├── manifest.json   # Manifest v3 config
    ├── background.js   # Screenshot → AI vision → top-right overlay
    └── icon.png        # Toolbar icon
```

## How the pieces fit

- **Site (static)** — GitHub Pages serves `index.html` and `secret.html`
  at https://wolver002.com.
- **Chat backend** — Cloudflare Worker at https://api.wolver002.com
  - `POST /chat`  → Llama 3.3 70B (default) or Claude (with user's own
    Anthropic API key sent as `x-anthropic-key`)
  - `POST /vision` → LLaVA 1.5 for image input
  - `GET /health` → liveness check
  - Rate-limited (~20 req/min/IP), prompt size capped, CORS scoped to the
    site origin and the Chrome extension.
- **Chrome extension** — Click the toolbar icon → screenshots the current
  tab → posts to `/vision` → shows the AI's answer as a small transparent
  pill in the top-right corner.

## Deploying

### Static site

GitHub Pages auto-deploys from `main`. Just `git push` and Pages rebuilds
in ~30 seconds.

### Worker

```bash
cd api
npx wrangler deploy
```

Requires a Cloudflare account with Workers + Workers AI access. The
`api.wolver002.com` hostname is configured as a Workers Custom Domain
(not in this repo — set up once via Cloudflare's API).

### Extension

`chrome://extensions` → toggle Developer Mode → "Load unpacked" → pick
the `extension/` folder.
