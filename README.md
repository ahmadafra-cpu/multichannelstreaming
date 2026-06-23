# Multi-Camera Live View — Trax Streaming Web Addin

Watch **multiple live fleet camera feeds at once**. Designed to embed in the Trax web app
via an iframe. Login (database / username / password) → list StreamMax camera devices →
poll their status every 30s → click a unit to open all its camera channels as live **FLV**
tiles (played with `mpegts.js`).

The same code runs two ways:

- **Vercel** — backend as a serverless function, app streams **directly** from the camera host.
- **Long-running host** (Docker / VM / Render / Railway / Fly / Cloud Run) — backend can also
  **proxy** the streams through itself on 443 (firewall-proof).

## Architecture

```
  Browser ─▶ /            static app (public/)
          ─▶ /auth/*      Authenticate on one-service (credentials kept SERVER-SIDE)
          ─▶ /api/*       Device / DeviceStatusInfo / LiveMedia (credentials injected)
          ─▶ stream:      STREAM_MODE=direct  → browser ⇄ streamax-api.zenduit.com:22001
                          STREAM_MODE=proxy   → browser ⇄ /stream (this origin, 443) ⇄ streamax
```

Credentials never reach the browser. The client holds only a **stateless, encrypted session
token** (AES-256-GCM) — so it works across serverless invocations with no server-side store.

### Streaming mode (the one Vercel-specific tradeoff)
- `direct` (auto on Vercel): the browser connects straight to the camera host. Simple and
  serverless-friendly, **but** that host uses a non-standard port (22001) which some firewalled
  corporate/guest networks block.
- `proxy` (default on a long-running host): the stream is relayed through this app on 443, so
  clients only ever use a standard port. **Not possible on Vercel** — serverless functions have a
  max duration and can't hold an indefinite live stream open.

Switching is one env var (`STREAM_MODE`); the CSP and the URLs returned by `/api/livemedia` adapt
automatically. So you can ship on Vercel today and, if a customer network blocks 22001, run a tiny
`proxy`-mode instance on any always-on host and point `STREAM_MODE=proxy` there — no code change.

## Files

| Path | Purpose |
|---|---|
| `public/index.html` | Markup + styles. **No inline script** (strict CSP). |
| `public/app.js` | Client logic — talks only to this backend. |
| `public/vendor/mpegts.js` | Vendored FLV player. |
| `server/app.js` | The Express app (routes, proxy, security) — exported, no `listen`. |
| `server/server.js` | Long-running entrypoint (`app.listen`) for Docker/VM. |
| `api/index.js` | Vercel serverless entrypoint (exports the app). |
| `vercel.json` | Vercel routing (dynamic routes → the function; static served by the platform). |
| `package.json` | Single dependency set (used by both Vercel and Docker). |
| `Dockerfile` / `docker-compose.yml` / `Caddyfile` | Long-running deploy (+ optional auto-HTTPS). |
| `.env.example` | All configuration knobs. |

---

## Deploy to Vercel

1. Push this folder to a Git repo and **Import** it in Vercel (no framework preset — it auto-detects
   the static `public/` dir and the `api/` function).
2. Add **Environment Variables** (Project → Settings → Environment Variables):

   | Var | Value |
   |---|---|
   | `SESSION_SECRET` | **Required.** A long random string. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `CSP_FRAME_ANCESTORS` | Your exact Trax origin, e.g. `'self' https://app.zenduit.com` |

   (Optional: `CAMERA_DEVICE_TYPES`, `API_RATE_MAX`, `LOGIN_RATE_MAX`, `ONE_SERVICE_URL`, …)
3. Deploy. Vercel serves `public/` at `/` and runs the backend at `/auth/*`, `/api/*` via
   `vercel.json`. `STREAM_MODE` auto-selects `direct`.

