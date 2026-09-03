# Deferred work — everything found but not done

> **UPDATE 2026-08-12 (later same day): items A1, A2, A6 and much of B are now DONE.**
> A public-repo credential exposure was found mid-session and closed immediately:
> the JWT signing key, the MariaDB password and the TURN password were all
> readable in the public GitHub repo. All three are rotated, both apps are
> deployed, the backend now binds to loopback, and the exposed dev server is gone.
> Struck-through items below are complete; everything else still stands.


Compiled 2026-08-12. Each entry says **why it wasn't done here**, because that's
usually the useful part. Nothing in this file is blocked on more analysis — it is
blocked on infrastructure, money, or a decision that isn't an engineer's to make.

Context for all of it: the app currently has 12 users and 18 messages on a 4-core
/ 16 GB box sitting at 0.28 load. Almost nothing here is urgent *because of scale*.

---

## A. Blocked on YOUR decision — can be done the moment you say so

### ~~A1. Deploy the work sitting in the tree~~ — **DONE**
Three sessions of fixes are built, verified and **not deployed**: the multi-party
call fixes, the mobile pass, the camera/mic permission rework, and today's
observability + JWT + negotiation hardening.

- Frontend: `npm run build` + rsync. **Watch the `email-logo.png` gotcha** — it
  lives only on the server, not in `public/`, so `rsync --delete` removes it.
- Backend: rebuild + `systemctl restart ibconnect-backend`. **This drops every
  call in progress**, so it needs a quiet window.

### ~~A2. JWT secret~~ — **DONE, rotated**
Deliberate — a silent fallback is how the old hardcoded key survived for months.
`/etc/ibconnect/env` already has a fresh 48-byte secret (added today, backup at
`/etc/ibconnect/env.bak.20260812`), so a deploy will just work.

**But rotating it invalidates every session — everyone signs in again.** At 12
users that's a non-event; it only gets more expensive from here.

### A3. Restart MariaDB to apply the 4 GB buffer pool
`innodb_io_capacity`, `slow_query_log` and `long_query_time` are **already live**.
The buffer pool is **not**: MariaDB 10.11 rejects growing it at runtime (verified —
even +64 MB returns "Truncated incorrect"). It's written to
`/etc/mysql/mariadb.conf.d/99-ibconnect-tuning.cnf` and applies on next restart.

Not done here because restarting MariaDB drops the backend's connection pool.

### A4. Should one user be able to hold two seats?
**This is the one I most want your answer on.** Rooms are keyed by user id, so a
second tab, a second device, or a fast reload **forcibly closes the previous
socket**. In the 2026-08-10 incident, 14 of one participant's 24 disconnects
carried this signature.

I added logging (`[Signaling] EVICT …`) so it's visible, but did **not** change the
behaviour — "can dhruv join from a laptop and a phone at once?" is a product
question, not a bug. Changing it means giving each socket its own identity, which
touches peer identity across the client.

### A5. Turn on the room cap
`MAX_ROOM_SIZE` is built and **defaults to 0 (unlimited)**. Setting it to 8 would
start hard-rejecting people from calls that currently connect, badly. Your call
whether a clear rejection beats a degraded call.

### ~~A6. Close the network~~ — **MOSTLY DONE** (ufw still off, see below)
`ufw` is **inactive**, and a leftover Vite dev server has been serving your
uncompiled source over plain HTTP on `0.0.0.0:3000` — reachable on the public IP,
confirmed. Needs: kill PID, allow only 22/80/443 + 3478/5349 + **coturn's UDP relay
range 20000–60000** (`turnserver.conf`). Get that range wrong and every relayed
call breaks, which is why I didn't do it unattended.

### A7. Commit ~60 files
Last commit is **2026-07-30**. Roughly two weeks of work exists in exactly one
place. Not done because committing without being asked isn't mine to do.

### A8. Switch TURN to HMAC credentials
The endpoint already supports it. **Order matters**: reconfigure coturn with
`use-auth-secret` + `static-auth-secret` *first*, then set
`TURN_STATIC_AUTH_SECRET` in `/etc/ibconnect/env`. Backwards, and every relayed
call fails auth. With the var unset the endpoint serves the existing static
credentials, so deploying changes nothing until you flip it.

### A9. `total-quota=100` in `turnserver.conf`
Never actually hit (verified: 0 quota events in 20 days), but low for a 22-person
mesh call where 114 TURN sessions were observed. Raising it needs a coturn restart.

---

## B. Blocked on infrastructure or spend

### B1. SFU migration — the only route past 6–8 participants
The headline item. Mesh makes every client upload a separately encoded copy to
every peer: at 22 people that's 21 encoders and ~50 Mbps of uplink *per person*.
No amount of tuning moves that.

LiveKit is the natural fit — the tiling stack is already a port of LiveKit Meet's,
so `selectGridLayout` / `usePagination` / `computeTileSize` carry over and
`useAudioLevels` disappears entirely.

**Must not run on this box.** One 35-person room is ~165 Mbps through the SFU;
this host measured ~565 Mbps uplink but shares 4 cores with MariaDB, nginx and
coturn. Dedicated instance or LiveKit Cloud, plus a much wider UDP range.

### B2. A GPU host
Blocks two things at once — treat as one procurement decision:
- **Transcription**: measured ~27× slower than real time on these CPUs.
- **The Virtual Interview feature** (Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit), parked
  at the very start of this session with nothing half-built in the tree.

