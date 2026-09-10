# IB Connect

Secure messaging, video calling, and calendar web app, live at **https://meet.icebrkr.space**.

## Stack

- **Frontend**: React 19 + TypeScript, Vite 6, Tailwind CSS v4, `lucide-react` icons, `motion` for animation.
- **Backend**: Go (`server/main.go`) — REST API + WebSocket signaling/chat, JWT auth, MariaDB via `go-sql-driver/mysql`.
- **DB**: MariaDB 10.11, local (`ibconnect_app` user, `lolafire_IBConnect` schema).
- **AI**: Go adapters for an external Qwen service, English Nemotron ASR, and the virtual-interview GPU service. The browser never receives GPU credentials.
- **WebRTC**: LiveKit SFU with simulcast, adaptive stream, dynacast, screen sharing, reconnection, and optional coturn relay.

## Run the complete stack with Docker

The Compose stack contains the frontend/Nginx gateway, main API, IB Account,
separate application and account MariaDB instances, Redis, and LiveKit.

```bash
cp deploy/docker/env.example .env
# Replace every replace-with-* value before exposing the stack.
docker compose up --build -d --wait
# Visit http://localhost:8088
```

The example uses plain HTTP for local development and therefore enables
non-Secure IB Account cookies. For an HTTPS deployment set
`PUBLIC_ORIGIN=https://your-domain`, `LIVEKIT_PUBLIC_URL=wss://your-domain/livekit`,
and `IB_ACCOUNT_INSECURE_COOKIES=0`. Put a TLS load balancer/reverse proxy in
front of loopback port 8088 (the example binds there by default; see
`deploy/docker/host-nginx-compose.conf`). LiveKit also publishes TCP 7881 and UDP 50000–50100; those
ports must reach the media node directly.

If `https://your-domain` shows `PR_CONNECT_RESET_ERROR`, check the layers in
this order: DNS A/AAAA records point to the host; ports 80 and 443 are open in
the cloud/security-group firewall; host Nginx has a valid certificate and is
running; host Nginx proxies to `127.0.0.1:8088`; then `docker compose ps` shows
the frontend healthy. Compose does not bind HTTPS or obtain certificates by
itself. A direct local check is `curl -I http://127.0.0.1:8088/` on the server.

Useful commands:

```bash
docker compose ps
docker compose logs -f backend account livekit
docker compose down                 # keeps database/key volumes
docker compose down --volumes       # destructive local reset
```

AI, ASR, interview, email, and coturn remain external integrations. Configure
their URLs and workload credentials in `.env`; core messaging and meetings
start without the optional AI services. Production secrets should come from a
secret manager or container-orchestrator secret facility rather than a file.

## Run locally

```bash
npm install
npm run dev        # vite on :3000, proxies /api, /ws, /chat-ws and /asr to :8080
npm run server      # Go backend directly (go run .)
npm run dev:all     # both concurrently
npm run lint        # tsc --noEmit — run before calling frontend work done
```

The legacy production deployment uses systemd units. Compose is the reproducible
full-stack path for new environments.

## Deploy (frontend)

The live site is static files served by nginx from `/var/www/ibconnect`, not the Vite dev server.

```bash
npm run build
sudo rsync -a --delete dist/ /var/www/ibconnect/
sudo chown -R www-data:www-data /var/www/ibconnect
curl -s https://meet.icebrkr.space/ | grep -o 'index-[^"]*\.js'   # sanity-check the deployed hash
```

No env vars are needed at build time for a same-origin deployment — the frontend derives
every URL from `window.location` at runtime (see `src/config.ts`). Override via `.env`
(`VITE_*`, template in `.env.example`) only when the frontend is served from a different
origin than the backend. There is no CI/CD — deploys are manual.

## Deploy (backend)

```bash
cd server && /usr/local/go/bin/go build -o ibconnect-backend . && sudo systemctl restart ibconnect-backend
```

Restarting drops any calls currently in progress, so treat it like a real production deploy.

## Configuration

Nothing host-specific is hard-coded. Moving this project to another VM means setting
environment variables, not editing source:

- **Backend** — `server/config.go` + scattered `os.Getenv` reads, all loaded by systemd
  from `/etc/ibconnect/env`. Template with every variable and its default:
  **`deploy/ibconnect.env.example`**. Required (no default): `IBCONNECT_JWT_SECRET`,
  `IBCONNECT_DB_PASSWORD`.
- **Frontend** — `src/config.ts` is the single source of truth for URLs / OIDC client
  config. Defaults are runtime-derived from the served origin; override at build time
  with `VITE_*` vars (template: **`.env.example`**).

## Layout

```
src/            React frontend (src/config.ts = runtime config)
server/         Go backend (single package; config.go = deployment config)
ib-account/     IB Account — self-contained Go OIDC identity provider
                  (login/OTP/forgot-password/account mgmt) behind "Continue
                  with IB". Own systemd service on :8090, own schema. See
                  ib-account/README.md.
gpu/            GPU-VM contracts + mock servers (ASR, interview)
deploy/         nginx snippet, LiveKit unit/config, backend env template
docs/           DEFERRED.md, INTERVIEW_PLAN.md, session notes
tests/          ad-hoc Playwright/tsx verification scripts (see CLAUDE.md)
public/         static assets served as-is
```

## More detail

See `CLAUDE.md` for directory structure, theming conventions, the WebRTC/screen-share architecture,
and testing approach — it's the canonical reference kept up to date each work session.
