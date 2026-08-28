# Mesh vs. LiveKit load-test harness

Built for the Stage 1 plan approved in this migration's review — one harness,
parameterized by which backend it's pointed at, used identically for the old
mesh path (`main`) and the new LiveKit path (`livekit-migration`).

## What it measures, and how

- **Per-client upload/download** — real `RTCPeerConnection.getStats()`
  `bytesSent`/`bytesReceived`, summed across every PC the page has open.
  Mode-agnostic by construction: `browser-hooks.mjs` intercepts the global
  `window.RTCPeerConnection` constructor, so it sees mesh's many-PCs-per-client
  model and LiveKit's ~2-PCs-per-client (publisher+subscriber) model
  identically, with zero app-specific code and zero production changes.
- **Per-client CPU** — `/proc/<pid>/stat` `utime+stime`, summed across the
  *entire* Chromium process tree for that client (`proc.mjs`), not a JS-side
  timer — encode/decode is often off the renderer's main thread, which a
  `performance.now()` self-report would miss. Validated against a known
  ~1.0-core synthetic workload before being trusted (see session log) —
  measured exactly 1.00 cores.
- **Server CPU/memory** — same `/proc` mechanism against the LiveKit and Go
  backend PIDs, passed in via `--livekit-pid`/`--server-pid`.
- **Server network** — *derived* from the client-side byte counters (sum of
  all clients' upload = server's real inbound, and vice versa), not a
  separate OS-level read — more precise than approximating from
  `/proc/net/dev` on a shared loopback interface, since it counts the same
  protocol-level bytes a real deployment would produce.
- **Watchability, not just connectivity** — per inbound video stream,
  `framesDropped`/`freezeCount`/`totalFreezesDuration` (all standard
  `inbound-rtp` fields). A rung is `DEGRADED/UNUSABLE` if either >15% of all
  PCs fail to reach `connectionState === 'connected'`, or >15% of video
  streams are individually degraded (>10% of the window frozen, >1 freeze
  per 10s, or >10% of expected frames dropped).
- **Host saturation** — system-wide CPU fraction (`/proc/stat`), flagged once
  it exceeds ~85% of the host's cores.

## Explicit caveats (read before interpreting any report)

1. **Software encode only.** This host has no GPU device (`/dev/dri` doesn't
   exist — confirmed, not assumed), and every browser launches with
   `--disable-gpu`. Both conditions run under the identical constraint, so
   the mesh-vs-LiveKit *comparison* is unaffected — but absolute per-client
   CPU numbers here will run higher than a real hardware-accelerated device
   would show.
2. **Single 4-core host, no artificial CPU partitioning.** Simulated clients
   and the server(s) under test genuinely compete for the same cores, by
   deliberate choice — that's how the real co-located deployment actually
   runs, and Stage 5 specifically wants that real ceiling, not a
   cordoned-off approximation of it. Consequence: **per-client absolute
   numbers, especially at N≥12, are not clean isolated-hardware numbers** —
   caption them as such. `hostSaturation.saturated: true` in a report marks
   exactly where this stops being trustworthy.
3. **This harness's own polling adds real load.** Sampling `getStats()`
   across every client every few seconds costs real (if small) CPU on both
   the client pages and the orchestrator process — present identically in
   both conditions, so it doesn't bias the *comparison*, but it means "0 load
   from measurement" is not a claim being made anywhere in these numbers.
4. **Real UI, not a protocol-level shortcut.** Every client goes through the
   actual app's real Meetings UI (click "Start New Meeting" / enter a code
   and click "Join") — this measures the real app's real code paths, not a
   raw-WebSocket approximation of it.

## Usage

```
IBCONNECT_JWT_SECRET=<same secret the target backend was started with> \
  node run.mjs --mode=mesh|livekit --n=<count> --base=http://127.0.0.1:<vite-port> \
  [--server-pid=<go-backend-pid>] [--livekit-pid=<livekit-pid, livekit mode only>] \
  [--window-ms=30000] [--sample-interval-ms=3000] [--out=results/mesh-n8.json]
```

One invocation = one rung (one participant count, one condition). The
Stage 3/4 ladder is a loop over `--n` values, once per condition, with the
appropriate backend checked out and running underneath.

## Files

| File | Role |
|---|---|
| `proc.mjs` | `/proc`-based CPU/memory accounting, self-tested against a synthetic 1-core workload |
| `browser-hooks.mjs` | In-page instrumentation (fake continuous-motion media, PC interception, stats collection) — injected, never modifies the app |
| `client.mjs` | One simulated participant's full lifecycle (launch, sign in, join/create, sample, close) |
| `run.mjs` | Orchestrates one rung: launch N, settle, measure, verdict, report |

## Not yet run

Per Stage 2's scope, this has been built and its individual pieces verified
(Playwright API signatures checked against the installed version's type
definitions; `/proc` accounting validated against a real synthetic
workload; every file syntax-checked) — but no end-to-end rung against the
actual mesh or LiveKit app has been executed yet. That's Stage 3.
