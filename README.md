# IB Connect

Secure messaging, video calling, and calendar web app, live at **https://meet.icebrkr.space**.

## Stack

- **Frontend**: React 19 + TypeScript, Vite 6, Tailwind CSS v4, `lucide-react` icons, `motion` for animation.
- **Backend**: Go (`server/main.go`) — REST API + WebSocket signaling/chat, JWT auth, MariaDB via `go-sql-driver/mysql`.
- **DB**: MariaDB 10.11, local (`ibconnect_app` user, `lolafire_IBConnect` schema).
- **ASR**: separate Python Whisper transcription server (`server/transcription_server.py`), proxied at `/asr`.
- **WebRTC**: mesh topology (one `RTCPeerConnection` per remote peer), TURN server at `meet.icebrkr.space`, screen sharing runs on its own parallel peer connections so it never interrupts the camera feed.

## Run locally

```bash
npm install
npm run dev        # vite on :3000, proxies /api, /ws, /chat-ws to :8080, /asr to :8765
npm run server      # Go backend directly (go run .)
npm run dev:all     # both concurrently
npm run lint        # tsc --noEmit — run before calling frontend work done
```

Production runs independently of local dev: `ibconnect-backend.service` (Go binary + MariaDB) and
`ibconnect-transcription.service` (ASR), both managed via systemd.

## Deploy (frontend)

The live site is static files served by nginx from `/var/www/ibconnect`, not the Vite dev server.

```bash
npm run build
sudo rsync -a --delete dist/ /var/www/ibconnect/
sudo chown -R www-data:www-data /var/www/ibconnect
curl -s https://meet.icebrkr.space/ | grep -o 'index-[^"]*\.js'   # sanity-check the deployed hash
```

No env vars are needed at build time. There is no CI/CD — deploys are manual.

## Deploy (backend)

```bash
cd server && /usr/local/go/bin/go build -o ibconnect-backend . && sudo systemctl restart ibconnect-backend
```

Restarting drops any calls currently in progress, so treat it like a real production deploy.

## More detail

See `CLAUDE.md` for directory structure, theming conventions, the WebRTC/screen-share architecture,
and testing approach — it's the canonical reference kept up to date each work session.