### B3. Backups are on the same disk as the database
`/var/backups/ibconnect` is on `/dev/vda1`, alongside MariaDB. A lost volume loses
both. The nightly job, retention and a **verified restore** are done (row counts
matched live exactly); shipping them off-host needs a storage target + credentials.

### B4. Storage latency: ~8.4 ms fsync → ~120 durable commits/sec
Network-attached storage, ~100× slower than local NVMe, and
`innodb_flush_log_at_trx_commit=1` means every message insert pays it. Irrelevant
at 18 messages; it is your chat throughput ceiling later.

Fix is a lower-latency volume type from the provider, *or* relaxing the flush
setting to `2` (~10× faster writes, at the cost of losing up to 1s of writes on a
host crash). That's a durability trade-off, so it's yours.

### B5. Attachments live in the database as base64
`messages.file_data` holds base64 data URLs. Base64 inflates ~1.37× against a
16 MB `max_allowed_packet`, which is why the 5 MB client cap can't move much past
~11 MB. Every message query drags file bytes; backups balloon.

**Cheapest to migrate now, at 2.5 MB of data.** Needs an object-storage decision.

### B6. Monitoring and alerting
Nothing installed. Today you find out the backend died when a user says so. Worth
remembering: the "WebSocket server is off" report on 2026-08-10 turned out to be
three SQL bugs, with the socket fine throughout.

### B7. Staging environment and CI
Every verification this session ran against throwaway ports **sharing the
production database**. CI needs a repo host + runner; `tsc --noEmit`, `go build`
and the `_verify_*.mjs` suites are already the hard part.

### B8. Room state out of process
`rooms` is an in-memory map, so two backend instances would each see half the
participants. Deliberately last — with an SFU the signaling backend does very
little, so this is a deployment convenience, not a capacity fix.

### B9. KubeVirt live migration
This is a VM inside Kubernetes. Steal time is 0, but a live migration can pause the
guest, and for real-time media a multi-second pause drops every call. Worth asking
your provider whether migrations are enabled.

---

## C. Structurally unanswerable — don't spend time re-mining

From the 2026-08-10 investigation. These are gaps in what was *recorded*, not in
the analysis:

1. **Client-side ICE state and per-client peer-connection counts for past
   incidents.** Never existed. The relay path logged nothing and the deployed
   client discarded WebRTC errors into empty catches.
2. **Why the three burst-triggering drops happened.** No client telemetry; the
   server only ever saw a closed socket.
3. **Whether SDP divergence actually occurred.** Requires client SDP. Not stored.

**Now fixed going forward** (deployed with A1): room membership is logged
(`Room X joined by …`), renegotiation volume is logged per room per 30s, evictions
are logged, and the client logs every WebRTC failure via `logRTC`.

**Still missing: a client-side error reporting endpoint.** That is the one thing
that would have made the RCA directly answerable rather than inferential. It is
buildable here — a `POST /api/client-events` plus a hook — but it stores user
telemetry, so it needs a retention/privacy decision first.

---

## D. Known and deliberately left alone

- **The 12-tile grid cap.** Now cosmetic: audio is decoupled from tiles, so
  off-page participants are audible. Raising it without an SFU just multiplies the
  encoder count per client.
- **Google Fonts.** `index.html` and `src/index.css` pull Geist, Inter, JetBrains
  Mono and Material Symbols from Google on every page load — four blocking
  third-party requests and a hard dependency on a host you don't control.
  Self-hosting is ~1 hour, purely additive.
- **`SupportView` knowledge-base header clipping** — pre-existing, cosmetic.
- **Double `POST /read`** on thread open — idempotent, two tiny UPDATEs.


---

## E. Closed on 2026-08-12 (recorded for the audit trail)

**The repo is PUBLIC on GitHub** (`DhruvJyotiDas/IB-Connect-ver-2`, `"visibility": "public"`),
and three live credentials were readable in it:

| Credential | Where | Status |
|---|---|---|
| JWT signing key | `origin/main:server/main.go:27` | **Rotated.** Every forged token is now invalid |
| MariaDB password | `origin/main:server/main.go:1190` | **Rotated.** Old one verified revoked |
| TURN password | `origin/main:src/hooks/useWebRTC.ts:6` | **Rotated.** Old one verified rejected by coturn |

All three now come from `/etc/ibconnect/env` (chmod 600, backup `env.bak.20260812`).
The backend refuses to start if any is missing.

Also closed: the Vite dev server that had been serving uncompiled source over plain
HTTP on `0.0.0.0:3000` for 14 days, and the Go backend binding to `0.0.0.0:8080`
(directly reachable on the public IP, bypassing nginx and TLS — now `127.0.0.1:8080`).
Public listeners are now exactly: 22, 80, 443, 3478, 5349.

**Still true and worth knowing:** the old values remain in the public git history
forever. Rotation is what makes them harmless — history rewriting is not required
and is not worth the disruption. But **treat this repo as public when committing**:
never put a live credential in it again.

**Still open from A6:** `ufw` remains inactive. With the two exposures closed the
urgency dropped a lot, but a firewall is still the right belt-and-braces. It needs
care with coturn's UDP relay range (20000-60000) — get it wrong and relayed calls
break silently.