> `SESSION_SECRET` **must** be set on Vercel. Without it each cold start picks a new random key and
> every user gets logged out constantly.
>
> **Rate limiting on Vercel is best-effort** (per-warm-instance memory). For robust cross-instance
> limiting add Upstash Redis (`@upstash/ratelimit`) or enable Vercel's WAF/Firewall.

### Local Vercel dev (optional)
```bash
npm i -g vercel
vercel dev          # serves public/ + the function locally
```

---

## Deploy to a long-running host (firewall-proof streaming)

Use this if you want streams relayed on 443 (`STREAM_MODE=proxy`).

```bash
cp .env.example .env          # set SESSION_SECRET, CSP_FRAME_ANCESTORS, STREAM_MODE=proxy
docker compose up -d app                       # behind your own HTTPS ingress (port 8080)
# or turnkey HTTPS with a public domain (Caddy + Let's Encrypt):
DOMAIN=cameras.example.com ACME_EMAIL=you@example.com docker compose --profile tls up -d
```

Render / Railway / Fly.io / Cloud Run: deploy the `Dockerfile` and set the same env vars.

### Run locally without Docker
Requires **Node 18+**.
```bash
npm install
SESSION_SECRET=dev STREAM_MODE=proxy PORT=8090 npm start   # http://localhost:8090
```

---

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | random/boot | **Set in prod / on Vercel.** Encrypts the session token + signs stream URLs; must be stable across restarts/instances. |
| `STREAM_MODE` | `direct` on Vercel, else `proxy` | `direct` = browser→camera host; `proxy` = relay on 443 (long-running host only). |
| `CSP_FRAME_ANCESTORS` | `'self' https://*.zenduit.com` | Who may embed the iframe. Lock to your Trax origin. |
| `ONE_SERVICE_URL` | `https://one-service.zenduit.com/api/` | Trax JSON-RPC API. |
| `STREAM_HOST` / `STREAM_PORT` | `streamax-api.zenduit.com` / `22001` | FLV upstream. |
| `CAMERA_DEVICE_TYPES` | `StreamMax` | Comma-separated camera device types to list. |
| `API_RATE_MAX` | `600` | Requests/min/IP on `/api` + `/auth/me`. |
| `LOGIN_RATE_MAX` | `20` | Sign-in attempts / 15 min / (IP + username). |
| `SESSION_TTL_MS` | `28800000` | Session lifetime cap (also bounded by upstream `sessionExpire`). |
| `PORT` / `TRUST_PROXY` | `8080` / `1` | Long-running host only. |

## Security

- **Credentials stay server-side.** Login proxies `Authenticate`; the Trax `sessionId`/password
  never leave the server. The client holds only a stateless **AES-256-GCM encrypted token**.
- **Rate limiting** — per-IP on the API + stricter per-(IP + username) login throttling.
- **Strict CSP + headers** (helmet): `script-src 'self'` (no inline script), `connect-src` limited
  to this origin (plus the camera host only in `direct` mode), `frame-ancestors` locked to Trax,
  HSTS, `nosniff`, `no-referrer`, no `X-Powered-By`.
- **Signed, host-locked stream proxy** (`proxy` mode) — only serves `…/video/*.flv` with a valid
  short-lived HMAC token, only to the configured camera host.
- **Input limits** — JSON bodies capped; device-id / stream paths validated; only the known stream
  host is ever exposed to the client.

## Operational notes

- **`DeviceStatusInfo`** is fetched per-device (an unscoped query 502s upstream); the backend fans
  out with a concurrency pool and the client polls it once every 30s.
- **Proxy-mode bandwidth** flows through the backend (≈16 × 720p feeds per active viewer) — size the
  host accordingly or scale horizontally.

## ⚠️ Security note on the `APIs` file

`APIs` contains a live service-account database/username/password from development. **Rotate those
credentials** and keep them out of any deploy (excluded via `.dockerignore` / `.vercelignore`). In
production the app only needs what the user types into the login form.
