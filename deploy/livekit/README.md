# Standing up the production LiveKit server

Same host as the backend, no new subdomain — LiveKit's signaling WS is
reverse-proxied through the existing `meet.icebrkr.space` nginx vhost on
`/livekit/`, reusing its TLS cert. `livekit-server` itself (`v1.13.6`) is
already installed at `/usr/local/bin/livekit-server`.

This is split into two stages on purpose. **Stage 1 is safe to run now** — it
starts LiveKit alongside the still-running mesh backend and touches nothing
currently serving live calls. **Stage 2 is the actual application cutover**
(rebuilds and restarts `ibconnect-backend`, redeploys the frontend bundle) —
run it only after confirming Stage 1's LiveKit instance is healthy, and only
after checking there's no live call in progress (`journalctl -u
ibconnect-backend`), since that restart drops whatever mesh calls are active
at the moment it runs.

## Firewall

No new ports needed. LiveKit's own media path (unlike `/livekit/`'s
signaling WS, which nginx proxies over 443) isn't proxyable through nginx —
clients reach it directly — but this host's actual firewall already has
20000-60000 open both tcp/udp (confirmed 2026-08-28: `22/tcp`, `80/tcp`,
`443/tcp+udp`, `3478/tcp+udp`, `5349/tcp+udp`, `20000-60000/tcp+udp`), the
same range coturn's relay allocator already uses. LiveKit's `rtc.tcp_port`/
`rtc.udp_port` (20001/20000 in the template) sit inside that range on
purpose — see the template's own comment for why this doesn't collide with
coturn.

## Stage 1 — bring up LiveKit (does not touch the live mesh backend)

```
# 1. Add MAX_ROOM_SIZE + a real LiveKit key/secret to the production env file.
#    Values are generated inline and never printed anywhere.
sudo bash -c '
grep -q "^MAX_ROOM_SIZE=" /etc/ibconnect/env || echo "MAX_ROOM_SIZE=16" >> /etc/ibconnect/env
grep -q "^LIVEKIT_API_KEY=" /etc/ibconnect/env || echo "LIVEKIT_API_KEY=APIibconnect$(openssl rand -hex 6)" >> /etc/ibconnect/env
grep -q "^LIVEKIT_API_SECRET=" /etc/ibconnect/env || echo "LIVEKIT_API_SECRET=$(openssl rand -hex 32)" >> /etc/ibconnect/env
grep -q "^LIVEKIT_URL=" /etc/ibconnect/env || echo "LIVEKIT_URL=wss://meet.icebrkr.space/livekit" >> /etc/ibconnect/env
'

# 2. Render /etc/ibconnect/livekit.yaml from the checked-in template + the
#    env file above (the real key/secret only ever land in this 600 root-
#    owned file, never in the repo).
sudo bash -c '
set -a; source /etc/ibconnect/env; set +a
envsubst < /home/ubuntu/IB-Connect-ver-2/deploy/livekit/livekit.yaml.template > /etc/ibconnect/livekit.yaml
chmod 600 /etc/ibconnect/livekit.yaml
chown root:root /etc/ibconnect/livekit.yaml
'

# 3. Install the systemd unit and start it.
sudo cp /home/ubuntu/IB-Connect-ver-2/deploy/livekit/livekit.service /etc/systemd/system/livekit.service
sudo systemctl daemon-reload
sudo systemctl enable --now livekit

# 4. Confirm it's actually up before wiring nginx to it.
sudo systemctl status livekit --no-pager
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7880/   # expect a response, not connection-refused
```

```
# 5. Add the nginx location block (deploy/livekit/nginx-livekit.conf.snippet)
#    inside the existing 443 server{} block in
#    /etc/nginx/sites-available/ibconnect, next to the /ws and /asr blocks —
#    doing this by hand rather than scripting an edit to a file this
#    sensitive. Then:
sudo nginx -t && sudo systemctl reload nginx
```

At this point LiveKit is live and reachable at `wss://meet.icebrkr.space/livekit`,
but **nothing is using it yet** — `ibconnect-backend` is still the old build
without `/api/livekit/token`, and the served frontend still has no
`livekit-client` in its bundle (both confirmed by direct probe, 2026-08-28).
Mesh calls are completely unaffected by everything above.

Sanity-check from a browser before Stage 2: LiveKit's `/livekit/rtc/validate`
endpoint should respond over the real domain (`wss://meet.icebrkr.space/livekit`
resolving instead of connection-refused) — full end-to-end only happens once
Stage 2 ships a frontend that actually calls it, but this confirms the proxy
path and the UDP media port are both reachable before flipping the app over.

## Stage 2 — the actual cutover (drops live calls — check first)

Not included in this file as a copy-paste block deliberately — this is the
step that changes what real users get, and it should be run with a fresh
check of `journalctl -u ibconnect-backend` for anyone currently on a call
right before it executes, not queued up alongside Stage 1. Ask when Stage 1
is confirmed healthy.
