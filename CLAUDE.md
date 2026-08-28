# IB Connect

Secure messaging / video calling / calendar web app. React + Go, deployed at **https://meet.icebrkr.space**.

## Stack

- **Frontend**: React 19 + TypeScript, Vite 6, Tailwind CSS v4 (`@tailwindcss/vite`, arbitrary-value utility classes like `bg-[#1c1b1b]` rather than a theme config — see Theming below), `lucide-react` icons, `motion` for animation.
- **Backend**: Go (`server/main.go`) — REST API + WebSocket signaling/chat, JWT auth, MariaDB via `go-sql-driver/mysql`.
- **DB**: MariaDB 10.11, local (`127.0.0.1:3306`, db `lolafire_IBConnect`, user `ibconnect_app`). Migrated off a remote hostpoint.ch DB during this session's work — `main.go`'s `migrate()` uses `CREATE TABLE IF NOT EXISTS`, so it will **not** retroactively alter columns on tables that already exist (e.g. an `avatar TEXT`→`LONGTEXT` widening won't apply to a pre-existing table without a manual `ALTER TABLE`).
- **Live captions (ASR)**: multilingual, per-speaker, real-time — Whisper (language ID) → IndicConformer or `nvidia/nemotron-3.5-asr-streaming-0.6b` (ASR, routed by detected language) → NLLB (translation), all on a **separate GPU VM** the main box only reaches through `server/asr_gpu.go` + `server/transcription_relay.go` (`/asr`). See "Live captions (ASR)" below. Supersedes the old single-language `transcription_server.py` prototype (retired 2026-08-18 — it was CPU-only and ~27x slower than real time, see git history if you need the postmortem).
- **WebRTC**: TURN server at `meet.icebrkr.space` (user `webrtc` — see `src/hooks/useWebRTC.ts`).
- **Identity**: auth is OIDC-only against **IB Account** (`/home/ubuntu/ib-account`, served at `/auth/`), consumed by `handleOIDCCallback` in `server/main.go`. That repo has its own CLAUDE.md covering the login/OTP/email side; anything about sign-in, verification codes or transactional mail belongs there, not here.

## Directory structure

```
src/
  components/
    layout/        Sidebar.tsx, TopBar.tsx
    views/         DashboardView, ChatsView, CallsView, CalendarView, DebriefView, SecurityView, SupportView
    meeting/        ActiveMeetingView, IncomingCallModal, ScheduleMeetingModal, GuestNameModal
    settings/       SettingsModal (Profile / Preferences / Security / Account tabs)
    chat/           UserProfileModal
    auth/           LoginPage
    CommandPalette.tsx   (⌘K / Ctrl+K global nav+actions)
  context/          AuthContext, ChatContext, MeetingContext
  hooks/            useWebRTC.ts, useTheme.ts, useGridLayout.ts + usePagination.ts + useElementSize.ts
                     + useAudioLevels.ts (call-tiling stack, ported from LiveKit Meet — see WebRTC
                     section below), useSpeechTranscription.ts
  lib/              api.ts (REST client), signalingSocket.ts, calendarLocal.ts, callsLocal.ts,
                     intelligence.ts (chat message → meeting/deadline/action extraction, regex-based),
                     preferences.ts (per-user localStorage: status, notification prefs),
                     gridLayout.ts (selectGridLayout, container-size-aware tile grid picker)
server/
  main.go           Go backend (single file). Also has several *.bak files and old binaries
                     (ibconnect-server, ibconnect-signaling, signaling-server, main) — cruft, not
                     used by the systemd service; only server/ibconnect-backend is deployed.
```

Note: a few stray `.backup` files exist in `src/` (`App.tsx.backup`, `Sidebar.tsx.backup`,
`ChatsView.tsx.backup.*`) from earlier ad-hoc edits — not part of the build, safe to ignore/delete
but left alone since nobody asked to clean them up.

## Local dev

```
npm run dev        # vite on :3000, proxies /api, /ws, /chat-ws to :8080, /asr to :8765
npm run server      # Go backend directly (go run .)
npm run dev:all     # both concurrently
npm run lint        # tsc --noEmit — always run before calling frontend work done
```

Production services run independently of any local dev server:
- `ibconnect-backend.service` — the Go binary, already running against local MariaDB.
- `ibconnect-transcription.service` — ASR. **Stopped and `disable`d 2026-08-08** (feature is off; it
  was holding 7.7GB resident for nothing). `sudo systemctl enable --now ibconnect-transcription` to
  bring it back alongside flipping `VITE_ENABLE_TRANSCRIPTION=true`.
Both managed via systemd; `sudo systemctl status/restart ibconnect-backend`.

## Deployment (frontend)

The live site is **static files**, not the Vite dev server. nginx (`/etc/nginx/sites-enabled/ibconnect`)
serves `/var/www/ibconnect` (root) and reverse-proxies `/api`, `/health`, `/ws`, `/chat-ws`, `/asr` — all
of them, `/asr` included since 2026-08-27 — to the Go backend on :8080. To ship a frontend change:

```bash
npm run build                                            # writes dist/
sudo rsync -a --delete dist/ /var/www/ibconnect/          # /var/www/ibconnect is www-data-owned
sudo chown -R www-data:www-data /var/www/ibconnect
curl -s https://meet.icebrkr.space/ | grep -o 'index-[^"]*\.js'   # sanity-check the deployed hash
```

No env vars are needed at build time. There is no CI/CD — deploys are manual via the steps above.
Backend changes need (from repo root): `cd server && /usr/local/go/bin/go build -o ibconnect-backend . && sudo systemctl restart ibconnect-backend`
— `go` isn't on PATH by default in this environment, use the full binary path. Restarting drops any
calls currently in progress, so treat it like a real production deploy, not a free action.

**Always verify after deploying**: curl `/` and `/health` for 200s, and ideally run a headless
Playwright pass against the real domain checking for zero console errors (see Testing below) —
don't just trust that `rsync` succeeded.

## Theming

`src/hooks/useTheme.ts` stores a `dark | light | system` preference in `localStorage` and stamps
`data-theme` on `<html>`. Because the whole app is styled with literal hex Tailwind arbitrary values
(`bg-[#1c1b1b]`, `text-[#e5e2e1]`, etc.) instead of semantic tokens, light mode can't use Tailwind's
`dark:` variant — instead `src/index.css` has a large block of
`:root[data-theme="light"] .bg-\[\#hex\] { ... !important }` overrides at the bottom of the file that
directly target the compiled utility classes. **When adding new hardcoded colors to a component, check
whether they need a corresponding light-mode override in that block** — this was the source of a real
bug (status badges like "FLAGGED" using `text-[#ffb4ab]`/`text-[#4dffb1]`/`text-[#70ffba]`/`text-[#ffd60a]`
directly with no light-mode mapping, rendering near-invisible on white backgrounds; fixed by adding
those four mappings). The live-call screen (`ActiveMeetingView`, Meet/Zoom-style `#202124`/`#8ab4f8`
palette) is intentionally excluded from the retrofit and stays dark in both themes.

## WebRTC / video calls

Mesh topology, one `RTCPeerConnection` per remote peer (`src/hooks/useWebRTC.ts`), signaled over the
`/ws` WebSocket (`src/lib/signalingSocket.ts` client, `handleSignaling` in `server/main.go`). The
backend is a dumb relay keyed by room: `offer`/`answer`/`ice_candidate` are forwarded verbatim to
`payload.to`'s socket with the sender's `id` **and `name`** attached (`from`/`from_name`); it does not
parse SDP. Any new WS message type must be added to the `switch` in `handleSignaling` or it's
silently dropped.

**Session lifecycle — the three things that keep a room's membership honest.** These are load-bearing;
breaking any one of them reproduces the "we're in the same room code but can't see each other" class of
bug (see the 2026-08-03 log entries):
1. **The client must re-enter its room after a signaling reconnect.** `SignalingSocket` reconnects on
   its own 3s after an unintentional close, but the server has no memory of who that socket was — it
   arrives as a fresh client in *no room*. `MeetingContext` keeps `activeRoomRef` and re-sends
   `join_room` via the constructor's `onReconnect` callback (host falls back to `create_room` if the
   room was reaped), then resets peers and re-offers everyone. Never construct the socket without that
   callback: media already flowing makes an orphaned tab look perfectly fine locally while everyone
   else has been told it left.
2. **`peer_joined` must discard any `RTCPeerConnection` already held for that id.** Someone
   (re-)entering means the socket you were connected to is gone; reusing the PC strands both sides on a
   frozen tile. Don't rely on `peer_left` arriving first — it doesn't on a reconnect.
3. **`/ws` pings** (`sigPongWait`/`sigPingPeriod`, mirroring `handleChatWS`). A call can sit idle on
   the wire for minutes because media is peer-to-peer, so a socket that dies without a close frame
   would otherwise block in `ReadMessage` forever, leaving a ghost in the room that never empties.

Remote `<video>` playback goes through `playWhenAllowed` in `ActiveMeetingView`, not a bare `play()`.
A reloaded page holds no user activation and remote streams carry audio, so autoplay can reject with
`NotAllowedError` — silently, leaving a black tile with live media arriving underneath. It retries on
the next `pointerdown`/`keydown`.

**Screen sharing runs on entirely separate `RTCPeerConnection`s from the camera call** — a peer sharing
their screen opens one additional PC per remote peer (`outScreenPcsRef`/`inScreenPcsRef` in
`useWebRTC.ts`), signaled via the same `offer`/`answer`/`ice_candidate` messages tagged with an extra
`kind: "screen"` field (backend `SignalPayload.Kind`, passed through opaquely) plus a
`screen_share_state` broadcast so peers know when to expect/tear down a share. This was a deliberate
design choice over the simpler "replace the camera video track with the screen track" approach: the
camera's RTCRtpSender is never touched by screen-share start/stop, so the presenter's camera keeps
streaming to everyone (including their own preview) for the entire duration of a share — swapping the
track was the original design and caused two bugs: the presenter's own camera preview would go blank
(it got replaced by the screen), and remote peers would stop receiving the presenter's camera entirely.
`ActiveMeetingView` renders active screens in a separate "spotlight" area with `object-contain` (never
`object-cover`) so shared content (slides, code, text) never gets cropped — camera tiles stay
`object-cover` in a small strip below the spotlight, unaffected by whether anyone is sharing.

Known TS/JSX quirk in this project (no `@types/react` installed — React 19 ships its own bundled
types, resolved via `moduleResolution: "bundler"`): passing `key` directly to a custom function
component in a `.map()` fails type-checking (`Property 'key' does not exist...`) even though it's
valid JSX at runtime. Every other list in the codebase works around this by keying a wrapping `<div>`
instead of the component itself — follow that convention rather than trying to fix the types.

### Video tiling / grid layout

`ActiveMeetingView`'s main grid (the `else` branch when nobody is screen-sharing) is a deliberate port
of LiveKit Meet's own call-tiling stack (`@livekit/components-react`'s `<GridLayout>`), fetched from
`livekit/components-js` upstream for reference during the port — not a from-scratch design:

- `src/lib/gridLayout.ts` (`selectGridLayout`) — picks the smallest grid (rows x cols) that fits the
  tile count for the container's *actual measured pixel size and orientation* (landscape vs portrait),
  not just a `tileCount` breakpoint table. `src/hooks/useElementSize.ts` (ResizeObserver) +
  `src/hooks/useGridLayout.ts` wire it to the grid `<div ref>` in `ActiveMeetingView`.
- `src/hooks/usePagination.ts` — **required**, not optional, alongside `selectGridLayout`: on a small/
  narrow container the picked layout's `maxTiles` can be *less* than the real tile count (e.g. a phone
  can't fit a 2x2 grid so it steps down to a 2-tile layout even for a 4-person call) — this is true of
  upstream LiveKit too, confirmed by reading their `GridLayout.tsx`, which pairs `selectGridLayout` with
  its own `usePagination` for exactly this reason. Without it, extra tiles silently have no grid cell to
  render into. `ActiveMeetingView` slices `tiles` through `usePagination(gridLayout.maxTiles, tiles)` and
  shows prev/next arrows + a dot indicator whenever `totalPageCount > 1`.
- `src/hooks/useAudioLevels.ts` — client-side active-speaker detection (Web Audio API RMS analysis per
  peer's own `MediaStream`, 600ms hold to avoid flicker between words). Necessary because mesh WebRTC
  has no SFU to compute `isSpeaking` server-side the way LiveKit's real backend does — feeds the blue
  ring highlight on whoever's tile is currently talking.
- The right-side panel (Chat/People/Transcript, `rightOpen` state) **defaults closed** on all viewports,
  matching Meet's own default of a full-width stage on join with panels opt-in via the toolbar. It used
  to default *open* on any screen >768px wide, which was the actual root cause of a "tiling looks bad
  with multiple people" complaint — a spacious 1400px desktop window would still render 2 tiles stacked
  vertically because the ever-open People panel had squeezed the real grid container down to a narrow,
  near-square shape. If reintroducing an auto-open panel (e.g. auto-showing People when someone joins),
  remeasure the grid at typical desktop widths first — it's very easy to silently reintroduce this.

## Responsive / mobile

The app is used on phones as a first-class case (share a meeting link, join from a phone), so every
view has to survive 320px. Conventions worth following:

- **A two-pane view must collapse below `lg`.** `ChatsView` is the reference: `mobilePanel` state,
  panel bodies extracted into `render*()` functions, a `lg:hidden` branch showing one at a time and a
  `hidden lg:flex` branch with the side-by-side split. `CallsView` now does the same. A fixed-width
  `<aside>` (`w-80`/`w-72`) next to a `flex-1` `<main>` with no breakpoint is the exact shape of the bug
  that made Calls unusable on a phone — the aside eats the viewport and the main pane gets pushed off.
- The sidebar is an off-canvas drawer below `md` (`-translate-x-full md:translate-x-0`, hamburger at
  `.md:hidden.fixed.top-3.left-3`); the app shell offsets content by `md:pl-[76px]` to match the rail.
- Hover tooltips (`RailTooltip`, `hidden md:block`) don't exist on touch, so anything whose *only*
  label is a tooltip is unlabelled on mobile — give it an `aria-label` too.
- The in-call side panel (Chat/People/Transcript) deliberately takes the full screen on mobile and
  hides the video, Meet-style; that's not a layout defect.

`_verify_mobile_layout.mjs` (view sweep) and `_verify_mobile_deep.mjs` (overlays, in-call) audit this —
see Testing below. `_verify_mobile_deep.mjs`'s chat-thread step needs the signed-in test account to
already have a conversation, otherwise it times out on an empty list and skips; `uitest1` has a DM with
`uitest2` on production for this.

## Chat / threads

One model covers both DMs and groups: `threads` (`type` = `dm` | `group`) +
`thread_members` (many-to-many, per-member `last_read_at`) + `messages`, all in
`migrate()` in `server/main.go`. `POST /api/threads` takes either
`{type:'dm', otherUserId}` or `{type:'group', name, memberIds}`; DM thread ids are
the deterministic `dm_<lowId>_<highId>` so the same pair can't create two threads.
New members are notified over the chat WebSocket with `thread_created`, so a group
appears in their list without a refresh.

**Group chat is fully built and deployed** — backend (`handleThreads`, the
`"group"` branch), `api.createGroup`, `ChatContext.createGroup`, and a
`NewGroupModal` in `ChatsView.tsx` opened by the `<Users />` button in the Messages
header. Verified present in the live bundle. Before building anything group-related,
check whether it already exists here; it mostly does.

What it lacks is **discoverability, not function**: both header buttons (new DM,
new group) are unlabelled 28x28 icon glyphs with no text, no `title` and no
`aria-label`, so there's nothing distinguishing them without clicking. On touch
there's no hover state at all. Users reasonably conclude the feature doesn't exist.
Fixing that is a labelling change, not a feature.

Still missing from groups proper: no add/remove member after creation, no rename,
no leave-group, no admin concept — `thread_members` supports all of it, there's
just no endpoint or UI.

## Live captions (ASR)

**Status: LIVE in production as of 2026-08-27.** The old single-
language `transcription_server.py` prototype (Whisper-Hindi2Hinglish, CPU-only,
measured ~27x slower than real time on 2026-08-04 — see git history for that
postmortem if it's ever relevant again) is retired. It never worked live and
never could have on that hardware; this replaces it rather than fixing it.

**Why there was no SFU to "tap"**: IB Connect is mesh WebRTC (`server/main.go`
is signalling-only, no `pion`/`mediasoup`/`livekit`) — audio is peer-to-peer,
encrypted, and never touches any server. So captions are captured at the
source instead: each participant's own browser streams **only its own mic**
(never a peer's decoded remote audio) to the relay. This is also what fixes a
real scaling bug the old prototype's design had if it had ever run at
usable speed: it opened one pipeline per OTHER participant too, so an
N-person room did O(N²) GPU work for O(N) speakers. One stream per active
speaker, independent of listener count, is O(N).

**Pipeline**: mic (Int16 PCM, 16kHz, mono) → Go backend `/asr`
(`server/transcription_relay.go`, `handleASRRelay`) → GPU VM
(`server/asr_gpu.go`, contract in `gpu/ASR_CONTRACT.md`) → Silero VAD segments
speech → Whisper detects the segment's language → routed to IndicConformer
(Indic languages) or `nvidia/nemotron-3.5-asr-streaming-0.6b` (everything
else) → partial hypotheses while speech continues, a final on end-of-segment
→ the Go backend broadcasts the final to the whole room
(`Room.broadcastAll`, `server/main.go`) → for finals only, translates into
whichever languages the room's viewers currently have selected
(`activeCaptionLangs`, one NLLB call per distinct language actually
requested, not per viewer) → `Room.broadcastAll` again with the
`translations` map attached. Every viewer sees the original speaker's speech
in their **own independently chosen** caption language (`caption_lang`
signalling message, `SigClient.captionLang`) — partials are always shown
untranslated (translating those would be wasted GPU work on text that's
about to be superseded).

**Follows the Interview feature's GPU-VM convention** (`gpu/CONTRACT.md`,
`server/interview_gpu.go`): the Go backend is the only thing that ever talks
to the GPU VM (`ASR_GPU_URL`/`ASR_GPU_TOKEN`/`ASR_GPU_TIMEOUT` in
`/etc/ibconnect/env`, never the repo — it's public), the browser never
reaches it directly, and a standard mock (`gpu/mock_asr_server.py`, FastAPI —
unlike the interview mock this couldn't stay stdlib-only, `/v1/stream` is a
WebSocket) lets the entire feature be built and Playwright-tested with zero
GPU hardware. `gpu/asr_server.py` is the real thing, written against each
model's documented API but **not run or verified anywhere in this
environment** — no GPU, no model weights available here. Sections marked
"NEEDS GPU-SIDE VALIDATION" in that file are exactly that: correct by
documentation, unverified in practice. `INDIC_CONFORMER_MODEL_ID` is an
explicit placeholder env var — AI4Bharat publishes several IndicConformer
checkpoints and none was specified, so it's left configurable rather than
guessed.

**Status the frontend actually shows**: `not_configured` ("captions aren't
set up yet" — `ASR_GPU_URL` unset, never touches the network or opens a mic),
`loading` (`/healthz` still warming up four models), `unreachable`
(temporary, the relay retries with backoff before surfacing this). The
caption toggle itself is always visible when the browser has mic + Web Audio
(`isLiveCaptionsSupported`, `src/lib/liveCaptions.ts`) — unlike the old
feature it is not hidden behind a build flag; `TRANSCRIPTION_ENABLED` /
`src/lib/features.ts` / `VITE_ENABLE_TRANSCRIPTION` no longer exist.

**UI surfaces, unified 2026-08-27**: an on-screen movie-subtitle-style
caption bar (`src/components/meeting/CaptionBar.tsx`, toggled from the
toolbar — the same click starts/stops this participant's own mic capture;
plain centered dark bars above the control bar, no chrome of its own) and a
**Live Captions** tab in the right sidebar, next to Chat/People (renamed
from a mobile-only "Transcript" tab — there used to *also* be a separate,
always-open desktop-only left sidebar duplicating this same UI at `lg+`
widths; removed, since keeping two parallel implementations of one settings
surface in sync is worse than one that works at every breakpoint). The tab
holds the transcript log, an on/off toggle (mirrors the toolbar one), the
caption-language `<select>` (`CAPTION_LANGUAGES`, `src/lib/captions.ts` — a
curated static subset for now, since there's nothing to source a real list
from until `/healthz` `supported_languages` is wired in), a caption **size**
picker (`CaptionSize`, `src/lib/captions.ts` — small/medium/large, persisted
to `localStorage` the same way `devicePrefs.ts` persists device choices,
purely a personal display preference so it doesn't need to sync between
peers), and the Key Points block (ported over from the removed desktop
sidebar, previously not available on the mobile tab at all). Room code /
copy-link controls, previously duplicated inside that desktop sidebar too,
now live solely in the floating badge over the stage, unconditionally.

**Verified**: `_verify_live_captions.mjs` (7/7, run twice for flakiness) —
against a local throwaway Go backend (`ASR_GPU_URL` pointed at
`gpu/mock_asr_server.py`) plus a second throwaway backend with `ASR_GPU_URL`
unset. Confirms: a speaker sees their own caption via the same broadcast
path as everyone else (no special-casing), a second participant receives it
too (cross-participant delivery — the O(N) claim), two viewers with
different caption-language selections see genuinely different text for the
same utterance (per-viewer translation, checked both directions — the
translated viewer sees the tag, the untranslated one doesn't), and `/asr`
never reports anything but `not_configured` when the GPU VM env var is
unset — checked at the raw WS-protocol level via Node's native `WebSocket`,
deliberately bypassing the browser so this isolates the Go-side contract
from any frontend timing. Full existing regression battery re-run against
the same local stack and stayed clean (`_verify_meeting_fixes` 20/20,
`_verify_call_upgrades` 38/38, `_verify_identity_and_camera` 16/16,
`_verify_multiparty_audio` 12/12, `_verify_eviction_fix` 8/8,
`_verify_guest_reconnect` 6/6, `_verify_screenshare_mobile` 7/7,
`_verify_join_video_wording` 7/7, `_verify_asymmetric_video_recovery`
12/12, `_verify_stall_detector` 14/14, `_verify_reconnect_rejoin` clean) —
confirms captions cannot break the actual call even when badly misconfigured,
since `/asr` never touches the WebRTC audio/video path at all.

Two things found and fixed along the way, not part of the feature itself:
- `_verify_call_upgrades.mjs` indexed `<select>` elements globally
  (`page.locator('select').nth(2)`) assuming camera/mic/speaker were the only
  three on the page. The captions sidebar's own language `<select>` (which
  now renders unconditionally at desktop widths, unlike the old dormant
  transcript sidebar) shifted those indices by one and failed the suite
  against no real regression. Fixed by scoping to the settings panel's
  container (`.z-30 select`) instead of the whole page.
- `gpu/mock_asr_server.py` needs the `websockets` package installed for
  uvicorn to actually upgrade `/v1/stream` (`pip install fastapi uvicorn
  websockets`, not just the first two) — without it uvicorn 404s every
  WebSocket connection attempt with only a log warning, no error the client
  side sees, which produced a convincing false pass on the first suite run
  (page text matched for an unrelated reason — the roster, not a caption —
  while the WS connection had been silently failing the entire time). Caught
  by checking the mock server's own log, not by trusting a green suite.

**Update, 2026-08-21 — a real GPU VM exists now (`ib-bom-dev-gpu0`), reconciled
with its own independently-authored contract.** See the same-day work-log
entry below for the full story; summary: the GPU VM's own Claude Code
instance had no access to this repo and wrote its own `CONTRACT.md` from the
feature description alone, which differs from `gpu/ASR_CONTRACT.md` in real
ways (a `ready` handshake ack before audio, `language` not `lang`, a
non-fatal `error` event type, `source_language`/`target_languages` field
names). `gpu/ASR_CONTRACT.md`, `server/asr_gpu.go`,
`server/transcription_relay.go`, and `gpu/mock_asr_server.py` were all
updated to match the GPU VM's actual contract, and `_verify_live_captions.mjs`
re-run clean (7/7) against the updated mock. `ASR_GPU_TOKEN` is now in
`/etc/ibconnect/env`.

**Update, 2026-08-27 — connected and verified live end-to-end. See the
same-day work-log entry below for the full story.** `ASR_GPU_URL`,
`ASR_GPU_TOKEN`, and `ASR_GPU_PIN` (SPKI SHA-256 cert pin — the GPU VM's TLS
cert is self-signed, no CA to chain to, so `server/asr_gpu.go` pins the exact
public key instead of trusting any cert from that IP) are all set in
`/etc/ibconnect/env`. Nginx's `/asr` location's `proxy_pass` is now
`http://127.0.0.1:8080` (was still pointing at the retired `:8765` Python
service until today — this was the last thing actually blocking the feature
even after the GPU link itself came up; found by testing, not by inspection).
`ibconnect-transcription.service` (the retired Python prototype) has not yet
been formally disabled/removed — it's not running and nothing points at it
anymore, so this is cleanup, not a blocker.

**Still open**: Indic-language routing (IndicConformer) has not been verified
against real speech — only against synthetic TTS audio, which wasn't
intelligible enough for a confident answer either way. Worth watching the
first real non-English call closely.

## Testing approach

No unit/e2e test suite exists. Verification is done ad hoc with Playwright smoke scripts (not checked
in as a permanent suite, but `_smoke_test.mjs` + `_signup.json` in the repo root are reusable local
scratch scripts): log in via seeded JWT + user in `localStorage`, navigate the main views, assert zero
`console.error`/`pageerror`/`requestfailed`, and screenshot key screens in both themes. Always run
`npx tsc --noEmit` too. Test against `http://localhost:3000` for dev-server checks and
`https://meet.icebrkr.space` to confirm a deploy actually took effect.

**Testing calls/WebRTC specifically**: `getUserMedia`/`getDisplayMedia` don't work out of the box in
this headless sandbox even with `--use-fake-device-for-media-stream` (throws `NotSupportedError`,
likely no audio backend in the container) — instead override them yourself via
`page.addInitScript(...)` with a `canvas.captureStream()` (+ a silent `AudioContext` oscillator track
for audio) before navigating. Use two separate Playwright browser **contexts** (not just tabs — they
need independent `localStorage`/auth). **There is no `/api/auth/signup` or `/api/auth/login` REST
endpoint** — auth is OIDC-only (`handleOIDCCallback` in `server/main.go`, the "Continue with IB" flow) —
so don't waste time trying to hit one. Instead mint JWTs directly for pre-existing seeded dev accounts
(`uitest1`/`uitest2`/`uitest3`, see `_verify_tiling.mjs`/`_verify_tiling_pagination.mjs` in repo root for
the exact HS256-signing trick against `jwtKey` in `main.go`) and seed `localStorage`
(`ibconnect_jwt`, `ibconnect_me`) directly instead of driving a real login form. A 3rd/4th throwaway
account, if needed, can be inserted straight into the `users` table via `mysql` (schema in `migrate()`)
rather than through the app — there's no signup path to automate. Have one context start a meeting and
read the room code from the DOM, have the others join via the in-app "Join a Meeting" code input on the
Meetings/`DebriefView` page. An unauthenticated context **can** now join by deep link: `/{code}` with
no session renders `PreJoinScreen` ("Ready to join?" + a name field + "Join now"), not `LoginPage` —
this section used to say otherwise, which stopped being true when the guest lobby landed. Feed
each fake camera a distinct solid color and sample pixels off a `<video>` via an offscreen canvas
(`drawImage` + `getImageData`) on the other side to verify tracks actually arrive and decode, and check
`video.currentTime` advances over a wait to prove a stream isn't just present but actively still
playing (not frozen). A tile can also be present, streaming *and* stuck: check `video.paused`, since a
rejected autoplay leaves exactly that state (see `playWhenAllowed` under WebRTC).

**Reusable verification scripts** (repo root, all take a `BASE` env var so the same script runs against
`http://127.0.0.1:3100` or `https://meet.icebrkr.space`):

| script | covers |
|---|---|
| `_verify_meeting_fixes.mjs` | 20 checks: reload-rejoin, ghost tiles, guest-link join, tile geometry at 3 viewports, pin/focus, overlap |
| `_verify_reconnect_rejoin.mjs` | signaling-socket drop → re-entry, host reload with a guest present, media liveness before/after a tap |
| `_verify_mobile_layout.mjs` | every view on iPhone 12 + Galaxy S9+: page h-scroll, cut-off elements, small tap targets |
| `_verify_mobile_deep.mjs` | the states the sweep can't reach by `aria-label`: Calls' two mobile panels, Settings modal, in-call + side panel |
| `_verify_tiling.mjs` / `_verify_tiling_pagination.mjs` | grid layout and pagination with 2–3 real peers |
| `_verify_call_upgrades.mjs` | 38 checks: speaker routing (`setSinkId`), device persistence + `devicechange`, silent-mic detection, reactions + raise-hand across two browsers, keyboard shortcuts incl. push-to-talk, `getStats()` polling, connection test, and the server-side reaction allow-list over raw sockets |
| `_verify_call_upgrades_mobile.mjs` | the split control bar at 390px/360px: nothing off-screen, tap targets ≥36px, every secondary action reachable via the More sheet, reaction sent from a phone arriving on desktop |
| `_verify_speaker_promotion.mjs` | 15 checks, three real browsers: speaker-ranked tile order, self never paged off, no churn during silence, promotion following whoever talks, audio unaffected by paging |
| `_verify_grid_layout.ts` | **`npx tsx`, not node** — property checks on `selectGridLayout`/`computeTileSize`: per-container ceilings against MEASURED sizes, monotonicity, container-fit, orientation, 16:9, no overflow |
| `_verify_tile_order.ts` | **`npx tsx`** — 27 checks on `orderTiles`: ranking, visual stability, promotion, the anti-flicker hold, degenerate inputs |
| `_verify_identity_and_camera.mjs` | 16 checks: host identity as joiners see it (starts with `ibconnect_me` ABSENT on purpose), own raised hand on own tile, and camera-off showing an avatar instead of a frozen frame both mid-call and for someone who joined with it off |
| `_verify_stall_detector.ts` | **`npx tsx`** — 14 checks on `StallTracker` (src/lib/stallDetector.ts): steady playback never trips it, exact threshold boundary, cooldown, sub-frame jitter isn't mistaken for progress, currentTime going backwards doesn't crash or false-trigger |
| `_verify_asymmetric_video_recovery.mjs` | 12 checks, three real browsers (one sender, two independent viewers): reproduces the literal reported bug (same sender's video fine on one viewer's screen, frozen on another's, same room, same instant) by freezing one viewer's decoded playback only, then confirms `useStalledVideoRecovery` repairs *only* that one connection (renegotiates specifically with the stalled peer) while the healthy viewer's link is never touched |
| `_verify_join_video_wording.mjs` | 7 checks: a healthy camera-on join never shows "Camera off" (from both an existing peer's and a new joiner's perspective), a camera-off join still settles to "Camera off" after the grace period rather than "Connecting…" forever. Its fake-camera stub is the reference pattern for passing data into `addInitScript` correctly — see the file header for the closure gotcha it replaced |
| `_verify_eviction_fix.mjs` | 8 checks, two connections as the same user id in the same room (the two-tabs/two-devices scenario): the eviction close carries code 4001 not 1006, the evicted side makes zero reconnect attempts, the "connected elsewhere" notice is shown, the surviving connection is unaffected |
| `_verify_guest_reconnect.mjs` | 6 checks: kills a guest's signalling socket without a page reload (a phone locking its screen), asserts the guest is never wrongly told their session expired, and the host recovers the guest's LIVE video rather than a stuck/gone tile |
| `_verify_screenshare_mobile.mjs` | 7 checks: simulates a browser without `getDisplayMedia` (the iOS Safari case) by deleting it from `MediaDevices.prototype`, confirms "Share screen" is absent from the DOM entirely (not just hidden) including inside the mobile "More" sheet (opened via its real accessible name, `"More options"`), and confirms a normal desktop-class browser still offers it both inline (desktop width) and through the mobile sheet (narrowed to phone width) |
| `_verify_live_captions.mjs` | 7 checks, two participants + a local throwaway Go backend pointed at `gpu/mock_asr_server.py`: a speaker sees their own caption via the same room-broadcast path as everyone else, a second participant receives it too (the O(N) cross-participant claim), two viewers with different caption-language selections see genuinely different (translated vs. original) text for the same utterance, and `/asr` reports only `not_configured` — never opens a mic — when `ASR_GPU_URL` is unset, checked at the raw WS-protocol level via Node's native `WebSocket` |

**Simulating a dead socket** (for the reconnect path): wrap `window.WebSocket` in an `addInitScript` to
collect instances on `window.__sockets`, then `.close()` the one whose `url` contains `/ws`. That
reproduces a phone locking its screen far more reliably than trying to manipulate the network.

**Writing a layout probe? Filter the false positives first**, or real defects drown in noise. Skip
(a) `pointer-events: none` decorations — `.accent-glow` is deliberately 200%x200% inside an
`overflow-hidden` parent and will flag as "wider than screen" on every page that uses it; (b) anything
inside an ancestor that already scrolls horizontally (`overflow-x: auto` with `scrollWidth >
clientWidth`) — the Security audit-log table lives in one and is reachable by swiping; (c) subtrees
under an off-canvas transform, i.e. the closed sidebar drawer at `translateX(-100%)`. Also note
`scrollHeight > clientHeight` on an `overflow-hidden` box does *not* imply clipped text — an oversized
decorative child triggers it.

## Recent work log

**2026-08-28, same migration — merged to `main`, LiveKit actually standing
in production now (Stage 1 only — mesh calls untouched, Stage 2 cutover not
yet run):**
- `livekit-migration` merged into `main` (fast-forward, `08e4951`). This
  repo IS `ibconnect-backend.service`'s `WorkingDirectory`, and
  `server/ibconnect-backend` is a tracked binary — merging replaced it on
  disk immediately. **Real, ongoing risk from this point on**: the running
  process is unaffected (already in memory, unchanged), but if it crashed
  and auto-restarted (`Restart=on-failure`) before Stage 2 ships a matching
  frontend, it would come up as the new binary with no mesh signaling
  handlers at all, while the still-served old frontend only speaks mesh —
  a real outage, not a graceful degradation. Not resolved by anything below;
  resolved only by finishing Stage 2 or explicitly reverting `main`.
- **Port plan changed from the original draft**: the actual firewall on this
  host already has `20000-60000` open both tcp/udp (for coturn's relay
  range) plus the usual `22/80/443/3478/5349` — told directly rather than
  guessed. LiveKit's `rtc.tcp_port`/`udp_port` moved to `20001`/`20000`,
  inside that already-open range, needing **zero new firewall change** —
  `deploy/livekit/livekit.yaml.template` and its README updated accordingly
  (see the template's own comment for why this doesn't collide with
  coturn's dynamic allocator).
- **Real gap caught during setup, not assumed away**: `livekit.service` runs
  `User=ubuntu`, but `EnvironmentFile=` and `--config <path>` are read by
  two different privilege levels — systemd/PID1 (root) reads
  `EnvironmentFile=` before dropping to the target user, but the
  `livekit-server` process itself, running as `ubuntu`, has to read its own
  `--config` file directly. A `root:root 600` `/etc/ibconnect/livekit.yaml`
  (matching `/etc/ibconnect/env`'s convention) failed with "permission
  denied" for exactly this reason — fixed by chowning it to `ubuntu:ubuntu`,
  keeping `600` (still only readable by the one user that needs it, just the
  right one).
- **LiveKit's own startup log flagged a real production gap**: "UDP receive
  buffer is too small for a production set-up" (`212992`, suggested
  `5000000`) — fixed persistently via `/etc/sysctl.d/60-livekit.conf`
  (`net.core.rmem_max`/`wmem_max=5000000`), confirmed gone on the next
  restart, not just applied and assumed to have worked.
- **Verified end-to-end for real, not just "service is active"**: LiveKit's
  own STUN self-check found its external IP as `163.128.34.19` — cross-
  checked against DNS (`meet.icebrkr.space` resolves there) and the host's
  actual bound interface (matches) before trusting it, since nginx's
  `server_name` directive separately lists a second, stale IP
  (`163.128.34.27`) that could have looked like a mismatch but isn't one.
  `https://meet.icebrkr.space/livekit/` returns LiveKit's own `OK` body —
  confirmed genuinely different from the SPA's `index.html` fallback (an
  earlier check of this same URL, before the nginx block existed, had
  returned a misleading 200 from the catch-all route — caught and not
  repeated here).
- **Checked for live calls before touching anything call-adjacent**: no
  `Room ... created/joined` log line in the prior 2 hours, one idle chat-ws
  connection (a tab left open, not a call) — safe window, confirmed rather
  than assumed.
- Stage 2 (rebuild + restart `ibconnect-backend`, redeploy the frontend
  bundle) deliberately NOT run in this pass — see the standing risk noted
  above for why this shouldn't sit unresolved too long.

**2026-08-28, same migration — asked to close every remaining gap: the /ws
divergence fix, a TURN/ICE fallback for LiveKit, cross-browser coverage, and
production LiveKit server infra prepared (not yet stood up), all still not
merged, not deployed:**
- **The `/ws`-vs-LiveKit divergence (previously logged as accepted backlog,
  not part of this migration) is now fixed** — deliberately NOT via the
  LiveKit-disconnect-webhook/reconciliation approach originally sketched for
  it. That direction turned out to be solving the wrong side of the bug: the
  measured divergence is `/ws`'s roster lagging BEHIND live reality (someone
  still fully on the call, briefly unrecognised), not `/ws` being stale about
  someone who genuinely left — a LiveKit-driven eviction only ever helps the
  opposite case, and risks a new false eviction if wired to fire on every
  transient LiveKit hiccup. The actual fix: `server/main.go`'s deferred `/ws`
  cleanup no longer calls `leaveRoom()` inline on a bare socket close; it
  schedules it after `wsLeaveGraceInterval` (3s, chosen with margin over the
  measured ~1s self-heal) via `time.AfterFunc`. `enterRoom()` already
  overwrites `room.clients[client.id]` the instant a reconnect lands, and
  `leaveRoom()` already only vacates "if the room still points at *this*
  connection" — so a delayed `leaveRoom` for someone who already reconnected
  finds someone else's entry in its place and correctly no-ops, no new
  bookkeeping needed to "cancel" it. A genuine, never-healed departure still
  gets cleaned up, just after the same short window.
  `_verify_livekit_ws_divergence.mjs` (which originally existed to MEASURE
  the bug) was rewritten to assert the fix instead: a token/`/asr` request
  for the dropped identity now succeeds inside the grace window (no more
  spurious 403), AND — a new check, not in the original — a genuine,
  never-reconnected departure (whole browser context closed, no reconnect
  possible) is still eventually refused once the window passes, proving the
  grace period delays eviction rather than disabling it. **9/9 passing.**
- **LiveKit now gets a TURN/ICE fallback**, reusing the exact same coturn
  credentials `connectionTest.ts` already fetches independently for the
  pre-join diagnostic — not a new relay, not a new secret. `api.ts` gained
  `getTurnCredentials()` (`GET /api/turn-credentials`, already existed
  server-side); `useWebRTC.ts`'s `connect()` fetches it and passes it to
  `room.connect()` as `rtcConfig.iceServers`, best-effort — a failed fetch
  logs a warning and connects without the fallback rather than blocking the
  call. This closes a real, previously-undisclosed gap: without it, a
  participant behind a symmetric NAT or a UDP-blocking firewall had no path
  to the SFU at all, the same restrictive-network case coturn already
  existed for under mesh.
- **Cross-browser coverage — genuinely new, previously only Chromium had ever
  been tested.** New `_verify_livekit_crossbrowser.mjs` runs the same
  real-two-way-video bar the rest of this migration's tests use, across all
  three Playwright engines with each one's own correct fake-media/autoplay
  setup (Chromium's CLI flags, Firefox's `firefoxUserPrefs`, WebKit's own
  requirements) — not one config force-fit across all three.
  **Chromium: PASS. Firefox: PASS**, both with real, verified two-way LiveKit
  video — Firefox had never once been exercised against this migration
  before now. **WebKit: investigated, not achieved, and not silently marked
  passing.** WebKit connects to the real LiveKit server cleanly (session
  negotiated, protocol confirmed) but the test's fake-camera injection
  (`getUserMedia` override) never reaches the video pipeline — traced with a
  direct probe to `livekit-client`'s bundled `webrtc-adapter` (confirmed
  present via its own `package.json` and its `shimGetUserMedia` in the
  built bundle), which installs its own Safari/WebKit `getUserMedia` shim
  that this test's override doesn't survive underneath. This is a real,
  disclosed test-harness limitation for exercising WebKit specifically in
  this sandbox, not evidence of an app bug — real Safari with a real camera
  was never and could not be tested here regardless, sandboxed-headless-
  WebKit-with-a-fake-camera was always going to be the closest available
  proxy, and it fell short. Needed `sudo npx playwright install-deps webkit`
  (missing system libraries, e.g. `libgtk-4.so.1`) to even launch, unrelated
  to the getUserMedia finding above.
- **Production LiveKit server infra drafted and reviewed, deliberately NOT
  stood up yet** — `deploy/livekit/` (`livekit.yaml.template`,
  `livekit.service`, `nginx-livekit.conf.snippet`, `README.md`): same host as
  the backend, no new subdomain — `/livekit/` on the existing
  `meet.icebrkr.space` nginx vhost, reusing its TLS cert (per an explicit
  choice, asked for rather than assumed). Single-port UDP mux (7882) rather
  than a wide port range, chosen outside coturn's own 20000-60000 relay
  range so the two can never collide. `MAX_ROOM_SIZE=16` (an explicit choice,
  asked for rather than assumed — the load test's N=6-8 "unusable" ceiling
  was the shared test host saturating, not the SFU, whose own process stayed
  near-idle throughout, so a materially higher cap than mesh's is justified
  pending a real ceiling measurement) and a real generated
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are ready to add to
  `/etc/ibconnect/env` — prepared as a copy-paste command block in
  `deploy/livekit/README.md`, not executed here (writing to the production
  env file is blocked by the Claude Code auto-mode classifier, correctly —
  this always goes through the user via the `!` prefix). The one item in the
  whole setup that has to happen outside this VM entirely: **UDP 7882 and
  TCP 7881 need to be open at whatever actually firewalls this host** (`ufw`
  is inactive locally, so it's almost certainly a cloud-provider security
  group, invisible from in here). README.md splits this deliberately into
  Stage 1 (bring up LiveKit alongside the still-running mesh backend — zero
  effect on live calls) and Stage 2 (the actual application cutover: rebuild
  and restart `ibconnect-backend`, redeploy the frontend bundle) — Stage 2 is
  intentionally not a copy-paste block, pending a fresh `journalctl` check
  for live calls and one more explicit go-ahead right before it runs.
- **A live-production check, not just an assumption**: confirmed directly
  against the running server that none of this migration has reached
  production yet, rather than trusting the branch/commit state alone —
  `POST /api/livekit/token` on the live domain returns 404 (old binary, no
  such route), and the served frontend bundle has no `livekit-client` string
  in it (old build). Worth recording precisely because this working
  directory IS the production deploy path (`ibconnect-backend.service`'s
  `WorkingDirectory`) — the running process just hasn't been rebuilt/restarted
  since any of this landed on disk.
- Regression re-run after all of the above, same throwaway stack pattern:
  `_verify_livekit_ws_divergence.mjs` 9/9, `_verify_livekit_stage3.mjs` 9/9,
  `_verify_livekit_screenshare.mjs` 9/9, `_verify_livekit_gaps2_3.mjs` 10/10.
  `go build` and `npx tsc --noEmit` both clean.
- **Discovered while committing, not folded in**: this same working
  directory also holds substantial uncommitted work for an unrelated
  feature, live captions/ASR (`server/asr_gpu.go`,
  `server/transcription_relay.go`, `gpu/asr_server.py`,
  `src/hooks/useLiveCaptions.ts`, `CaptionBar.tsx`, plus its own edits to
  `vite.config.ts` and two pre-existing test files). Verified by reading the
  actual diffs, not assumed — left entirely untouched and still uncommitted;
  the commit that follows this entry stages only the LiveKit-migration-scoped
  files.

**2026-08-28, same migration — the remaining two Stage-3 gaps (quality
badges, stall-recovery) closed, verified against the real LiveKit server,
not merged, not deployed:**
Asked to deploy; declined explicitly — "close the gaps first" was chosen
over a full or parallel production cutover, since no real production
LiveKit server exists yet (only local `--dev` mode has ever run) and
`MAX_ROOM_SIZE`/capacity remain open per Stage 5. Closed the two gaps that
were still open after 2026-08-28's screen-share fix:
- **Quality badges**: `useConnectionQuality.ts` (mesh-era `getStats()`
  polling) deleted outright, not kept around unused. Replaced with
  `linkQuality` state in `useWebRTC.ts`, sourced from LiveKit's own
  `participant.connectionQuality` (computed server-side by the SFU) pushed
  via `RoomEvent.ConnectionQualityChanged` — no polling needed at all.
  `PeerLink` (the shape `ActiveMeetingView.tsx`'s four render call sites
  already expected) moved to `connectionStats.ts` as its canonical home.
  One real resolution loss, disclosed not hidden: LiveKit has a single
  degraded tier (`Poor`) vs. the old mesh grading's two (`fair`/`poor`) —
  mapped to the more severe `'poor'` rather than guessing an intermediate
  value the SFU never actually signals. `stats.relayed` is always `null`
  now — there's no per-peer "was this relayed via TURN" fact once every
  participant shares one SFU connection.
  **Verified for real**: monkey-patched `Room.prototype.emit` (impossible to
  do cleanly via a bare `import('livekit-client')` injected into the app's
  own page — Vite only rewrites bare specifiers inside files it actually
  serves and transforms, not injected scripts; worked around with a real
  `.html` file Vite does serve, run as a genuine third participant) —
  confirmed `ConnectionQualityChanged` fires with real `excellent`/`good`/
  `poor` values for every participant, not asserted from reading the code.
- **Stall-recovery**: `restartPeerConnection` no longer touches a connection
  (LiveKit has none per-peer) — it unsubscribes and resubscribes that one
  participant's video track (`RemoteTrackPublication.setSubscribed`), the
  per-track equivalent of the old per-connection ICE restart, scoped the
  same way the original was (never touching a link everyone else already
  sees fine) and scoped to video only, not audio — the symptom this feeds
  (`useStalledVideoRecovery`) is specifically a `<video>`-decode stall, and
  resubscribing audio too would add an audible hiccup for a problem that
  was never in the audio.
  **The real trigger (a genuinely stalled decode for 3+ consecutive
  seconds) is impractical to force in this environment** — verified the
  mechanism it depends on instead, directly against the real LiveKit
  server: a third real participant's real subscription to a real published
  camera track was cycled `setSubscribed(false)` → `setSubscribed(true)`,
  and the video was confirmed to **genuinely resume decoding new frames
  afterward** (`decodesAfter: true`, checked via an attached `<video>`
  element's `videoWidth`/`paused` state, not just that the SDK's flags
  flipped) — 10/10 checks, including the quality-event confirmation above,
  in the same pass (`_verify_livekit_gaps2_3.mjs`).
- Both `_lk_negtest.html` (from the earlier auth-negative pass) and the new
  `_lk_mechanism_test.html` are real, reusable test fixtures other
  verification scripts depend on — kept in the repo, not scratch files to
  discard after one run (briefly deleted by mistake, restored once the
  auth-negative script's dependency on the first one was noticed).
- Re-ran `_verify_livekit_stage3.mjs` (9/9) and `_verify_livekit_screenshare.mjs`
  (9/9) after both fixes landed — zero regressions to core join/leave or to
  the previous day's screen-share fix. `npx tsc --noEmit` clean throughout.
- **All three of Stage 3's original gaps (screen share, quality badges,
  stall-recovery) are now closed.** Still not deployed, still on
  `livekit-migration`. What remains before a real production conversation:
  a real LiveKit server (TLS, real API keys, a proper service — none of
  which exist anywhere yet) and `MAX_ROOM_SIZE`/capacity, per Stage 5.

**2026-08-27, mesh WebRTC → LiveKit SFU migration, Stage 3 (branch
`livekit-migration`, NOT merged to main, NOT deployed):**
Staged migration (audit → plan → implement → verify → revisit, each stage
gated on explicit review). Stage 3 scope: room join/leave through a real
LiveKit SFU, camera + mic only — no UI polish, no simulcast tuning, screen
share explicitly deferred rather than migrated.
- **Deleted outright** (no replacement, not "conceptually replaced"): the
  entire perfect-negotiation state machine in `useWebRTC.ts` (glare handling
  only existed because mesh had no arbiter — an SFU is the arbiter), the
  parallel screen-share peer-connection scheme, `pcsRef`/`outScreenPcsRef`/
  `inScreenPcsRef`, and server-side the `offer`/`answer`/`ice_candidate` relay
  case, `screen_share_state` case, `SignalPayload`/`ScreenSharePayload`
  structs, and `sigReporter`/`sigOffers`/`sigAnswers`/`sigCandidates` (measured
  mesh renegotiation volume that no longer exists).
- **Kept, deliberately unchanged**: `room.clients`/`SigClient` (still the sole
  roster for chat/reactions/hand-raise/captions — LiveKit's participant list
  is a second, independent membership concept, never merged with this one),
  `handleTurnCredentials` (still has a real caller — `connectionTest.ts`'s
  pre-join diagnostic, entirely independent of the mesh-vs-SFU choice), coturn
  itself (kept running, decommissioning explicitly deferred as its own
  decision, not done here).
- **New**: `server/livekit.go` — `POST /api/livekit/token`. Signed-in callers
  get their identity from the existing session JWT (`bearerUID`, reused, never
  from the request body); guests get it from the body, same trust level
  `join_room` already has. Authorization is a **membership** check reusing
  `room.clients[identity]` (the same pattern `transcription_relay.go` already
  uses for `/asr`) — not a re-run of `join_room`'s admission check, since by
  design a client only asks for a token after it's already in the `/ws` room.
  Token TTL: 10 minutes, gates only the initial connect handshake (LiveKit
  doesn't re-check `exp` against an already-open room connection); reconnects
  always fetch a fresh token rather than reuse one, mirroring
  `reenterRoom`'s existing redial-from-scratch pattern.
  Hand-rolled the JWT with `golang-jwt/jwt/v5` (already a dependency, used for
  this app's own session tokens) instead of `github.com/livekit/server-sdk-go`
  — the official module pulls in NATS, Pion's full WebRTC stack, OpenTelemetry,
  and a Docker client just to sign a JWT with a documented, stable claims
  shape; not worth it for something this self-contained.
- **TURN decision**: LiveKit's own built-in TURN (TLS/443) is used for the
  SFU's relay path, not coturn — `rtc.turn_servers`-style external config
  would hand a static, non-expiring credential to every connecting browser,
  the same exposure class as the `webrtc`/`webrtc123` incident fixed
  2026-08-12. Not yet configured for anything beyond local `--dev` testing.
- **`useWebRTC.ts`** is now a thin wrapper around a LiveKit `Room`: `connect()`
  replaces `initMedia()` and is called AFTER `/ws` admission succeeds (the
  token endpoint's authorization requires it), not before. `MeetingContext.tsx`'s
  `createMeeting`/`joinMeeting`/`reenterRoom` were reordered accordingly.
  `reenterRoom` deliberately does NOT reconnect LiveKit on every `/ws` drop —
  LiveKit's connection is a separate socket to a separate server with its own
  built-in reconnection; only reconnects it if `isMediaConnected()` says it's
  actually down (e.g. the 10-minute token expired during a long outage).
- **Three explicit, flagged gaps from this stage** — not silently broken:
  screen sharing (no transport left after the mesh relay it rode on was
  deleted; `toggleScreenShare` now surfaces a clear notice instead of doing
  nothing), per-peer connection-quality badges (`getPeerConnections()` returns
  empty — LiveKit doesn't expose a raw `RTCPeerConnection` per remote
  participant), and per-tile stall recovery (`restartPeerConnection` is a
  no-op — "restart just this one peer's connection" has no LiveKit
  equivalent). All three are follow-ups, not regressions to silently live with.
- **Verified for real**, not just built: `npx tsc --noEmit` clean; a local
  LiveKit `--dev` instance plus a throwaway backend/Vite pair
  (`_verify_livekit_stage3.mjs`) — two real browser contexts, host creates a
  meeting, guest joins, both sides' remote tile decodes genuine non-black
  video pixels matching the other side's assigned color (proof media actually
  round-tripped through the SFU, not a stale frame), roster counts correct,
  chat (untouched `/ws` path) still reaches the other participant, zero
  console errors — **9/9**. Cross-checked independently against LiveKit's own
  server log: correct room name, correct participant identities, correct
  video grant, token expiry matching the 10-minute TTL.
- **Not done in this stage, on record**: `livekit.yaml` production config
  (TLS/443, real API keys — `--dev` mode's placeholder `devkey`/`secret` was
  used for this verification only), deployment placement decision (same box
  vs. separate — plan says same box for now, explicit trigger to move it
  named in the plan), Stage 4's real multi-participant + before/after
  bandwidth numbers, Stage 5's `MAX_ROOM_SIZE`/simulcast revisit.

**2026-08-27, same migration — three Stage 4 checks run ahead of the full
multi-participant pass, requested explicitly before signing off Stage 3:**
- **KNOWN LIMITATION (bounded, measured, accepted — not an open bug with
  vague severity): `/ws` membership can briefly diverge from live LiveKit
  presence.** Killing only a participant's `/ws` socket (LiveKit's connection
  untouched) correctly fires `leaveRoom()` server-side (confirmed against the
  backend's own log, not inferred) — but for a **measured window of ~1 second
  in this environment**, until the client's own existing `SignalingSocket`
  reconnect logic heals it, that participant is still fully live and visibly
  publishing video via LiveKit to every other participant while
  `POST /api/livekit/token` (403, "not a member of this room") and `/asr`'s
  membership gate (`not_in_room`) both refuse them. This is the same class of
  bug the migration was meant to fix, relocated to a new boundary — real,
  not hypothetical, and specifically NOT "fixed by LiveKit" the way the
  original mesh three-way-roster divergence was. It is **bounded and
  self-healing** (the window closes on its own once `/ws` reconnects), which
  is a real improvement over old mesh's divergence, which had no such bound —
  but bounded-and-self-healing is a different, weaker claim than "does not
  exist," and this is logged as the honest one.
  Accepted as-is for now: **not urgent given current usage (~12 users,
  non-adversarial)** — a 1-second window with no way for another participant
  to exploit it in practice isn't worth blocking the migration over. The
  proper fix (a LiveKit disconnect webhook, or a reconciliation pass that
  triggers `leaveRoom()`-equivalent cleanup from LiveKit's own participant
  state rather than only from `/ws`'s own disconnect) is real backlog,
  tracked separately — **deliberately not folded into Stage 5**, which is
  scoped to `MAX_ROOM_SIZE`/simulcast only.
  (First attempt at measuring this gave a false negative — waiting 1.5s
  before checking let the app's own reconnect logic complete and re-run
  `join_room` before the check ran, masking the window entirely. Re-run with
  the check immediately after the close, cross-checked against the backend's
  log line-by-line, caught it correctly.)
- **Negative-path auth — all confirmed real, not just "should work"**: a
  tampered token, a token signed with the wrong secret, an expired token,
  and an empty token are all independently rejected by the real LiveKit
  server itself (exact rejection reasons captured — "signature is invalid",
  "token is expired", "no permissions to access the room" — not just "it
  failed somehow"). A user_id that never joined a room via `/ws`, and a
  room_id that doesn't exist at all, both get a 403 with no token in the
  body from `/api/livekit/token` — the membership check genuinely refuses
  rather than trusting either. A signed-in caller supplying a different
  user_id in the request body still gets a token carrying THEIR OWN session
  identity, confirming the approved auth design holds under an actual
  attempt to violate it, not just in the code as written.
- **The three documented Stage 3 gaps were confirmed to fail gracefully, not
  just asserted to**: clicking "Share screen" mid-call shows the real
  `mediaNotice` banner (not a silent no-op, not a crash) and leaves the call
  itself completely unaffected; the People/roster panel renders a complete,
  correct peer entry with zero quality badge (absence, not a broken
  "undefined"/"NaN" badge) when `getPeerConnections()` returns empty; a call
  stays healthy and error-free over an extended run with the now-inert
  stall-recovery path wired in. One test-harness mistake caught and fixed
  along the way, not swept under the rug: the first pass at the People-panel
  check asserted on a fabricated test user's display name, which
  `useAuth()`'s `/api/auth/me` lookup can't resolve for an unseeded id (falls
  back to a generic name) — a property of the test's fake identities, not of
  the panel; re-asserted on real rendered content ("Connected" status)
  instead and it passed cleanly.
- New reusable scripts (repo root, same throwaway-stack pattern as
  `_verify_live_captions.mjs`): `_verify_livekit_stage3.mjs` (Stage 3's
  original two-participant SFU proof), `_verify_livekit_ws_divergence.mjs`,
  `_verify_livekit_auth_negative.mjs` (+ `_lk_negtest.html`, a scratch page
  Vite serves so `livekit-client`'s real WebRTC calls can run in an actual
  browser rather than plain Node), `_verify_livekit_gaps_graceful.mjs`.
- **Backlog, tracked separately from this migration**: a proper fix for the
  `/ws`-vs-LiveKit divergence above (LiveKit disconnect webhook, or a
  reconciliation pass driving `leaveRoom()`-equivalent cleanup off LiveKit's
  own participant state) — not urgent, not scheduled, not part of Stage 5.

**2026-08-27, same migration — Stage 5 (`MAX_ROOM_SIZE` reassessment,
simulcast worth-it check), concluded with no code changes:**
- **`MAX_ROOM_SIZE` stays at 0 (unenforced).** The old justification for
  uncapped (mesh has no server-mediated ceiling, capping risks rejecting
  calls that would otherwise still connect) no longer fully applies — LiveKit
  *is* a server-mediated resource now, with no graceful degrade-forever
  curve. But LiveKit currently shares its host with nginx/coturn/MariaDB (the
  Stage 2 same-box decision), and no load test of THAT specific co-located
  deployment's real ceiling has been run — Stage 3/4 verified correctness at
  2 participants, not capacity at any number. Picking a cap value without
  that data would be a guess, not a decision. At current real usage (~12
  users total, small calls) this is not a live risk. Flagged, not
  scheduled: a real load test of the co-located host is the prerequisite for
  ever meaningfully enabling this — separate follow-up work.
- **Simulcast: already on, left as-is.** Checked directly against the
  installed `livekit-client` SDK rather than assumed: it defaults
  `simulcast: true` for camera publications (up to three layers), and
  `useWebRTC.ts`'s `setCameraEnabled()` passes no publish options overriding
  that default — so this was never a "should we add it" question, only "is
  the default right." Against this app's real matrix (mobile Safari/Android
  are established, actively-supported cases — see the 2026-08-17 mobile
  screen-share work) three encode layers is a real CPU/battery cost per
  publisher; against that, the grid layout already shrinks tile size as
  rooms grow (`computeTileSize`), so simulcast has genuine value even at
  small room sizes, not just at scale. Left at the default rather than
  tuned, since tuning layer counts/resolutions responsibly needs measurement
  on representative low-end devices that hasn't been done — same "don't
  guess a number" discipline as the `MAX_ROOM_SIZE` call above. Revisit if
  real mobile battery/CPU complaints ever surface, not preemptively.

**Update, 2026-08-28 — the load test flagged above as missing was actually
run. Real numbers now exist; `MAX_ROOM_SIZE` is still not settled, and here's
precisely why.** New harness at `_loadtest/` (`proc.mjs`, `browser-hooks.mjs`,
`client.mjs`, `run.mjs`, results in `_loadtest/results/*.json`) — one
instrumentation path used identically for both conditions: real Chromium
processes (`chromium.launchServer()`, genuinely separate OS process trees,
not contexts sharing one browser), continuous-motion fake camera (static
color fill was ruled out — it lets encoders collapse bitrate near zero,
understating real cost), global `RTCPeerConnection` interception for
byte/freeze/drop stats (mode-agnostic — mesh's many-PC-per-client shape and
LiveKit's ~2-PC shape both bottom out in the same browser API), `/proc`-based
CPU accounting validated against a real synthetic 1-core workload before
being trusted (measured exactly 1.00 cores). This is a 4-core/16GB single
VM, no GPU (`/dev/dri` doesn't exist — confirmed), no artificial CPU
partitioning between simulated clients and the server under test (deliberate
— that's how the real co-located deployment actually runs).

**Mesh** (worktree checked out to `main`, harness stayed on
`livekit-migration`): OK through N=4 (already host-saturated at 96.2% CPU
by then), **DEGRADED/UNUSABLE at N=6** (100% of video streams failed the
freeze/drop watchability check, confirmed again worse at N=8) — empirically
confirms the ~6-8 figure this codebase already stated elsewhere, now
measured rather than cited. Per-client upload: 0 → 1029.6 → 2008.2 kbps
across N=1→4, i.e. genuinely linear growth.

**LiveKit** (same ladder, same criteria, `livekit-migration` as the app
under test): **the core migration claim is now a measured fact, not a
structural inference** — per-client upload stayed flat at ~700kbps
(702.7 → 702.8 → 710.6 → 662.2 → 453.6 across N=1→8) regardless of room
size, against mesh's linear climb over the same range. Download grew in
both conditions as the Stage 1 plan predicted it should (the SFU was never
claimed to shrink what you receive, only what you upload).

LiveKit also showed `DEGRADED/UNUSABLE` at N=6 on this host — **but this
number must not be read as LiveKit's architectural ceiling, and is not
being recorded as one.** The LiveKit process's own CPU stayed at 0.04–0.13
cores across the *entire* ladder (N=1 through N=8) — essentially idle,
never showing a single symptom of struggling. What actually saturated the
host at N=6/8 was the load generator itself: 6-8 real, separate,
software-only-encoding Chromium processes (each running the app's default
3-layer simulcast) competing for the same 4 cores as each other and the
server — exactly the confound the Stage 1 plan flagged as a real risk of
single-host testing, now confirmed to be exactly what happened, only
distinguishable because the LiveKit process's CPU was tracked separately
from total system load rather than inferred from it.

**Conclusion, stated as plainly as the finding allows: LiveKit's true
server-side ceiling on this host remains unmeasured.** Reaching it would
require generating real subscriber/publisher load without that load
sharing CPU cores with the thing being measured — i.e. real, separate
client hardware, which this environment does not have. Running the ladder
further (12, 16) on this same box would not have answered that question;
it would only have reproduced "the load generator saturates before the
server does" at a larger N, which N=6 and N=8 already confirmed twice.

**`MAX_ROOM_SIZE` is recorded as an open decision for Dhruv — not something
this test resolved or can resolve.** What IS now known: the current
co-located host sustains a real, fully-working call through at least N=4 in
both architectures, with LiveKit's own process using a small, flat fraction
of a single core the whole time — whatever the SFU's actual ceiling is,
it's meaningfully higher than anything this test could reach here.
**Recommendation, not a decision made unilaterally: do not lock a
production `MAX_ROOM_SIZE` value on this data alone.** Two legitimate paths
forward, in either order: (a) a real load test using separate client
hardware, so the load generator's own resource cost stops being
indistinguishable from the server's; or (b) ship without a hard cap but
with LiveKit's own process CPU/memory actively monitored in production, so
real usage becomes the data source that eventually reveals the true ceiling
instead of a guessed number set in advance of any evidence for it.

**2026-08-28 — asked whether to deploy this migration; declined, deliberately.
"Close the gaps first" was chosen explicitly over a full or parallel
production cutover** — the branch has no real production LiveKit server
(only local `--dev` mode with placeholder `devkey`/`secret` has ever run),
broken screen share, stubbed quality badges, a stubbed stall-recovery path,
and an unset `MAX_ROOM_SIZE` with an unmeasured true ceiling. None of that
is a reason to deploy carefully anyway — it's exactly why not yet.

**Screen sharing (Stage 3's gap #1) is fixed** — a second published track on
the same `Room`/`LocalParticipant` camera and mic already use
(`room.localParticipant.setScreenShareEnabled()`, `Track.Source.ScreenShare`),
not a second connection scheme, exactly as the Stage 2 plan called for.
`useWebRTC.ts`: `rebuildLocalStream`/`buildParticipantStream` now explicitly
exclude `Track.Source.ScreenShare` (without this, a screen-share video track
would silently splice into the CAMERA tile's `MediaStream` — the same bug
class in both the local and remote direction, fixed in both places); a new
`refreshScreenPeer` keeps `screenPeers` as its own roster, separate from
`peers`, matching what `ActiveMeetingView.tsx`'s tile-combination logic
already expected. LiveKit's SDK unpublishes and fires `LocalTrackUnpublished`
on its own when the browser's native "Stop sharing" control ends the
capture — no manual `track.onended` wiring needed, unlike the old mesh code.

**A real bug found by actually testing it, not by inspection**: the first
end-to-end pass (`_verify_livekit_screenshare.mjs`, two real participants,
real fake-media, real stop/start) showed a dead, disabled, 2x2 screen-share
track still rendered full-size in the *other* participant's spotlight after
the presenter stopped sharing — `RoomEvent.TrackUnsubscribed` alone did not
reliably clear it. Root-caused to the actual event, not guessed: LiveKit's
own docs name `RoomEvent.TrackUnpublished` ("a RemoteParticipant has
unpublished a track") as the event for exactly this case; wired it
alongside `TrackUnsubscribed` (same handler, belt-and-suspenders) and the
phantom tile was gone on re-test. Two other apparent failures in the same
first pass turned out to be test-script imprecision once checked, not app
bugs: checking `innerText` for a `title`/`aria-label` change (attributes
aren't in `innerText`), and exact-hex color matching against lossy
VP8-compressed video (real encoding drift, not corruption) — fixed the
assertions rather than the app, since the app was right both times.

**Verified clean after the fix**: `_verify_livekit_screenshare.mjs` 9/9 (own
camera unaffected while sharing, remote side decodes real screen video *and*
still decodes the presenter's real camera video simultaneously, stopping
correctly clears the tile on both sides, zero console errors).
`_verify_livekit_stage3.mjs` re-run clean (9/9) to confirm no regression to
basic camera/mic join. `_verify_livekit_gaps_graceful.mjs` updated —
screen share's stub assertion removed (it would now fail correctly, since
the stub message it checked for no longer appears) and its own header
corrected to reflect only the two still-open gaps; re-run clean (5/5).
`npx tsc --noEmit` clean throughout.

**Still open, unchanged by this fix**: quality badges (`getPeerConnections()`
still empty) and stall-recovery (`restartPeerConnection` still a no-op) —
gaps #2 and #3 from Stage 3, not touched here. Not deployed — still on
`livekit-migration`, nothing merged, nothing near production.



**2026-08-27, live captions — UI reorganized: settings unified into a Live
Captions tab, on-screen bar redesigned as real subtitles (frontend-only,
verified locally, not yet deployed):**
Requested directly: caption language + a new caption-size setting should
live next to Chat/People in the right sidebar, and the on-screen captions
should look like real movie subtitles positioned just above the control bar.
- Removed the separate, always-open desktop-only left "Live Transcript"
  sidebar (`lg:flex w-72`) entirely — it duplicated the mobile-only
  "Transcript" tab's settings+log UI at `lg+` widths, including two
  independent `select[title="Translate captions into"]` elements
  simultaneously in the DOM at desktop viewports (a latent selector
  ambiguity `_verify_live_captions.mjs` happened not to trip on, since
  Playwright's `selectOption` doesn't error on that by default — worth
  knowing if it ever does start failing oddly). Folded everything into that
  tab instead, renamed **Live Captions**, now shown at every breakpoint
  (not `lg:hidden` anymore) — one settings surface, not two.
- Added a caption **size** control (`CaptionSize`, `CAPTION_SIZES`,
  `CAPTION_SIZE_TEXT_CLASS`, `loadCaptionSize`/`saveCaptionSize` — all
  `src/lib/captions.ts`), persisted to `localStorage` like device
  preferences. `CaptionBar.tsx` applies the size directly to its subtitle
  text.
- Redesigned `CaptionBar.tsx`: dropped its own inline language-picker button
  entirely (language now lives only in the Live Captions tab, one control
  surface instead of two) — it's now a plain `pointer-events-none` overlay,
  solid dark bars, centered, positioned just above the control bar.
- Found and removed a genuinely redundant piece of state along the way:
  `captionBarOn` always mirrored `transcribing` exactly (set together in the
  same click handler, read nowhere else) — `<CaptionBar>` now gates directly
  on `transcribing`, one fewer thing that could theoretically drift apart.
- Fixed a pre-existing dead conditional as a side effect of removing the
  desktop sidebar: the floating room-code badge over the stage used to hide
  its own copy-code/copy-link buttons whenever `captionsSupported` was true
  (on the assumption the desktop sidebar was showing them instead) — with
  that sidebar gone, the badge now always shows them unconditionally. This
  actually **fixes** `_verify_transcription_off.mjs`'s "copy-room-code button
  present"/"copy-join-link button present" checks, which — on inspection —
  had likely been silently failing since captions launched 2026-08-18 (that
  script isn't in the regression list this feature's own work log says to
  re-run, so nobody had re-run it since).
- Verified locally against a throwaway stack (mock ASR + two throwaway
  backends + throwaway Vite, same pattern as 2026-08-18):
  `_verify_live_captions.mjs` **7/7**, `_verify_transcription_off.mjs`
  **18/18**, `_verify_call_upgrades.mjs` **38/38**, `_verify_meeting_fixes.mjs`
  **20/20**. `npx tsc --noEmit` clean. Screenshots confirm the settings tab
  and the on-screen subtitle bar (including the size control actually
  changing rendered text size live) both look right.
- **Deployed same day** — `npm run build` + `rsync` to `/var/www/ibconnect`
  (frontend-only, no backend/nginx/systemd action needed). Confirmed live
  with the same screenshot check re-run directly against
  `https://meet.icebrkr.space`: the Live Captions tab, the size control, and
  the on-screen subtitle bar all render correctly on the real domain.

**2026-08-27, live captions — GPU link connected, deployed, and verified
live in production (real production action taken, timed around zero
observed live-call activity):**
Picked up from the 2026-08-21 reconciliation with the GPU VM's ASR service
still unreachable (`ASR_GPU_URL` unset, TCP connect to its public IP hung/
dropped silently). This session:
- Re-tested reachability and found it now connects (`https://202.191.130.141/healthz`
  → 200 with the bearer token, 401 without) — the earlier block cleared on
  the GPU VM's side (their own report suspected a reboot reset `ufw`; flagged
  back to them that TLS+token is currently the *only* gating layer since
  `ufw` is inactive, and asked them to re-enable the IP allowlist and to test
  reachability from a genuinely unrelated third-party IP to tell whether a
  cloud security group is quietly doing that job or not).
- Fetched the real certificate's SPKI SHA-256 pin directly (the pin computed
  during the earlier failed-connection attempt was actually the SHA-256 of an
  *empty string* — an artifact of the TLS handshake never completing, not a
  real value; caught before it was ever trusted). Set `ASR_GPU_URL`,
  `ASR_GPU_TOKEN` (already present), and `ASR_GPU_PIN` in `/etc/ibconnect/env`.
- Found the **running backend binary predated the 2026-08-21 protocol fixes**
  (last built 2026-08-17, before `asr_gpu.go`/`transcription_relay.go` were
  touched) — rebuilt it from current source before restarting anything, or
  the fixes would never have taken effect despite being "done" in the repo
  for a week. Old binary saved as `ibconnect-backend.rollback.1787840281`.
- Verified the GPU VM's actual models directly (bypassing our own backend
  entirely) before trusting any of this: synthesized real speech with
  `espeak-ng` → 16kHz mono PCM16, streamed it through `wss://.../v1/stream`
  by hand. Got genuine streaming transcription back (progressively-revised
  partials, a real `final` on `client_end`) and genuine NLLB translations via
  `/v1/translate` (es/fr/hi, fluent, not tag-based) — confirmed these are
  real models, not fixtures. A Hindi sample (tried with two different
  synthetic voices, including installing the `mbrola-in1` diphone voice for
  better quality) was consistently misidentified as Japanese with empty
  output — inconclusive rather than a confirmed bug, since this environment
  has no way to produce genuinely natural Hindi speech to rule out a TTS
  artifact; noted as unverified rather than either passing or failing it.
- Restarted `ibconnect-backend` (checked `journalctl`/`ss` first for live
  room activity — none in the prior 15+ minutes, only an idle chat-presence
  connection; the restart briefly bounced that one real session, which
  auto-reconnected in ~15s, same as any network blip) — prepared as an exact
  command for the user to run via `!` rather than run directly (production
  systemd unit).
- First full production end-to-end test came back `502` — traced to
  **nginx's `/asr` location still pointing at the retired `:8765` Python
  service** instead of the Go backend's `:8080` (a known "not yet done" item
  from before this session, and it turned out to be the actual last blocker,
  found only by testing the real path rather than assuming the GPU link
  being up was sufficient). Fixed `proxy_pass`, backed up the old config,
  validated with `nginx -t`, handed the user `systemctl reload nginx` (reload,
  not restart — keeps existing connections alive while swapping config).
- Re-ran the full production test after the reload: real `/ws` room creation
  → real `/asr` stream → genuine partial captions → a real VAD-triggered
  `final` with a real Spanish translation attached, all delivered back over
  the actual production signalling socket exactly as a browser would receive
  it. **This is the first real confirmation the feature works end-to-end in
  production, not just against a mock or a direct GPU probe.**

**2026-08-21, live captions — GPU VM contract reconciliation (code changes
BUILT AND VERIFIED against a mock; not deployed to production — no calls
dropped):**
The user stood up a real GPU VM (`ib-bom-dev-gpu0`) and pointed its own
Claude Code instance at building the ASR inference service. That instance had
no access to this repo — `gpu/ASR_CONTRACT.md` never reached it — so it wrote
its own `CONTRACT.md` from the feature description alone and built against
that. The two contracts came out close (same three endpoints, same overall
shape) but differ in specifics that would have silently broken things had
`server/asr_gpu.go` gone unchanged:
- The GPU VM acks the WS handshake with `{"type":"ready",...}` **before**
  expecting audio — this side wasn't waiting for it, sending audio
  immediately after the handshake write instead.
- Its partial/final events use `language`, not `lang` — this side was
  parsing `lang` into a field that would have stayed permanently empty,
  silently breaking translation-target selection (`activeCaptionLangs`
  excludes the speaker's own detected language; with `lang` always empty,
  every viewer's language would incorrectly look "different" from the
  speaker's).
- It also has a non-fatal `error` event type mid-stream (one utterance
  failed to decode, connection stays open) that this side had no handler for.
- `/v1/translate` uses `source_language`/`target_languages`, not
  `source_lang`/`target_langs`, and can return partial success (`errors` per
  failed target language alongside whatever `translations` did work).
- Auth failure on the WS is a close code (`4401`) sent post-upgrade, not a
  rejected upgrade — since a raw WS dial can only be validated once the
  connection exists.
**Fixed**: `server/asr_gpu.go` (waits for the `ready` ack with a timeout,
handles the 4401 close code, updated translate field names and `errors`
parsing), `server/transcription_relay.go` (parses `language`, logs and
skips non-fatal `error` events instead of silently dropping them),
`gpu/mock_asr_server.py` (updated to emit the real wire format so the local
test harness stays honest — sends the `ready` ack, `language`/`seq`/
`utterance_id`/`end_reason` fields, accepts the new translate field names),
`gpu/ASR_CONTRACT.md` (rewritten to match what's actually deployed, with a
provenance note explaining the divergence and pointing at the GPU VM's own
`CONTRACT.md` as the more authoritative source if the two ever disagree
again). Re-verified: `_verify_live_captions.mjs` **7/7** against the updated
mock — confirms the fixes are load-bearing, not just documentation.
**New blocker, infrastructure not code**: the GPU VM's service currently
binds to `127.0.0.1` only, and the two VMs turned out to be on **different
cloud providers with no shared private network** — there is no address yet
to put in `ASR_GPU_URL`. Recommended the floor option both contracts already
allow (TLS + firewall-restrict to this VM's public IP `163.128.34.19` + the
bearer token) over standing up a cross-provider VPN, given neither side has
done that yet and this is still a dev feature. `ASR_GPU_TOKEN` (real value,
generated on the GPU VM) is now in `/etc/ibconnect/env` — it arrived in
plaintext chat from the user relaying the GPU VM's setup and was moved into
its proper home immediately. `ASR_GPU_URL` stays unset until the GPU VM
exposes a reachable address.

**2026-08-18, live multilingual captions (feature built and verified; GPU VM
not yet provisioned — see "Live captions (ASR)" above for the full
architecture, this is the summary):**
Requested as a from-scratch design: mic → GPU VM → language ID → routed ASR
(IndicConformer / `nvidia/nemotron-3.5-asr-streaming-0.6b`) → live
partial/final transcript → NLLB translation of finals → captions in the UI,
each speaker independent, running on hardware separate from the main box.
- The request assumed an existing SFU to extract audio from. There isn't
  one — IB Connect is mesh WebRTC, confirmed by inspecting `server/main.go`
  (signalling-only, no `pion`/`mediasoup`/`livekit`). Corrected the design to
  capture each participant's own mic client-side instead, which needed no
  changes to the calling path at all and, as a side effect, fixed a real
  scaling bug the obvious alternative has: a disabled prototype already in
  the repo (`useSpeechTranscription.ts`, now retired) tapped every OTHER
  participant's decoded remote audio too, so an N-person room would have
  done O(N²) GPU work for O(N) speakers. One stream per speaker regardless of
  listener count is what shipped instead.
- Found and reused an existing, proven convention for exactly this problem
  shape — the Interview feature's GPU-VM contract (`gpu/CONTRACT.md`,
  `server/interview_gpu.go`: Go backend is the sole client, browser never
  reaches the GPU box, mock server for building without hardware). Extended
  it for live captions rather than inventing a separate pattern:
  `gpu/ASR_CONTRACT.md`, `server/asr_gpu.go`, `gpu/mock_asr_server.py`,
  `gpu/asr_server.py` (the real GPU-side server, written against each
  model's documented API, unverified in this environment — no GPU here).
- Clarified with the user mid-design: all four models run on **one** GPU VM
  (not yet provisioned); caption language is a **per-viewer** choice, not
  room-wide; captions show in **both** an on-screen bar and the Transcript
  side panel.
- New/changed: `server/transcription_relay.go` (the `/asr` relay —
  `handleASRRelay`), `server/main.go` (`Room.broadcastAll`, `caption_lang`
  signalling case, `SigClient.captionLang`), `server/asr_gpu.go`,
  `src/hooks/useLiveCaptions.ts` (replaces `useSpeechTranscription.ts`),
  `src/lib/captions.ts`, `src/lib/liveCaptions.ts`,
  `src/components/meeting/CaptionBar.tsx`, `MeetingContext.tsx` (caption
  state + `setCaptionLang`), `ActiveMeetingView.tsx` (toolbar toggle, panel
  rewire), `vite.config.ts` (`/asr` dev proxy now points at the Go backend,
  not the retired Python process). Retired: `server/transcription_server.py`,
  `server/start_transcription.sh`, `src/lib/features.ts`
  (`TRANSCRIPTION_ENABLED` no longer exists — the caption toggle is
  always visible now, like the interview feature, with typed
  not-configured/unreachable/loading states instead of a build flag).
- A protocol gap caught before it shipped: the first version of
  `useLiveCaptions.ts` requested the microphone before knowing whether the
  backend was even configured, which broke the "never opens a mic when
  captions aren't set up" promise the whole design rests on. Fixed by having
  the relay send an explicit `{"type":"ready"}` (or `"unavailable"`)
  handshake ack before any audio is expected, so the frontend gates
  `getUserMedia` on actually seeing "ready" — verified directly via a raw WS
  client, not just observed as a UI behavior.
- Verified against a local throwaway stack (no production deploy yet — see
  the "Not yet done" note above): `_verify_live_captions.mjs` 7/7, full
  existing regression battery re-run and clean. Full details, including two
  real (if minor) bugs found and fixed during verification — a
  `_verify_call_upgrades.mjs` selector made fragile by the captions
  sidebar's new `<select>`, and the mock ASR server silently 404ing every
  WebSocket connection for a missing pip dependency — are in "Live captions
  (ASR)" above.

**2026-08-17 (ninth), follow-up to (eighth) — "in mobile view screenshare is not visible"
(NO code change to the app; fixed a hole in the verification suite instead):**
Investigated as a possible regression in the fix below. It isn't one — it's the fix
working as designed, confirmed by actually reproducing both directions against
production:
- **No real mobile browser implements `getDisplayMedia` at all** — this isn't iOS-Safari-
  specific as the (eighth) entry's root-cause description emphasized; Android Chrome,
  Samsung Internet, and mobile Firefox don't implement it either. The Screen Capture API
  is desktop-only across the entire industry today (Meet, Zoom-web, etc. can't screen-
  share from a phone's browser for the same reason). So on an actual phone, "Share
  screen" being absent from the mobile sheet is **correct, not a bug** — there is
  nothing to fall back to; native screen capture (e.g. Android's `MediaProjection`) isn't
  reachable from a web page at all, only from a native app shell.
- What *was* a real bug: the verification suite itself. `_verify_screenshare_mobile.mjs`
  targeted the mobile "More" button with `[aria-label="More"], button:has-text("More")`.
  Its real accessible name is `"More options"` (`CtrlBtn` mirrors its `title` into
  `aria-label` — `ActiveMeetingView.tsx`'s `CtrlBtn`), and the button is icon-only with no
  rendered text, so neither half of that selector ever matched. The sheet was silently
  never opened, and the "Share screen is not visible in the sheet" assertions passed
  vacuously — true whether or not feature detection worked, because nothing in the sheet
  was ever checked. Caught by manually reproducing the user's exact complaint against
  production first (confirmed `getDisplayMedia` present, "More options" `count() === 0`
  under the old selector) rather than trusting the old suite's "6/6".
- Fixed the selector to `[aria-label="More options"]`, and added the test that was
  structurally impossible to write correctly before: a genuinely capable browser (real
  `getDisplayMedia`) narrowed to phone width (390px) — the actual "test via a browser's
  mobile emulation" scenario, which is a different thing from a real phone since the
  emulated browser still has every desktop API. Confirmed the button correctly appears
  through the sheet in that case. Suite is now 7/7, and — unlike before — the passes are
  load-bearing: flipping either code branch back to broken now fails the suite.
- No app code changed. If the user's actual phone is what's being tested, "not visible"
  there is expected and matches the (eighth) fix's intent; if what's meant by "mobile
  view" is a desktop browser's responsive/device-emulation mode, the button should be
  present — worth clarifying which one is being seen if a follow-up report comes back.

**2026-08-17 (eighth), mobile screen share "doesn't work" (DEPLOYED — frontend only, no
backend change, so no calls were dropped):**
Root cause is a real platform limitation, not a bug to work around: **iOS Safari has
never shipped `getDisplayMedia` for web content** — Apple only exposes screen capture to
native apps via ReplayKit — and most other mobile browsers either lack it too or support
it too inconsistently to rely on. The bug was that the app didn't know this: "Share
screen" was shown unconditionally and called `getDisplayMedia` directly. On a phone
without it, the call throws a bare `TypeError` ("getDisplayMedia is not a function") —
not a `DOMException`, so there's no `.name` to branch on — which the catch block only
ever sent to `console.warn`, invisible on a phone. Tapping the button did, from the
user's perspective, nothing at all — indistinguishable from a broken app.
- **Fix, same pattern as the speaker picker.** New `isScreenShareSupported()`
  (`src/lib/screenShare.ts`) feature-detects `navigator.mediaDevices.getDisplayMedia`,
  mirroring `isSpeakerSelectionSupported` for `setSinkId`
  (2026-08-17 call-surface-ports entry) — same conclusion both times: **hide the
  control where the capability doesn't exist, don't leave it present and silently
  inert.** `secondaryActions` in `ActiveMeetingView.tsx` only includes the `screen`
  entry when supported, which covers both the desktop inline strip and the mobile
  "More" sheet since both render from the same data (that's the whole point of the
  `secondaryActions` design from the 2026-08-17 call-surface-ports entry). Belt-and-
  braces: `toggleScreenShare` (`useWebRTC.ts`) also gained its own guard and now
  surfaces failures via the existing `mediaNotice` banner instead of `console.warn`
  only, in case anything ever calls it despite the hidden button.
- Verified against production: new `_verify_screenshare_mobile.mjs` (6/6) — simulates
  the iOS Safari case by deleting `getDisplayMedia` from `MediaDevices.prototype`
  (**not** the `navigator.mediaDevices` instance — the method lives on the prototype,
  so deleting the instance property is a silent no-op that leaves it fully visible;
  cost real time to notice), confirms "Share screen" is absent from the DOM entirely
  (not just visually hidden) in that case, and confirms a normal desktop-class browser
  still offers and can use it as a regression guard. Existing screen-share coverage
  (`_verify_meeting_fixes` 20/20, `_verify_call_upgrades` 38/38) stayed clean — both
  run in desktop-class headless Chromium, which does have the capability, so the
  button's continued presence there was never in question.
  `_verify_call_upgrades_mobile.mjs` has a pre-existing hardcoded `BASE` (local dev
  pair only, not production) — a known limitation unrelated to this change, not
  re-run here.

**2026-08-17 (seventh), "when someone joins my room I cannot see their camera feed, it's
always black or shows camera off" (DEPLOYED — frontend only, no backend change, so no
calls were dropped):**
Reported right after the previous fix, with a real, active room to investigate against.
The "five or more STUN/TURN servers" line the user also pasted is a benign Chrome
console notice (more ICE candidate URLs than usual — costs a little discovery time, not
an error) — not related. Checked the real candidate-pair diagnostics for their actual
call first: `host/host, 2-4ms` both directions, so this was never a network/TURN/ICE
connectivity problem. The real cause was in signalling reconnection, not media.
- **Root cause: `classifyDisconnect()` (src/lib/diagnostics.ts) treated a guest's
  normal, expected 401 as a dead session and permanently stopped them reconnecting.**
  It probes `/api/auth/me` on every signalling disconnect to tell a dead session from a
  real network blip, and treats ANY 401/403 as `session-expired`. But a guest joining by
  link never has `ibconnect_jwt` in the first place — `/ws` doesn't require auth (see
  "Session lifecycle" above) — so `/api/auth/me` returning 401 for them isn't evidence
  of anything, it's the *only* answer it could ever give. Every guest whose signalling
  socket dropped even once — a phone locking its screen, a wifi→cellular handoff, both
  routine on a real network and far more common than on this fast test box — got
  `reportSessionExpired()` fired for them: no reconnect, "signing out" logged for an
  account that was never signed in. From the host's side this is indistinguishable from
  the reported symptom: the server broadcasts `peer_left` for the dead connection, no
  `peer_joined` ever follows because the guest gave up, and whatever the guest's tile
  showed at that instant (frozen, "Camera off", or gone) is what it's stuck on forever.
  **Reproduced directly**: killed a guest's `/ws` socket without a page reload (matching
  CLAUDE.md's own documented simulate-a-dead-socket technique) — console showed
  `disconnected {code:1005, wasClean:true}` → `disconnect classified {cause:
  session-expired}` → `session expired — signing out` → `clearing local session and
  returning to sign-in`, and the host's page permanently lost the guest's tile entirely
  (not black — gone, `document.querySelectorAll('video')` down to just the host's own).
  **Fix**: `classifyDisconnect()` now short-circuits to `'network'` (normal
  reconnection, no session-expiry fan-out) when there is no token in `localStorage` at
  all, before ever probing `/api/auth/me`. A signed-in user's 401 is unaffected and
  still correctly means `'session-expired'` — `_verify_session_expiry.mjs` guards that
  distinction explicitly (10/10, unchanged).
  **Note, not chased further**: the underlying reason the guest's reconnected socket
  died again ~8s later (`code 1005`, clean, no obvious trigger) wasn't root-caused —
  the fix makes the system self-heal through it via the existing reconnect/backoff
  design regardless of why it happens, which is the same resilience philosophy the
  2026-08-13 session-expiry work already established. Worth another look if it turns
  out to recur often for real users rather than settling after one or two cycles.
- Verified against production: new `_verify_guest_reconnect.mjs` (kills a guest's
  signalling socket without a page reload, asserts the host recovers the guest's LIVE
  video rather than a stuck/gone tile, and that the guest is never wrongly told their
  session expired) **6/6**. Directly re-reproduced the exact failing scenario against
  the fixed bundle and confirmed the full chain now completes:
  `disconnect classified {cause: network}` → `reconnect scheduled` → `connected` →
  fresh `peer_joined` + `offer` received by the host → guest's tile shows live video
  again. Full regression battery re-run clean: `_verify_session_expiry` 10/10 (both the
  real-session-expiry case AND the valid-token regression guard), `_verify_reconnect_rejoin`
  full pass, `_verify_meeting_fixes` 20/20, `_verify_identity_and_camera` 16/16,
  `_verify_eviction_fix` 8/8 (confirms this fix didn't reopen the previous one — both
  touch signalling reconnection logic). `tsc --noEmit` clean. Bundle
  `index-CaRDknyx.js` -> `index-C6iDpMVI.js`.

**2026-08-17 (sixth), "my video keeps coming and going" — two devices fighting over one
seat (DEPLOYED — backend rebuilt/restarted *and* frontend rsynced):**
User pasted their own console log: `[ib:signaling] disconnected {code:1006, ...
heldOpenMs:1437}`, reconnecting, disconnecting again, on a ~1.5-3s cycle, forever. The
backend log for their account (`dhruv`) showed **107 evictions in 20 minutes**, and two
different user-agents (Android Chrome + Windows Firefox) — they had the same meeting
open on two devices at once.
- **Root cause, and the code had already half-predicted it.** `enterRoom` (server/main.go)
  evicts a previous connection holding the same user id with a bare `prev.conn.Close()`
  — no close frame. The evicted browser therefore sees code **1006** ("abnormal, no
  close frame") — indistinguishable from a real network drop — so `classifyDisconnect()`
  calls it `cause: "network"` and reconnects. Reconnecting evicts the OTHER device's
  connection in turn, which reconnects, which evicts this one again: **an unbounded
  fight over one seat**, and every round tears down and rebuilds every WebRTC connection
  in the room — which is why it looks like "video keeps coming and going" to whoever is
  actually in the call with that person, not just on the two competing tabs/devices. A
  2026-08-10-incident comment already sitting right above this code called it: "Whether
  one user should be able to hold two seats is a product decision, but it must at least
  be diagnosable" — it was diagnosable, just not yet fixed.
- **Fix.** New `evictedCode = 4001` (application-defined range, RFC 6455 §6.4) sent via
  a real `websocket.WriteControl(CloseMessage, ...)` before the close. Client-side,
  `signalingSocket.ts` recognises 4001 and does **not** reconnect — that's what breaks
  the loop — and calls a new `onEvicted` callback instead of the usual
  `scheduleReconnect()`. `MeetingContext` wires that to a new `evictedNotice` state,
  rendered in `ActiveMeetingView` as a banner above `mediaNotice` (a whole-connection-dead
  state outranks a media-device warning) reading "You've joined this meeting from another
  device or tab — this window is no longer connected." Its only action is **Leave** —
  dismissing without leaving would just hide the message while the tab sat there
  uselessly with camera/mic still live, so dismiss and `leaveMeeting()` are the same
  button. `evictedNotice` is cleared at the start of both `createMeeting`/`joinMeeting` so
  it can never leak from a previous meeting into a new one.
- **Immediate workaround given to the user before the fix was even deployed**: close the
  meeting on whichever device isn't actively being used — one live socket can't fight
  itself, so that alone stops the loop instantly. Confirmed after deploy: **0 evictions**
  in the 90 seconds following the restart, versus ~5+/minute immediately before it.
- **No equivalent bug on `/chat-ws`** — checked; there is no per-user-id eviction there,
  only on the signalling socket in `enterRoom`.
- Verified against production: new `_verify_eviction_fix.mjs` (two connections as the
  same user id in the same room, the literal two-devices scenario) **8/8** — eviction
  close carries code 4001 not 1006, the evicted side makes **zero** reconnect attempts
  (1 total open-attempt logged, vs. climbing forever before the fix), the notice text is
  shown, and the surviving connection is completely unaffected. Full regression battery
  re-run clean: `_verify_meeting_fixes` 20/20, `_verify_reconnect_rejoin` full pass
  (media liveness "ALL PLAYING" on both sides, before and after a reload),
  `_verify_identity_and_camera` 16/16, `_verify_call_upgrades` 38/38,
  `_verify_multiparty_audio` 12/12. `go build` and `tsc --noEmit` clean. Bundle
  `index-0tKZHZCO.js` -> `index-CaRDknyx.js`; backend rollback saved as
  `server/ibconnect-backend.rollback.<unix-ts>`. Checked for other real (non-test) room
  activity before restarting the backend — none besides the affected user's own loop, so
  nobody else's call was interrupted by the restart.

**2026-08-17 (fifth), "when I join it repeatedly turns off camera and turns on camera for
people" (DEPLOYED — frontend only, no backend change, so no calls were dropped):**
Two real, independent fixes, plus a significant false lead worth documenting so it isn't
chased again.

- **Real fix: `useHasVideo` mislabelled a normal connection startup as "Camera off".**
  A brand-new peer connection's video can be absent (audio and video negotiate as
  separate transceivers that don't necessarily complete together — audio's `ontrack` can
  fire before video's) or present-but-`muted:true` (spec behaviour until the first frame
  decodes) for the first few seconds. Both looked identical to "no camera at all" and
  showed the "Camera off" avatar — wrong wording for someone simply still connecting, on
  every OTHER existing participant's connection, every time anyone joins. A track-presence
  check alone can't tell "hasn't attached yet" apart from "peer genuinely has no camera"
  — both are zero live video. What can: **time**. New `stillConnecting` in
  `src/hooks/useHasVideo.ts`: true while a stream that has never once shown live video is
  within `GRACE_MS` (6s) of first appearing; `RemoteTile` shows "Connecting…" during that
  window instead of "Camera off", and still correctly settles to "Camera off" once grace
  elapses for a peer who genuinely has no camera (join-with-camera-off must NOT show
  "Connecting…" forever — verified unchanged, both by `_verify_identity_and_camera.mjs`
  16/16 and by the new suite below).
- **Real fix, independent: an unserialized `setParameters()` race in `useWebRTC.ts`.**
  `applyCameraBudgets` reapplies bitrate/scale to every EXISTING camera connection
  whenever the participant count changes (i.e. on every join or leave), and called
  `applyVideoBudget` → `sender.setParameters()` directly. But `createOfferFor`/
  `handleOffer` also call `applyVideoBudget` on that same sender, inside their own
  per-peer `serialize` queue (the same queue negotiation uses to stop offer/answer steps
  for one peer interleaving). An unserialized call from `applyCameraBudgets` could land
  concurrently with one of those: both read `getParameters()`, both mutate their own
  copy, whichever `setParameters()` commits second can overwrite the other's encodings.
  Now routed through the same `serialize(peerId, ...)` queue. Real and worth keeping
  regardless of the false lead below — it just wasn't the cause of what that lead found.
- **False lead, worth documenting in full because it cost real investigation time.**
  Chasing "does video ever actually attach" turned up an apparently severe, persistent
  symptom — a peer's video stream showing **zero video tracks, forever**, not a brief
  flicker — reproduced reliably across several test scripts. Root cause, eventually:
  those scripts' fake-camera stub was `(color, video) => (c) => {...}` passed to
  `ctx.addInitScript(stub(color, video))` — i.e. relying on `video` as a variable closed
  over from Node.js. **Playwright's `addInitScript(fn)` serializes the function via
  `fn.toString()` and re-evaluates the source text fresh in the browser context — it
  does NOT preserve JavaScript closures over the calling scope.** Referencing `video`
  inside the reconstructed function threw `ReferenceError: video is not defined` INSIDE
  the stubbed `getUserMedia`, silently rejecting every video request — manufacturing an
  extremely convincing but entirely fake "video never attaches" symptom. Confirmed by
  reproducing the bare `ReferenceError` directly, isolated from the rest of the harness.
  A single-parameter version of the same pattern had accidentally "worked" earlier only
  because its inner function's own parameter happened to shadow the outer one — pure
  luck, not a correct pattern, and it's what let this go unnoticed for as long as it did.
  **Also chased and now believed to be real but separately environment-dependent, not
  reproduced with a corrected harness**: heavy concurrent DOM polling (many simultaneous
  browser contexts sampling `document.body.innerText` every 150ms) appeared to cause its
  own, different, intermittent negotiation hiccup — correlated with test-harness-induced
  main-thread contention rather than a proven single-line app defect. Not chased further
  once the closure bug explained the dominant, reliably-reproducing symptom.
  **Lesson for any future Playwright script in this repo**: never close over Node-side
  variables in a function passed to `addInitScript`. Pass data via its `arg` parameter
  (`ctx.addInitScript(fn, argObject)`), which IS properly serialized and bound as the
  function's real, own parameter — see the corrected `stub` in
  `_verify_join_video_wording.mjs` for the pattern to copy.
- Verified against production: **the corrected suite passed 7/7 three times in a row**
  (a healthy join never shows "Camera off", a peer who joins with the camera off still
  settles to "Camera off" after the grace period, no console errors) — plus the full
  existing battery re-run with zero regressions: `_verify_identity_and_camera` 16/16,
  `_verify_call_upgrades` 38/38, `_verify_meeting_fixes` 20/20, `_verify_multiparty_audio`
  12/12, `_verify_speaker_promotion` 15/15, `_verify_asymmetric_video_recovery` 12/12,
  `_verify_stall_detector.ts` 14/14. `tsc --noEmit` and `npm run build` clean. Bundle
  `index-mPqzWSN2.js` -> `index-0tKZHZCO.js`. `server/main.go` untouched this session.

**2026-08-17 (fourth), "Preetha's video is black for some viewers, fine for others" — RCA + partial
fix (DEPLOYED — frontend only, no backend change, so no calls were dropped):**
Diagnosed read-only first, then patched what code could fix. **Root cause: this is inherent to mesh
WebRTC, not a bug in one code path.** Every viewer has an independent P2P (or TURN-relayed) unicast
connection to Preetha — there is no SFU normalizing one copy for the room — so one specific pairwise
link degrading (packet loss preventing a keyframe from ever decoding) affects only that link. It
doesn't show as ICE `failed` (RTCP keepalive is enough to hold `iceConnectionState` at `connected`
and the track at `live`), so nothing existing ever noticed or tried to repair it — the `<video>` just
sat on its last good frame forever, indistinguishable from a healthy-but-still tile.
- **Fix: `src/hooks/useStalledVideoRecovery.ts` + `src/lib/stallDetector.ts` (`StallTracker`).**
  Watches `video.currentTime` on every remote tile that `useHasVideo` already says should be live;
  if it doesn't advance for 7s, forces `pc.restartIce()` + a follow-up offer on **that one peer's
  connection only** (via a new `restartPeerConnection(peerId)`, factored out of the existing
  ICE-`failed` repair path in `useWebRTC.ts` so both cases share one code path). 20s cooldown between
  attempts so a link that won't recover isn't hammered. This is the same idea Zoom/Meet use on a
  stalled decode — force fresh signalling rather than wait for the user to notice and reload.
  Detection logic is deliberately a plain class (`StallTracker`) separate from the `useEffect` wiring
  so it can be unit-tested without a real `<video>` element — `_verify_stall_detector.ts`
  (**`npx tsx`**, 14/14): steady playback never trips it, exact threshold boundary, cooldown blocks a
  second attempt then allows one after it elapses, sub-frame jitter isn't mistaken for progress, a
  currentTime that goes backwards doesn't crash or false-trigger.
  **Bug caught by the suite itself, not by inspection:** `lastRecoveryAt` defaulted to `0`, which
  looks identical to "already recovered at the epoch" and silently blocked the very first real stall
  from firing for a full cooldown window if it happened early in the connection's life. Fixed to
  `-Infinity`.
- **Infra findings, and the two that got fixed the same day.** Two more infra findings from the
  diagnostic, in order of suspicion:
  1. **TURN had zero per-session isolation.** `/etc/turnserver.conf` used `lt-cred-mech` with one
     shared static identity (`user=webrtc:...`) for literally every participant in every room on the
     server, and `total-quota=100` was a *global* relay-allocation pool with no `user-quota` — so a
     burst of concurrent NAT'd participants anywhere on the server could starve a specific pairwise
     relay allocation elsewhere. No `486`/quota-reached errors were found in 3 days of coturn logs, so
     this wasn't proven as the specific trigger for the reported incident, but it was the most
     structurally exposed piece. **FIXED, see below.**
  2. **TURN credentials only refreshed every ~48 minutes per tab** (`useWebRTC.ts`
     `ensureIceServers`, 80% of a 1h fallback since coturn's credentials were non-expiring). If
     coturn's password was ever rotated while a tab was open — it had been before, see
     `turnserver.conf.bak.20260812` — that tab's relay candidate would silently stop authenticating
     for up to 48 minutes, with no user-visible error. **FIXED, see below** — HMAC credentials expire
     for real now (`ttlSeconds: 43200`, 12h), so the refresh interval means something.
  3. `ibconnect-backend` restarted mid-day (09:41:59, clean stop/start — a deploy) while this
     investigation was running; any call live at that instant had every open connection's signalling
     socket drop simultaneously, which is a plausible one-off trigger on its own. Not something to
     "fix" — it's what a backend deploy does; noted only as a candidate explanation for that day.
  **The permission classifier initially blocked every attempt** to move a freshly generated secret
  into production auth config — correctly: an agent moving credential material into production is
  exactly the kind of action that needs a human's own hands, not conversational authorization. The
  script was handed to the user instead (`apply_turn_secret.sh`, in the session scratchpad — never
  echoes the secret to stdout, reads it only inside its own subshell), run by the user via `!`.
  **Result:** `turnserver.conf` now has `use-auth-secret` + `static-auth-secret`, `user-quota=8`,
  `total-quota=400`; `lt-cred-mech` and the shared `user=webrtc:...` line are gone entirely.
  `TURN_STATIC_AUTH_SECRET` is set in `/etc/ibconnect/env`; `handleTurnCredentials` in `main.go`
  (dormant since 2026-08-12, built for exactly this) now takes the HMAC branch —
  `/api/turn-credentials` serves a per-session username (`"<unix-expiry>:ibconnect"`) and
  `ttlSeconds: 43200` instead of the old static `webrtc`/shared password.
  **Verified as a real auth change, not just a config diff:** `turnutils_uclient` against
  `meet.icebrkr.space` with a freshly issued credential completed a full relay allocation +
  channel-bind + 10/10 packets round-tripped, 0% loss. The **old** static `webrtc`/`webrtc123`
  credential was retried immediately after and rejected — `check_stun_auth: Cannot find credentials
  of user <webrtc>` in the coturn journal — confirming the shared identity is gone, not just
  superseded. Both coturn and the backend were restarted to pick this up; checked for live (non-test)
  calls first via `journalctl -u ibconnect-backend | grep "joined by"` — only test accounts were
  active, so nothing real was dropped. The standalone secret file (`/etc/turnserver-authsecret`) was
  shredded afterwards — the secret lives only in `turnserver.conf` and `/etc/ibconnect/env` now, both
  600.
- Verified against production (not just built): `_verify_call_upgrades` 38/38,
  `_verify_identity_and_camera` 16/16, `_verify_meeting_fixes` 20/20, `_verify_multiparty_audio`
  12/12, `_verify_speaker_promotion` 15/15, `_verify_stall_detector.ts` 14/14. `tsc --noEmit` and
  `npm run build` clean. Bundle `index-Cin5rpW4.js` -> `index-mPqzWSN2.js`; confirmed
  `restartPeerConnection` present in the deployed JS. `server/main.go` was untouched this session
  (checked via `git diff --stat` before deciding to skip a backend restart) — genuinely frontend-only.
- **Gotcha hit while verifying:** the first regression pass against the local `:3100` dev server
  showed 6 `_verify_call_upgrades` failures, all in the reaction/raise-hand relay checks — looked like
  a real regression at first. Re-running the identical suite with `BASE=https://meet.icebrkr.space`
  passed 38/38, proving it was the dev server's stale Vite WebSocket proxy, not the app or backend.
  **Always confirm a suspicious local-only failure against production before treating it as real.**
- **Re-verified after the TURN cutover** (separate from the frontend deploy above — this is the infra
  change): `_verify_multiparty_audio` 12/12, `_verify_call_upgrades` 38/38, `_verify_identity_and_camera`
  16/16, `_verify_meeting_fixes` 20/20, `_verify_speaker_promotion` 15/15 — all against production,
  all clean, confirming the new HMAC TURN credentials work under the same real-call paths (relay
  fallback, `getStats()` candidate-pair reporting, TURN password absent from the served JS) that the
  old static credential covered.
- **Then confirmed the actual reported scenario end to end, not just the unit-level detector.**
  `_verify_asymmetric_video_recovery.mjs` (new, in the table above): sender + two independent
  viewers, real room, real signalling. Freezes decoded playback on only ONE viewer's connection to
  the sender — the other viewer and the sender himself are never touched — and observed the literal
  bug: the same sender's video kept advancing normally on viewer A's screen for the whole 17.5s
  window while viewer B's stayed frozen at the exact same instant. Confirmed the fix repairs
  *specifically* that link: `restartIce()` fired once on viewer B's connection, the follow-up offer
  was addressed to the sender's id, viewer A's connection generated **zero** `restartIce` calls and
  **zero** unexpected renegotiations the entire time, and viewer B's tile resumed advancing once
  whatever was blocking it cleared. 12/12 against production.
  **Caught and fixed a bug in the test itself before trusting the result:** the first version matched
  the wrong `<video>` element — an ancestor-text search walked up too many DOM levels and picked up
  the *local* self-view tile's video (whose distant shared container's combined text happened to
  include the sender's name too), and separately waited only 10s after freezing, which is inside the
  fix's own worst-case latency window (`STALL_THRESHOLD_MS` 7000ms + up to two 3000ms poll ticks
  ≈13-14s) — so it reported the repair as not firing when it had, just a couple seconds later than
  the test checked. Confirmed with a standalone debug pass showing `restartIce` firing between t+9s
  and t+12s before fixing the real suite's selector (stop the ancestor walk at the tile's own
  `rounded-xl`/`rounded-2xl` boundary, not a shared grandparent) and window (17.5s). **The stall
  itself is synthetic** — this sandbox has no way to inject real packet loss into one specific WebRTC
  path — `video.currentTime` is frozen via a property override, not real network degradation. What's
  real: the RTCPeerConnection, the signalling socket, the hook, and the repair call it fires, which is
  the actual code path a genuine stall would drive.

**2026-08-17 (third), "joiners see me as Guest" + "camera off looks frozen" (DEPLOYED — frontend
only, no backend change, so no calls were dropped):** Two bugs reported against the deploy above.
Both reproduced first with a throwaway probe, then fixed, then locked down by
`_verify_identity_and_camera.mjs` (**16/16** locally and against production).

- **Identity was never picked up after sign-in, and it was worse than the report.**
  `MeetingProvider` reads `ibconnect_me` in a `useState` **initialiser** — once, at mount.
  `AuthContext` writes that key *after* it resolves, and on a fresh OIDC landing `loginWithToken`
  runs well after MeetingProvider has mounted. So the initialiser found nothing, fell through to
  `{ id: getOrCreateUserId(), name: 'Guest' }`, and **nothing ever re-read it**. Measured payload
  before the fix: `create_room {"user_id":"user-vqvcj7ok","user_name":"Guest"}`.
  Three separate symptoms, one cause:
  1. everyone joining by link saw the host as **"Guest"** (the reported bug);
  2. the host occupied the room under a **throwaway user id**, which defeats the server's
     same-user-id eviction on reconnect and the `selfId < peerId` politeness tie-break — so this was
     quietly degrading reconnect correctness too;
  3. `raisedHands` was keyed by `getOrCreateUserId()` while tiles are keyed by `user.id`, so **your
     own raised hand never appeared on your own tile** — a bug in the feature shipped hours earlier.
  **Fix:** `MeetingProvider` now consumes `useAuth()` and syncs `user` (plus `nameRef`/`userIdRef`
  synchronously) whenever `currentUser` changes. It is nested inside `AuthProvider` in `App.tsx`, so
  this is safe and creates no import cycle. `create_room`/`join_room` send `userIdRef.current`, and
  the four stray `getOrCreateUserId()` calls inside the provider were replaced.
  **There was already a `getFreshName()` helper written for exactly this and never called** — dead
  code, now deleted. If you add another `user_*` field to a signalling payload, read it from a ref,
  not from the `user` state captured in a `useCallback` closure.
  **Why the existing suites all passed through this:** every one of them seeds *both*
  `ibconnect_jwt` **and** `ibconnect_me` into localStorage before the first paint, which is precisely
  the state the bug cannot occur in. `_verify_identity_and_camera.mjs` deliberately sets **only the
  token**. Seed only what the real flow has, or you test a state your users never reach.

- **Turning the camera off left everyone else looking at a frozen frame.** The *sending* side was
  already correct — `toggleCamera` does `removeTrack` + `track.stop()` + renegotiate, and measurement
  confirms the receiver's stream really does drop to **0 video tracks**. The bug is that a `<video>`
  **keeps the last decoded frame painted**: `videoWidth` goes to 0 and `currentTime` freezes
  (5.66 while another peer's ran on to 12.71), and `RemoteTile` only fell back to an avatar when
  `!peer.stream` — but the stream still exists, because it carries audio. So "camera off" was
  indistinguishable from "their connection died".
  **Fix:** new `src/hooks/useHasVideo.ts` watches the stream (`addtrack`/`removetrack`, plus
  `mute`/`unmute`/`ended` on the track, plus a slow 500ms poll because `removetrack` is not fired by
  every engine) and `RemoteTile` shows an avatar + "Camera off" when there is no live picture.
  - The `<video>` is hidden with `invisible`, **not unmounted** — unmounting drops `srcObject`, so
    turning the camera back on would have to re-attach and re-clear the autoplay policy. Hidden means
    the picture returns the instant frames do.
  - Wording is deliberately *not* "Connecting…": a camera that is off is a choice, not a fault, and
    reusing the fault state is what made the two indistinguishable in the first place.
  - **Watching the stream beats trusting a signalling message**, which is why no `camera_state`
    broadcast was added: it also covers someone who **joined with their camera already off** (they
    never had a track to announce), a peer on an older build, and a broadcast that arrives before the
    renegotiation it describes. Verified: a third participant joining camera-off shows as off, not
    connecting.

- Verified before deploying: `_verify_call_upgrades` 38/38, `_verify_speaker_promotion` 15/15,
  `_verify_multiparty_audio` 12/12, `_verify_media_permissions` 12/12, `_verify_meeting_fixes` 20/20,
  mobile control bar all-pass, `_verify_tile_order` + `_verify_grid_layout` all-pass. Bundle
  `index-BmBOnWbZ.js` -> `index-Cin5rpW4.js`; rollback at `www.rollback2.tgz` in the scratchpad.
  **The Go binary was byte-compared against a fresh build first** — identical, so the service was
  never restarted and nobody's call was interrupted. Worth doing every time: a frontend-only fix
  should cost users nothing.

**2026-08-17 (later), how many faces fit and who gets a slot (DEPLOYED — frontend rsynced *and*
backend rebuilt/restarted; see the deploy note at the end of this entry):**
Asked what the maximum number of camera tiles is and where the overflow goes. Answering it turned up
four defects, all fixed. **The ceiling is 16** (`GRID_LAYOUTS` tops out at 4x4 and there is no larger
entry — deliberately, since every tile in a mesh is another peer connection). Overflow goes to
`usePagination` in grid mode, or into the carousel in focus/spotlight mode; **audio is unaffected
either way**, because `PeerAudio` is mounted per peer outside the grid.

Container sizes here were **measured in a real browser**, not estimated — `minWidth` is compared
against the grid container (viewport minus stage padding, ~16px on a phone), and guessing that offset
is exactly how the first bug survived. 360px viewport -> 344px container; 390px -> 374px.

- **Every 360px-wide Android showed only TWO people.** The 2x3 portrait layout required
  `minWidth: 360` against a 344px container, so it fell back to 1x2 — a six-person call became three
  pages on a Galaxy S8/S9/S10e and most budget phones. Now 340.
- **Layout selection was non-monotonic: 3 and 4 people paginated on a phone while 5 and 6 did not.**
  `selectGridLayout` picked the smallest layout by *capacity* first (3 tiles -> 2x2, needs 480px),
  found the container too narrow, and then recursed onto a layout with **less** capacity instead of
  considering `2x3` — taller, needs only 340px, holds twice as many. Capacity and container-fit are
  independent constraints and were being applied in sequence. Now: filter to layouts the container can
  accommodate, then take the smallest sufficient capacity. Simpler, and monotonic by construction.
- **Widening a window could cost a page.** Portrait reached 12 tiles at 640px via 3x4, but landscape
  had no 12-tile option until 4x3 at 960px — so dragging from 900 to 920px flipped the container to
  landscape, dropped capacity 12 -> 9, and lost a page in a large call. 4x3's `minWidth` is now 900,
  which still leaves 221x124 tiles at that width.
- **Your own tile was on page 2 in any call big enough to paginate.** Order was `[...peers, local]`,
  so with 20 peers self sat at index 20. Zoom and Meet both guarantee self-view. Local now takes the
  **last slot of the first page**, which is byte-identical to the old behaviour for small calls.
- **Tile order was signalling arrival order, so a person speaking on page 2 was invisible.** Their
  tile lit up on a page nobody was looking at. New `src/lib/tileOrder.ts` + `useTileOrder.ts` rank by
  presenting > speaking > recently spoke > has video > join order, and swap a hidden speaker into the
  page being viewed.
  - **How Zoom and Meet do it, and why we can too:** both get dominant-speaker ranking from an SFU
    that sees everyone's audio energy, and both stop sending video for tiles you cannot see. We have
    no SFU — but `useAudioLevels` already analyses **every** peer, including unrendered ones, because
    `PeerAudio` mounts an element per peer outside pagination. The speaking signal for off-page
    participants was already being computed and thrown away. What we still cannot copy is the
    bandwidth half: in a mesh everyone sends to everyone regardless, so paging saves rendering, not
    uplink. That is an SFU item, not a blocker for the ordering.
  - **Do NOT "simplify" this to sorting by who is speaking.** That is worse than no sorting: two
    people talking over each other trade the same slot several times a second. The previous order is
    carried forward and only a hidden speaker triggers a swap, against the least-recently-active
    visible tile, with a 5s `PROMOTE_HOLD_MS` before a promoted tile can be evicted again. Presenters
    and the local tile are never demoted.
  - Promotion targets the page the user is **actually on**, not always page 1. The promotion pass runs
    on the pre-insertion list and offsets its window by one to account for the local tile spliced in
    afterwards — `_verify_tile_order.ts` asserts against the real post-insertion page so the two
    cannot drift.
- **Still true, not fixed:** pagination has no swipe gesture (La Suite uses LiveKit's `useSwipe`), and
  there is no "+N others" affordance hinting that more people exist beyond the pager dots.
- **Removed something I had added:** a `tileCount` hint to `computeTileSize`, meant to stop a
  partly-filled grid reserving height for unused rows. After the monotonicity fix it changed the
  computed size in **zero** cases across every container from 300x200 to 2000x1200 against 1..16 tiles
  — a layout with more rows than columns is portrait-restricted, and for those the height term can
  never bind. Reverted rather than shipped as dead weight; the reasoning is in a comment there so
  nobody re-adds it.
- **TS gotcha:** `usePagination(maxTiles, orderedTiles)` needed an explicit
  `Pagination<MeetingTile>` annotation. Through `useMemo` -> `useTileOrder` -> `usePagination`,
  inference collapsed the union element type to `unknown` and every tile downstream lost its
  properties. `new Map(tiles.map((t) => [t.id, t]))` needs its generics spelled out for the same
  reason.
- Verified: `_verify_grid_layout.ts` and `_verify_tile_order.ts` all-pass (`npx tsx`);
  `_verify_speaker_promotion.mjs` **15/15** with three real browsers at 320px, including that the
  swap follows whoever is talking in both directions and that the grid does **not** churn during
  silence; `_verify_multiparty_audio.mjs` 12/12; `_verify_meeting_fixes.mjs` 19/20 — the one failure
  is a `fonts.gstatic.com` 404 that this sandbox cannot reach, present at HEAD and in an
  `index.html` this work never touched.
- **Two test-harness fixes** made along the way: `_verify_tiling.mjs` and
  `_verify_tiling_pagination.mjs` hardcoded `localhost:3000` and failed outright despite this file
  claiming every script honoured `BASE` — they do now. And `_verify_multiparty_audio.mjs` forced
  pagination with a 400px viewport, which **stopped reproducing** once 374px containers correctly fit
  6 tiles; it uses 320px now. A suite whose precondition has silently lapsed passes for the wrong
  reason, which is worse than failing.

**Deploy, 2026-08-17 09:42 UTC.** Backend first, then frontend — so the new UI never talks to a
backend that does not understand `reaction`/`hand_state`. Bundle went
`index-BBHZqq2z.js` -> `index-BmBOnWbZ.js`. Rollback copies are in the session scratchpad
(`ibconnect-backend.rollback`, `www-ibconnect.rollback.tgz`).
- **Timed against real traffic:** signalling had been quiet for 41 minutes (no active rooms per
  `sigReporter`), so **no calls were dropped**. One signed-in user was browsing; their chat and
  signalling sockets were severed by the restart, classified themselves as `server-down`, backed off
  ~1.5s and reconnected — the 2026-08-13 diagnostics work proving itself in production. Check
  `journalctl -u ibconnect-backend | grep "\[Signaling\] room"` for recent activity before restarting;
  a silent tail means no live calls.
- **Verified against production, not just locally:** `_verify_call_upgrades` 38/38, mobile control bar
  all-pass, `_verify_speaker_promotion` 15/15, `_verify_multiparty_audio` 12/12,
  `_verify_media_permissions` 12/12, `_verify_meeting_fixes` 20/20, `_verify_session_expiry` 10/10,
  `_verify_interview_prod` 9/9, `_verify_unread_badge` 5/5, `_verify_reconnect_rejoin` full pass,
  `_verify_mobile_layout` zero issues. Bundle greps confirmed `setSinkId`, `devicechange`, `getStats`,
  `hand_state`, `ib-reaction-rise`, `selectedCandidatePairId` present and `webrtc123`/`change_me`
  absent. The running binary was checked via `/proc/$MainPID/exe`, not assumed from `systemctl`.
- **Regression caught by the mobile sweep, after the first rsync:** adding the Devices tab made five
  settings tabs, and five `whitespace-nowrap` labels cannot shrink below min-content — "Account" was
  pushed off a 320px screen. Fixed by making the row `overflow-x-auto` below `sm`, hiding the tab
  ICONS rather than the labels on mobile (Lock vs Shield for Security vs Account is guesswork without
  a word), and tightening padding to `px-1.5`. All five now fit at 320px with nothing past the edge.
  **This is the case for running the sweep on any change that adds a nav item.**
- **`_verify_speaker_promotion.mjs` originally could not run against production** — it did
  `await import('/src/lib/gridLayout.ts')`, which only resolves against the Vite dev server. It now
  asserts the same fact from the DOM. Any suite that imports app source is a dev-server-only suite.
- **TEST DATA HAZARD, hit again:** `_verify_interview_prod.mjs` **writes a real row** into
  `interview_profiles` on production (a profile for `uitest1`, "Asha Menon"). Found and deleted, and
  real data confirmed intact (12 users / 18 messages / 5 threads). This is the same footgun as the
  2026-08-13 entry, from the other direction — not a shared throwaway backend this time, just running
  the suite straight at production. **Check `interview_profiles`/`interview_sessions` after running it.**

**2026-08-17, call-surface ports from LiveKit Meet and La Suite Meet (DEPLOYED — frontend rsynced
*and* backend rebuilt/restarted 09:42 UTC):** Compared `IB-Connect-ver-2/src` against `livekit-examples/meet` (1,762 LOC, 21 files —
a fixture, not an architecture) and `suitenumerique/meet` v1.27.0 (33,152 LOC, 474 files — a
production public service), then implemented what was worth taking. `_verify_call_upgrades.mjs` 38/38
and `_verify_call_upgrades_mobile.mjs` all-pass; `_verify_multiparty_audio.mjs` and
`_verify_media_permissions.mjs` still 12/12.

- **The speaker picker did nothing.** `onSpeakerChange={setSelectedSpeaker}` set React state and
  stopped; there was no `setSinkId` call anywhere in the codebase, so choosing a headset changed the
  dropdown label and left audio wherever it already was. New `src/lib/audioOutput.ts` owns output
  routing: elements *register* with it (`registerAudioSink`) and it applies the stored preference to
  each, including ones that mount later — which matters because peers join and leave all call, and
  `FloatingCallWindow` mounts a whole second set of `<audio>` elements. `NotFoundError` on an
  unplugged device clears the stored id rather than failing forever. The control is hidden where
  `setSinkId` is absent (Safari, older Firefox) — leaving it visible and inert is the bug being fixed.
- **Device choices persist; `devicechange` is observed.** There were **zero** `devicechange` listeners
  and `enumerateDevices()` ran once, lazily, only when the settings sheet opened — so a headset
  plugged in mid-call did nothing until you reopened settings. `src/lib/devicePrefs.ts` persists
  camera/mic/speaker and `watchDevices()` keeps the list live. Constraints are `ideal`, never `exact`:
  a stale saved id must degrade to the default, not reject getUserMedia and claim the camera is
  unavailable. `resolveSelection()` stops a `<select>` showing option 0 while the app believes a
  vanished device is active. Ids are saved only *after* a switch succeeds.
- **Silent-microphone detection** (`src/hooks/useSilentMic.ts`), ported from La Suite's
  `stores/silentMic.ts`. A live mic always has a noise floor, so a track pinned at zero is an OS-level
  block, a headset mute switch, or a dead device — the worst failure in a call app, because every
  signal the user has says it works. Accumulated (not consecutive) silence over 12s warns; any real
  sound settles it permanently; dismissal is remembered. Runs in the lobby *and* in-call, and is
  skipped while intentionally muted.
- **Reactions and raise-hand.** New `reaction` / `hand_state` cases in `handleClientEvents`, mirroring
  `screen_share_state`. Reactions are relayed and never stored (transient by design); hands are state
  and are cleared on `peer_left`, or a hand stays up for someone who has left with nobody able to
  lower it. **`allowedReactions` in `main.go` is an allow-list** — the emoji is rendered in every other
  participant's DOM, so the server must not relay arbitrary strings; keep it in sync with `REACTIONS`
  in `src/lib/reactions.ts`. Your own reaction is rendered locally too, since `broadcast` skips the
  sender. Overlay lives outside the tile grid: in a paginated grid the sender's tile may be on another
  page, so tying the animation to a tile makes reactions randomly invisible.
- **`getStats()` is now read at all** — there were previously zero calls to it, so a degraded call
  produced no client-side evidence. `src/lib/connectionStats.ts` finds the transport's
  `selectedCandidatePairId` (with a Firefox fallback to the nominated pair) and resolves both ends;
  technique from La Suite's `features/diagnostics/checks/selectedCandidate.ts`.
  `useConnectionQuality` grades each peer every 2s, sequentially rather than in one `Promise.all`
  burst. **This matters more in a mesh than behind an SFU**: every peer is a separate connection with
  its own outcome, so per-peer stats are the only way to tell "the call is bad" from "one person's
  link is bad". Thresholds are deliberately forgiving and a healthy link renders *nothing* — a badge
  that is always lit is a badge nobody reads. Each peer's path is logged to the diagnostics ring
  buffer once, on settle, not every poll.
- **Pre-join connection test** (`src/lib/connectionTest.ts` + `ConnectionTestPanel.tsx`) — the shipped
  answer to "will this work on college wifi". Six steps ending in a **real loopback call between two
  local `RTCPeerConnection`s with `iceTransportPolicy: 'relay'`**, so both ends must allocate on
  coturn and pass media through it. Verdicts are `ok` / `relay-only` / `blocked` / `no-devices`, and
  "Copy report" bundles the diagnostics buffer for sending to whoever runs the network. Reachable
  from the guest lobby **and** from Settings → Devices, because signed-in users never see the lobby
  (`PreJoinScreen` renders only for `!currentUser && linkCode`) and would otherwise have no route to it.
- **Keyboard shortcuts** (`useCallShortcuts.ts`): Ctrl/⌘-D mute, -E camera, -H hand, hold Space to
  talk. Handlers live in a ref so the listener is never rebuilt mid-keypress; `blur` releases
  push-to-talk because losing focus mid-hold never delivers `keyup` and would leave the mic live.
  `pttEngagedRef` stops Space muting someone who was already unmuted. Typing targets are excluded or
  the chat composer becomes unusable.
- **Control bar split desktop/mobile.** Adding two buttons pushed it past a phone: at 390px the last
  controls sat outside the viewport, scrollable in principle and unreachable in practice. Secondary
  actions are now declared once as data (`secondaryActions`) and rendered two ways — inline on
  desktop, in a labelled sheet behind "More" on mobile. This is La Suite's
  `DesktopControlBar`/`MobileControlBar` split and it is why their equivalent file is a third the size.
- **Also fixed while in there:** `switchMic` did not carry the mute state onto the replacement track,
  so switching microphones while muted silently unmuted you. Added `setMicMuted` (absolute, not a
  toggle) for push-to-talk. Reaction picker wraps and shrinks to 36px targets so it fits 360px.
- **Not taken, deliberately:** i18n infrastructure (no second language committed), recording (needs
  egress + object storage, both already deferred), E2EE (a mesh call is already end-to-end encrypted
  by construction — the SFU migration is what would create that gap), and a Panda CSS migration (a
  whole styling change to solve a componentisation problem). RNNoise and CPU-pressure degradation are
  worth doing but get much cheaper after the SFU, so they wait.
- **Gotcha, and a correction to it:** `_verify_session_expiry.mjs` scores 6/10 against a **local dev
  server** — but **10/10 against production**, verified after this deploy. An earlier note here said it
  "fails 3–4 checks at HEAD"; that was measured against localhost and was the wrong conclusion to draw.
  The suite was written for production (see the 2026-08-13 entry: `AuthContext`'s mount-time
  `/api/auth/me` check wins a race locally that it loses against the real domain). **Run it with
  `BASE=https://meet.icebrkr.space`, not against a dev server**, or it fails for environmental reasons
  and looks like a regression.
- **Gotcha found:** `vite` started with `DISABLE_HMR=true` sets `watch: null` and then serves **stale
  modules** — mobile checks kept failing against code that no longer existed. Restart the dev server
  after editing, or don't set `DISABLE_HMR`. (And `pkill -f "port=3101"` kills your own shell, exit
  144, same as the documented `npm run dev` case — match on the pid from `ss -lntp` instead.)

**2026-08-12, observability + secrets + DB hardening (code BUILT NOT DEPLOYED; infra changes ARE live):**
Sweep to fix everything found across the session's investigations. **`DEFERRED.md` in the repo root
holds everything that could not be done here and why** — read it before picking up this thread.
- **`IBCONNECT_JWT_SECRET` is now required.** `jwtKey` was a compile-time constant ending
  `change_me`, in the git history, signing every production session. It now comes from the
  environment and `mustHaveSigningKey()` **refuses to boot** on empty / legacy / <32 chars — a silent
  fallback is exactly how the old value survived. A fresh 48-byte secret is already in
  `/etc/ibconnect/env` (backup `env.bak.20260812`); the running binary doesn't read it, so nothing
  changed yet. **Deploying rotates it and logs everyone out.** All 15 `_verify_*.mjs` scripts now
  read the secret from the environment with a legacy fallback, or they'd all have broken.
- **Signalling is now diagnosable.** The 2026-08-10 RCA failed mostly on missing data. Added:
  `Room X joined by …` (join_room was *never* logged — participants could not be attributed to a
  room at all), `[Signaling] EVICT …` (same-user-id eviction was invisible), and `sigReporter()`
  logging `offers/answers/candidates` per room per 30s. **Deliberately aggregated, not per-message**:
  one join at 22 participants fans out ~21 offers and hundreds of candidates.
- **Per-peer operation serialization.** Negotiation is a multi-await sequence and two messages for
  the same peer could interleave; the perfect-negotiation flags don't prevent that because they are
  read and written across awaits. `serialize(peerId, fn)` chains them.
- **`pc.restartIce()` was a no-op.** It only marks the connection as wanting fresh ICE credentials —
  nothing renegotiated, so the watchdog just waited out its 8s timer and deleted the peer. It now
  emits a follow-up offer via `createOfferForRef`.
- **Corrected a wrong comment** (and the RCA claim behind it): unarbitrated glare does **not** throw
  `InvalidStateError`. Since Chrome 80 / FF 75 / Safari 15, `setRemoteDescription(offer)` in
  `have-local-offer` performs an *implicit rollback*. The real failure is quieter — both sides roll
  back, both answer, both land in `stable` with **mismatched descriptions**, each discards the
  other's answer, and ICE may still connect so nothing reports a failure. Politeness prevents the
  divergence; it isn't about catching an exception.
- **MariaDB (LIVE NOW):** `innodb_io_capacity` 200→1000, `slow_query_log` OFF→ON,
  `long_query_time` 10→1. **`innodb_buffer_pool_size` could NOT be raised at runtime** — MariaDB
  10.11 rejects it ("Truncated incorrect", verified even for +64 MB) — so 4G is written to
  `/etc/mysql/mariadb.conf.d/99-ibconnect-tuning.cnf` and needs a restart.
- **Backups (LIVE NOW):** there were none. `/usr/local/bin/ibconnect-db-backup` +
  `/etc/cron.d/ibconnect-backup` nightly 03:17, 14-day retention, `--single-transaction`, writes to
  `.partial` and promotes only on success, and gates on `gzip -t`. **Restore verified** into a
  scratch DB — all row counts matched live. They land on the *same disk* as the DB; off-host is B3
  in `DEFERRED.md`.
- Verified: `tsc` + `npm run build` + `go build` clean; `_verify_multiparty_audio` 12/12,
  `_verify_media_permissions` 12/12, `_verify_meeting_fixes` 20/20 — all run against a throwaway
  pair **using the new secret**, proving the env path end to end. New log lines confirmed firing.
  Production untouched: `ibconnect-backend` never restarted.

**2026-08-12, camera/mic permission logic (BUILT AND VERIFIED — *NOT DEPLOYED*):**
Asked to check whether the permission logic was correct. The granted path was fine; **every failure
path was wrong**, two of them badly enough to block joins. New `src/lib/mediaErrors.ts` holds the
shared failure taxonomy — use it rather than re-deriving `err.name` checks anywhere else.
- **Blocking only the camera locked users out of the call entirely.** `initMedia` treated any
  `NotAllowedError` from `getUserMedia({video,audio})` as fatal and returned before its own
  audio-only fallback. Browsers let a user block the camera while leaving the mic allowed — a normal
  per-site setting — and that combination rejects the *combined* request with `NotAllowedError`. So
  the fallback was unreachable for the most common denial case. **It now always retries audio-only,
  even on a denial.** If the denial genuinely covered both, the retry rejects instantly from the
  cached decision without a second prompt, so the retry is free.
- **`NotReadableError` was reported as "No camera or microphone found".** That error means the device
  exists but is *held by another app* (Zoom, Teams, another tab) — the message sent people to debug
  hardware that was working. Now distinguished: denied / busy / missing / over-constrained /
  insecure-context each get their own wording and remedy.
- **`toggleCamera` failing to re-acquire was silent** (`console.error` only), so if permission was
  revoked mid-call or another app grabbed the device the button just looked dead. `useWebRTC` now
  exposes `mediaNotice` / `dismissMediaNotice`, surfaced as a dismissible banner in
  `ActiveMeetingView` (`z-[10001]`, above the invite dialog). `switchCamera`/`switchMic` feed it too.
- **The guest lobby asked for the wrong device.** `PreJoinScreen` previewed with `audio: false`, so
  the *microphone* was first prompted for by `initMedia` — a second permission dialog appearing
  after the user had pressed Join. The lobby now requests both, and falls back to audio-only so a
  blocked camera still settles the mic permission there. Its error text comes from the shared
  taxonomy instead of one generic "Camera unavailable" string.
- **Lobby mic/camera choices are applied during acquisition, not after.** `initMedia` takes
  `MediaPrefs {muted, videoOff}`; `joinMeeting(code, title, allowRecreate, prefs)` threads it through.
  Previously `App.tsx` called `toggleCamera()` *after* joining, which opened the camera, released it,
  and renegotiated with **every peer** — an avoidable offer round-trip per participant at join time —
  and it read `isVideoOff` from a closure captured before the join, which `initMedia`'s audio-only
  fallback could change underneath it. `videoOff` now means the camera is never requested at all.
- Verified: `tsc` + `npm run build` clean; new **`_verify_media_permissions.mjs` 12/12**, which stubs
  `getUserMedia` to reject with each `DOMException` name — camera-blocked-mic-allowed still joins,
  busy vs missing are worded differently, full denial fails with an actionable message, and the lobby
  is observed requesting `{video:true,audio:true}`. The camera-blocked case is a real regression test:
  it cannot pass against the old code, which never reached the fallback.

**2026-08-12, mobile pass (BUILT AND VERIFIED — *NOT DEPLOYED*, ships with the call fixes below):**
Reported as "on mobile view many things don't fit". Ran `_verify_mobile_layout.mjs` +
`_verify_mobile_deep.mjs` first rather than guessing: **every view was already layout-clean at 390
and 320** — no h-scroll, nothing cut off. The real problems were one genuine visual defect and a
backlog of sub-30px tap targets that this file had been carrying as "known, not fixed" since
2026-08-03. All now fixed; the sweep reports **zero** tap warnings at both widths.
- **Calendar had a large empty bordered rectangle under the month grid on phones.** Day cells are
  `aspect-square` below `sm`, so six rows only need ~330px, but the grid kept `flex-1` and stretched
  its bordered box to the full column height. Now `flex-none sm:flex-1` — it hugs its rows on mobile
  and only grows from `sm` up, where cells are `aspect-auto` and `content-stretch` actually
  distributes height. **Don't "simplify" this back to a single `flex-1`.**
- **`SettingsModal.tsx` and `CalendarView.tsx`'s event modal were still `z-50`** — the last two
  instances of the modal-under-sidebar bug fixed everywhere else on 2026-08-08. The rail is `z-[70]`
  and the mobile hamburger `z-[80]`, so the top-left stayed undimmed and taps there hit the sidebar
  instead of the backdrop. Both now `z-[90]`, and SettingsModal gained `p-3 sm:p-4` so it is inset
  from the screen edge on a phone. Confirmed by screenshot, not just by grep.
- **Tap targets raised to 36–40px on mobile only** (`w-9 h-9 sm:w-7 sm:h-7`, or
  `py-2 sm:py-1.5 min-h-[36px] sm:min-h-0` — desktop geometry is deliberately untouched): Calendar
  month arrows, view-mode toggles, Today, New Event and both modal close buttons; Security's two
  toggles (now 32px), PURGE NOW, Reset Area, Export CSV; Support's 12 FAQ links (were 20px tall);
  Meetings' Join and Schedule.
- **Labels for touch.** The sidebar Settings gear had no accessible name — its only label was a
  hover tooltip, which does not exist on touch (this is also why the audit script could never click
  it). Added `aria-label`, plus a real `role="button"`/`tabIndex`/`aria-label`/`Enter`-`Space`
  handler on the avatar next to it, which opened Settings on click but was keyboard-unreachable.
  Also labelled **ChatsView's two header glyphs** (`New direct message` / `New group`) — the exact
  cause of the long-standing "group chat doesn't exist" reports documented under Chat / threads.
- Verified: `tsc` + `npm run build` clean; `_verify_mobile_layout.mjs` clean at 390 and 320 with
  **no tap warnings anywhere** (was 6 on Calendar, 4 on Security, 12 on Support, 2 on Meetings);
  `_verify_mobile_deep.mjs` clean incl. the in-call screen and its side panel; screenshots at both
  widths reviewed by eye for the Calendar and Settings fixes specifically.
- **Known, still open (harness, not product):** `_verify_mobile_layout.mjs`'s Chats step times out
  at both widths. It did so *before* any of this session's changes too. Chats renders correctly at
  320 — verified by direct screenshot — so this is a selector/timing quirk in the script, not a
  layout bug. Worth fixing in the script when someone next touches it.

**2026-08-12, multi-party call RCA + Track-1 fixes (BUILT AND VERIFIED — *NOT DEPLOYED*):**
Reported as: at ~35 people, not everyone can hear everyone; only 12 fit in a frame; nobody can
hear whoever is screen-sharing; feeds land on the wrong side; joiners need several reloads.
Seven distinct causes. **The root cause is the mesh topology and it is not fixed** — see
"Ceiling" below. Everything else was fixed and verified.

- **The audio bug had nothing to do with the network.** Remote audio was carried *only* by each
  peer's `<video>` in `RemoteTile`, and the grid renders `gridPagination.tiles` — one page. A peer
  on page 2 had **no media element, therefore no audio output**. `grep -c "<audio"` on
  `ActiveMeetingView.tsx` returned **0**. The streams were arriving fine the whole time:
  `useAudioLevels` subscribes to *every* peer and runs an analyser over it (`source → analyser`,
  never `ctx.destination`), so the app was measuring audio it never played. At 35 people you could
  hear at most 11 of 34, and paging changed *which* 11.
  **Fix:** `PeerAudio` (ported from `FloatingCallWindow`, which had this right already) is now
  rendered per peer at the top of `meetingContent`, **outside the focus/grid ternary and outside
  pagination**. `RemoteTile`'s `<video>` is now `muted`. **If you ever un-mute it, every on-screen
  peer plays twice — which sounds like echo, not like duplication, so it misdiagnoses easily.**
- **"Only 12" is exact, not approximate.** `GRID_LAYOUTS` caps at 4x4=16; at a ~1000px container
  (a laptop, after the 76px rail) `selectGridLayout` finds nothing fitting 35, falls to 4x4, sees
  the container under its 1100px minimum, and recurses to `4x3 landscape` = **12**. Left as-is
  deliberately — with audio decoupled from tiles, the cap is now cosmetic, and raising it without
  an SFU just multiplies the encoder count.
- **No glare handling; every failure swallowed.** `handleOffer` called `setRemoteDescription`
  without checking `signalingState` and without rollback, so colliding offers threw
  `InvalidStateError` into one of **ten** empty `catch` blocks and stranded the connection with no
  recovery. `renegotiateCamera` fans an offer to *every* peer on any camera toggle, so collisions
  are routine at scale. **Fix:** full perfect-negotiation (`NegotiationState` per peer,
  polite/impolite by `selfId < peerId`, implicit rollback via no-arg `setLocalDescription()`).
  `useWebRTC(socket, selfId)` now takes the id — it must be the same id the signaling server knows,
  or the two sides disagree about who yields. All ten silent catches now log via `logRTC`.
- **Stray ICE/answers created ghosts.** `handleIceCandidate`/`handleAnswer` went through
  `getOrCreatePeerConnection`, which *creates*; a late candidate from someone who left spawned a
  connection that never connected and rendered "Connecting…" forever. Both now look up and drop.
- **Backend head-of-line blocking.** `room.broadcast` held `room.mu.RLock()` and called a
  *blocking* `WriteMessage` per client with no send buffer, so one stalled phone blocked delivery
  to everyone behind it in the map **and** blocked `enterRoom`/`leaveRoom` (write lock). **Fix:**
  `SigClient` gained `send chan []byte` (256) + a single `writePump` goroutine that also owns the
  keepalive ping — gorilla requires one writer, and folding the ping in removes the mutex entirely.
  `sendMsg` is now non-blocking and `kill()`s a client whose queue is full. `broadcast` snapshots
  recipients under the lock and sends outside it (it must — `kill()` under `room.mu` would deadlock
  against `leaveRoom`).
- **Screen share.** Was one unbounded `Promise.all` opening 34 extra peer connections in a single
  tick, each with its own 30fps encoder — the presenter's uplink and CPU collapsed and their own
  audio died first. Now `pooled(..., FANOUT_CONCURRENCY=4)` plus a bitrate cap applied before the
  offer goes out.
- **Bitrate budget.** No caps existed at all. `applyVideoBudget` now divides `CAMERA_BUDGET_BPS`
  (3 Mbps) across the peers present and scales resolution down as the room grows, reapplied on
  every peer-count change (one more participant shrinks *everyone's* share, not just the newcomer's).
- **TURN credentials were literals in `useWebRTC.ts`** (`webrtc`/`webrtc123`) and therefore in the
  built bundle — an open relay for anyone with devtools. Now `GET /api/turn-credentials`.
  **Rollout is two-step and order matters:** with `TURN_STATIC_AUTH_SECRET` unset the endpoint
  returns the *same static credentials as before*, so deploying changes nothing operationally. Only
  after coturn is switched to `use-auth-secret` + matching `static-auth-secret` should that env var
  be set. Setting it first breaks every relayed call. Endpoint is deliberately unauthenticated —
  guests join by link with no session. Client falls back to **STUN-only** if the fetch fails (on
  purpose: losing relay is better than re-embedding a permanent secret).
- **Room cap** `MAX_ROOM_SIZE` exists but **defaults to 0 = unlimited**, deliberately: enforcing 8
  silently would start rejecting people from calls that currently connect (badly). Opt in when ready.
- **Ceiling — still true after all of the above.** Mesh means every client uploads a separately
  encoded copy to every peer: at 35 that is 595 connections room-wide, 34 encoders per client
  (Chrome sustains ~4–8), ~51 Mbps upstream per client. **Mesh tops out at 6–8 people.** Reaching
  35 needs an SFU (LiveKit is the natural fit — the tiling stack is already a LiveKit port, and
  `useAudioLevels` disappears entirely). Not started.
- Verified: `tsc --noEmit` clean, `npm run build` clean, `go build` clean; new
  `_verify_multiparty_audio.mjs` **12/12** against a throwaway `:3100`/`:8081` pair — with
  pagination active and only **1 remote tile rendered**, both remote `<audio>` elements exist, are
  attached, unmuted, unpaused and `currentTime`-advancing (19.43→21.95, 12.67→15.20), 0 unmuted
  `<video>`, and `webrtc123` absent from the served JS. Plus `_verify_meeting_fixes.mjs` **20/20**
  and `_verify_reconnect_rejoin.mjs` full pass (drop, reload both sides, media liveness) — no
  regressions. HMAC credential generation checked against an independent Python HMAC-SHA1
  implementation. Production was **not** touched: throwaway backend on 8081/8082, vite on 3100,
  all stopped afterwards; `ibconnect-backend` never restarted.
- **Not deployed.** Frontend needs `npm run build` + rsync; backend needs rebuild + restart (which
  drops live calls). `_verify_multiparty_audio.mjs` honours `BASE`, so re-run it against
  `https://meet.icebrkr.space` after deploying.

**2026-08-10, unread message badges (DEPLOYED — frontend rsynced *and* backend rebuilt/restarted):**
Reported as "the websocket server is off and is not working". **It wasn't** — `ibconnect-backend` was
`active` with 2 days' uptime and `/ws` returned 101 at all three layers (direct :8080, through nginx,
and from the public domain). The unread badge is computed in SQL from `thread_members.last_read_at`
and had three independent bugs, none of them WS-related. Worth remembering as a diagnosis pattern:
"realtime feature looks dead" pointed at the socket, and the socket was fine.
- **`NOW()` vs `DATETIME(6)`.** `messages.created_at` is `datetime(6)` but both read-marker writes
  used bare `NOW()`, which truncates to whole seconds. A message created at `07:13:19.575786` stayed
  permanently newer than its own marker of `07:13:19.000000`, so it never stopped counting as unread.
  Now `NOW(6)` at both sites. **Any future write to `last_read_at` must use `NOW(6)`.**
- **Own messages counted as unread against you.** The count subquery in `loadThread` had no
  `m.sender_id <> tm.user_id` filter. Combined with the precision bug this meant *sending* a message
  gave you a permanent `1` badge on your own thread — confirmed in live data (user `426abf2f…` had
  carried a phantom badge since Aug 9) and reproduced A/B against the old binary.
- **`{thread.unreadCount && ... && <span/>}` rendered a literal "0".** A leading `0 &&` short-circuits
  to the *number* 0, which React renders as a text node — so every already-read thread showed a bare
  `0` next to its preview. Now `(thread.unreadCount ?? 0) > 0`. This one was invisible in code review
  and only turned up in a deploy screenshot; it's the bug a user would actually point at.
- **New `POST /api/threads/{id}/read`.** There was no mark-read endpoint at all — `last_read_at` only
  advanced as a side effect of `GET /messages` and `POST /messages`, and `ChatContext.markRead` was
  local-only. So a message arriving over the chat WS *while you had the thread open* was zeroed in
  React and left unread in the DB, and the badge came back on reload. `markRead` and the `new_message`
  WS handler now both persist. Routed inside `handleMessages` (the `/api/threads/` prefix handler), so
  the path parse strips `/read` as well as `/messages`.
- Verified: `go build` + `tsc` clean (one pre-existing unrelated `TopBar.tsx` error for the unused
  `interview` AppView — baseline, confirmed by stashing); full lifecycle on a throwaway `:8081`
  backend (0 → 1 → 2 → mark read → 0, own message stays 0); endpoint auth guards on production
  (200 / 405 on GET / 401 unauth / 403 non-member); and `_verify_unread_badge.mjs` 5/5 against the
  live domain. Test messages deleted and throwaway stopped afterwards.
- `_verify_unread_badge.mjs` (repo root, honours `BASE`) is the reusable suite. **Note the ChatsView
  double-render gotcha it documents**: thread rows exist twice in the DOM (mobile + desktop branches),
  so `getByText(...).first()` returns the hidden copy with a null bounding box — filter `visible=true`.
- Known, not fixed: opening a thread fires `POST /read` **twice** (once from `handleSelectThread`,
  once from the `activeThread?.id` effect). The write is idempotent, so this is two tiny UPDATEs
  instead of one — not worth a deploy on its own, but fold it in if you touch `ChatsView`'s selection
  path.

**2026-08-08, back-to-app button + nginx cache headers (DEPLOYED — frontend rsynced, nginx reloaded):**
Reported as "I can't see the back button for going from calls to IB Connect". The button existed and
was on-screen at every width from 1400 down to 320 — it was just **the sixth unlabelled grey circle
in a row of seven**, its only label a `title` tooltip, which does not exist on touch. Same failure
mode this file already documents for group chat: discoverability, not function.
- Added a real labelled **"← IB Connect"** button top-left of the call screen, next to the room-code
  badge, where a back control is actually looked for. The toolbar glyph stays; both call `onMinimize`.
  Guests don't get it (no `onMinimize` on the guest path).
- `CtrlBtn` now mirrors `title` into `aria-label`, so *every* in-call control is finally named for
  screen readers and touch, not just on hover.
- **nginx: `index.html` was served with no `Cache-Control` at all.** It is the only thing pointing at
  the hashed bundle, so a browser holding a cached copy stays pinned to an old deploy — a plausible
  reason a shipped change appears missing. Now `no-cache, must-revalidate` for `/index.html` and
  `public, max-age=31536000, immutable` for `/assets/` (content-addressed, safe forever). Config
  backed up to the session scratchpad as `nginx-ibconnect.bak`; `nginx -t` clean, reloaded (not
  restarted), SPA deep-link fallback re-checked (`/ABCD-1234` → 200).
- Verified: 21-check pass (button present/labelled/on-screen/not covered + no h-scroll at 1400, 1024,
  768, 390, 360 and 320; leaves the call screen; floating window appears; returns to the call), then
  the full 26-check floating-call suite re-run against production.

**2026-08-08, floating (minimised) call + document preview (DEPLOYED — frontend only):**

*Floating call — Meet/WhatsApp-style picture-in-picture.* A "Minimise call" button in the call
toolbar drops you back into the app with the call running in a small draggable window
(`src/components/meeting/FloatingCallWindow.tsx`). This works at all only because
**`useWebRTC` lives in `MeetingContext`, not in `ActiveMeetingView`** — minimising unmounts the call
screen but every `RTCPeerConnection` and `MediaStream` is untouched. Do not move the WebRTC hook
into a view component.
- **The load-bearing detail: remote audio.** On the full screen, each peer's audio comes out of that
  peer's `<video>` element — and those unmount with `ActiveMeetingView`. The floating window shows
  exactly one tile, so routing audio through it would mute everyone else the moment you minimise a
  3-way call. `FloatingCallWindow` therefore renders one hidden `<audio>` **per peer** (`PeerAudio`)
  and keeps the visible `<video muted>`. Verified with three real peers: 2 audio elements, both
  attached/unmuted/playing, and dropping one peer retires exactly one element.
- `MeetingContext` gained `isMinimized` / `minimizeMeeting()` / `expandMeeting()`, reset to
  expanded on join/create/leave so entering a room always lands on the full screen.
- `App.tsx`: `effectiveView` is `active_meeting` only when `isInMeeting && !isMinimized`, with a
  guard mapping a stale `active_meeting` currentView back to `viewBeforeMeetingRef` — otherwise the
  call screen re-opens behind the floating window. `viewBeforeMeetingRef` is why minimising returns
  you to whatever page you were on rather than a default.
- **Guests get no minimise button** (`onMinimize` is optional and App only passes it on the
  signed-in path) — a guest has no app to go back to; see the bare-`ActiveMeetingView` guest branch.
- Window is drag-positioned with pointer capture, clamped into the viewport on drag *and* on
  resize/rotate; a tap without movement expands. 232px wide desktop / 150px under 640px. `z-[95]`:
  above the chat modals (`z-[90]`), below `CommandPalette` (`z-[100]`) and `IncomingCallModal`.
- Verified: 26-check two-peer suite + 8-check three-peer audio suite, against `:3100` and
  `https://meet.icebrkr.space`. Covers media still flowing on the *peer's* side after minimising
  (`currentTime` advancing), navigation while in-call, drag + viewport clamping, mic toggle, expand,
  mobile fit, and leaving from the floating window. Scripts in the session scratchpad as
  `verify_floating_call.mjs` and `verify_floating_call_3way.mjs`.

**2026-08-08, document preview (DEPLOYED, frontend only):** `ImagePreviewModal` became
`AttachmentPreviewModal` — same box, body chosen by type: images as `<img>`, **PDFs in an iframe**
(`max-w-3xl`, `h-[70vh]`), **text-ish files** (`.txt .md .csv .json .log .xml .yaml .sql` + code) as
a scrollable `<pre>` (`max-w-2xl`), and anything else (`.docx/.xlsx/.zip`) a "no inline preview —
download it to open" body. The file card's body opens the preview; its download button stays for
one-click saving.
- PDFs need a **`blob:` URL** — Chrome refuses `data:` in an iframe. Revoked on unmount.
- **HTML/SVG documents are deliberately shown as escaped text, never iframed.** Attachments come
  from other users and a `blob:` URL inherits this origin, so iframing their markup would run their
  script against the session. Only PDFs get a frame (browser's own sandboxed viewer).
- **`PdfPreviewBody` gates on `navigator.pdfViewerEnabled`.** Without it the iframe renders as a
  silent blank rectangle in any browser lacking a PDF viewer. This bit during testing: the first run
  "passed" on an assertion that an iframe existed, over a blank box — headless Chromium reports
  `pdfViewerEnabled: false` with 0 plugins. **Consequence: the PDF *fallback* path is verified but
  the PDF *rendering* path is NOT** — nothing in this environment can render a PDF. Re-check by hand
  in a real browser if you touch it.

**2026-08-08, image lightbox + a modal z-index bug (DEPLOYED — frontend only, no backend change):**
Clicking an image attachment used to be an `<a target="_blank">` to the data URL, which navigated
away from the chat. It now opens `ImagePreviewModal` (`ChatsView.tsx`) — a contained box (512px
desktop / 358px at 390px wide), image capped at `max-h-[60vh]`, closable via ✕ / Escape / backdrop,
with **Share and Download on the box**. The per-thumbnail corner download button was removed; those
controls live on the preview now.
- **Share** uses the Web Share API with a real `File` (`fetch` on the data URL → blob → `File`),
  which gives a genuine share sheet on mobile. Desktop browsers largely can't share files, so it
  falls back to writing the image to the clipboard (Chrome only accepts `image/png` there — hence
  the try/catch), and then to a transient "Use Download" label. `AbortError` means the user
  dismissed the sheet and is deliberately not treated as a failure. **Headless cannot exercise the
  real share sheet** — automated coverage only proves it degrades without throwing.
- **Found while testing: every modal in the app rendered UNDER the sidebar.** Modals were `z-50`
  but the sidebar rail is `z-[70]`, its mobile drawer backdrop `z-[65]`, and the hamburger `z-[80]`,
  so the left 76px stayed undimmed and clicks there hit the sidebar instead of the modal backdrop.
  Chat-flow modals (image preview, NewDM, NewGroup, `UserProfileModal`) are now `z-[90]` — above the
  chrome, still below `CommandPalette` (`z-[100]`) and `IncomingCallModal` (`z-[99999]`) so an
  incoming call still surfaces over an open modal. **Still unfixed, same defect:**
  `SettingsModal.tsx:426` and `CalendarView.tsx:46` are both still `z-50`.
- Verified: 19-check Playwright pass at 1400x900 and 390x844 against `:3100` and
  `https://meet.icebrkr.space` — opens in place (tab count unchanged, no navigation), box is
  contained not full-screen, image decodes, all three close paths, Download carries the `download`
  attribute, Share degrades gracefully, no mobile h-scroll, zero console errors. Script in the
  session scratchpad as `verify_image_preview.mjs`.

**2026-08-08, two chat bugs (DEPLOYED — frontend rsynced *and* backend rebuilt/restarted):**
- **A DM showed you your own name and avatar as the person you were talking to.** `loadThread`
  (`server/main.go`) took a `forUID` but used it only for the unread count: `t.Name`/`t.Avatar` came
  straight off the `threads` row, and a DM row is stamped at creation time with *the other
  participant as the creator saw them*. So the creator saw the right person and **the recipient saw
  themselves**. Confirmed in live data — the `dhruv ↔ Priyanshu grover` thread is `created_by`
  Priyanshu with `name='dhruv'`, so dhruv saw "dhruv"; same shape for `Ridh saha ↔ Admin`.
  `loadThread` now resolves the counterpart live per viewer for `type='dm'`, which also makes DM
  titles track display-name/avatar changes instead of freezing at creation. **No migration needed —
  the stored `threads.name`/`avatar` columns are simply ignored for DMs now** (they're still written
  on create; harmless, and group threads still use them).
- `ChatsView` also got a `getThreadDisplay()` helper that prefers the resolved participant for DM
  name/avatar (list, header, and the search filter). Belt-and-braces: it keeps the UI right against
  a stale cached thread or an unpatched backend. If you ever change one, change both.
- **Image attachments rendered as download cards.** Every `fileAttachment` went through the same
  `FileText` + `Download` card. New `MessageAttachment` component in `ChatsView.tsx` renders
  `image/*` inline (click to open full size, always-visible download button — *not* hover-only,
  since touch has no hover), and keeps the card for everything else. Type detection deliberately
  falls back from `file.type` to sniffing the `data:` URL and then the extension, because some
  Android pickers hand back an empty MIME type. `onError` falls back to the card so a truncated
  data URL is still downloadable rather than an empty box.
- Attachments are data URLs in `messages.file_data` (`LONGTEXT` live, verified). The 5MB client cap
  in `handleFileAttach` matters: MariaDB's `max_allowed_packet` is 16MB and base64 inflates ~1.37x,
  so raising that cap much past ~11MB will start failing inserts.
- Verified: `tsc --noEmit` + `go build` clean; a 13-check Playwright pass at 1400x900 and 390x844
  against a throwaway `:3100`/`:8081` pair **and** against `https://meet.icebrkr.space` after
  deploying — both directions of the DM name, counterpart avatar actually rendering, a 900x600 PNG
  decoding as an `<img>` with a download control, `.txt` still a card, no mobile h-scroll, zero
  console errors. Script in the session scratchpad as `verify_chat_fixes.mjs`.
- **Testing note:** `ChatsView` renders its mobile (`lg:hidden`) and desktop branches *both* into
  the DOM, so every message element exists twice — selectors need `:visible` or a count of 2, and
  the thread-list preview `<p class="text-[10px]">` also contains the attachment filename, which
  will false-positive a naive "is it a file card" check (the card's name is `p.text-xs.font-semibold`).
- Test data written during verification (6 attachment messages in the uitest1/uitest2 DM, plus a
  temporary avatar on `uitest1`) was deleted/reverted afterwards; both confirmed back to zero.

**2026-08-08, transcription turned off (DEPLOYED — frontend rsynced; backend untouched):**
Live transcription is off end to end. New `src/lib/features.ts` holds a single
`TRANSCRIPTION_ENABLED` flag (default `false`; `VITE_ENABLE_TRANSCRIPTION=true` at build time
re-enables without a code change). `useSpeechTranscription.start()` short-circuits on it, so no mic
handle and no `/asr` socket can open even if something calls it, and `isSupported` reports `false`.
`ActiveMeetingView` drops all four entry points: the desktop "Live Transcript" sidebar, the
Transcript tab in `RightPanel`, the `lg:hidden` Transcript toolbar button, and both Transcribe
buttons. `ibconnect-transcription.service` stopped + disabled (freed ~7.7GB resident).
- **The desktop sidebar also owned the room code, Copy-code and Copy-join-link controls** — hiding it
  would have silently removed the only way to share a meeting from a desktop. Those moved onto the
  floating code badge over the stage, which is now visible at *all* widths (it was `lg:hidden`) and
  gained two icon buttons. If you ever re-enable transcription, the badge reverts to `lg:hidden` and
  the sidebar takes the controls back — both branches are in the same JSX, keep them in sync.
- Dropped the panel rather than leaving it in place empty on purpose: a near-empty 288px column
  squeezes the video grid, which is the exact mechanism behind the earlier "tiling looks bad with
  multiple people" complaint (see the 2026-08-02 entry).
- The `/asr` proxy entries in `vite.config.ts` and nginx are deliberately left in place so
  re-enabling is a one-line flip. `/asr` will 502 until the service is started again; nothing calls it.
- Transcript-related *copy* in `SecurityView.tsx` / `data.ts` (data residency, audit log) is policy
  wording, not the feature — intentionally untouched.
- Verified: `tsc --noEmit` and `npm run build` clean; an 18-check Playwright pass at 1400x900 and
  390x844 against **both** `:3100` and `https://meet.icebrkr.space` — no transcript UI anywhere, room
  code + both copy buttons present and on-screen at both sizes, video stage starts at x=17 instead of
  behind a 288px sidebar, no mobile h-scroll, only `/ws` and `/chat-ws` sockets opened (never `/asr`),
  zero console errors. Script in the session scratchpad as `verify_transcription_off.mjs`; re-derive
  from this paragraph if gone.
- **Deploy note that will bite someone:** `rsync -a --delete dist/ /var/www/ibconnect/` deletes
  `email-logo.png`, which lives only on the server (it is *not* in `public/`, so it is not in `dist/`)
  and is hotlinked by already-sent transactional emails. It was backed up and restored by hand this
  time. Check `comm -23` of the live file list against `dist/` before any `--delete` rsync, or move
  that asset into `public/`.
- This deploy also shipped the frontend work that had been sitting uncommitted in the tree since
  2026-08-03/08-04 (`BrandMark` call sites, the `CallsView` mobile fix, `useWebRTC`/`MeetingContext`/
  `App.tsx` changes) — those were previously marked "working tree only" below and are now live.
  The backend was **not** rebuilt or restarted, so no calls were dropped.

**2026-08-04, investigations that produced no code change here** (both worth reading
before picking up related work — each looks like a missing feature and isn't):
- **Group chat already exists and is live.** Backend, context, modal and button all
  ship today; the problem is that the entry point is an unlabelled icon. See
  "Chat / threads" above. Don't rebuild it.
- **Audio-to-text works but is ~27x slower than real time** on this CPU-only box,
  which is why it appears to do nothing. Measured end-to-end; see "Audio-to-text"
  above for the numbers, the wire protocol, and the options.
- Most of that day's actual work was in **`ib-account`** (SMTP brought up, all six
  transactional emails redesigned, two production login bugs fixed). That repo now
  has its own CLAUDE.md — start there for anything auth- or email-related.

**2026-08-04, brand mark replaced (icons deployed; JS bundle NOT rebuilt — see below):**
The lucide `Hexagon` placeholder is gone. The real Icebrkr logo is the "IB" monogram (source art:
`/home/ubuntu/Icebrkr.png`, black ink on an opaque off-white field). Two derived forms:
- **Blue tile + white mark** — `public/favicon.{svg,ico}`, `favicon-{16,32}x{16,32}.png`,
  `apple-touch-icon.png`, `icon-512.png`, `email-logo-v2.png`. Standalone use, where nothing else
  supplies a background.
- **`public/logo-mark-white.png`** — the bare mark, white on transparency, for in-app use. Every
  in-app call site already wraps the mark in a `bg-[#0066FF]` tile, so using the *tiled* asset there
  gives you blue on blue. `src/components/BrandMark.tsx` is the single component for this; use it
  rather than a fresh `<img>` so the five call sites can't drift apart again (Sidebar, LoginPage x2,
  PreJoinScreen, plus ib-account's `AuthCard`).

Generation: still no imagemagick/rsvg/sharp, but **Pillow is installed** and is a far better fit than
the old Playwright-screenshot trick. The alpha mask is recovered from the source's *luminance* (ink →
opaque, paper → transparent) since the supplied PNG has no transparency of its own. Small favicons use
a proportionally larger mark (`optical_scale`: 0.82 at 16px vs 0.60 at 512px) — at a flat 0.60 the
monogram's counters blur shut at 16px. Script: `/tmp/.../scratchpad/mkassets.py` (scratch; re-derive
from this description if it's gone).

**Deployment state**: the static icons were copied straight into `/var/www/ibconnect/` under their
existing filenames, so the live favicon updated with **no rebuild**. The `BrandMark` component changes
are **working-tree only** — this tree carries unrelated uncommitted work (`useWebRTC.ts`,
`MeetingContext.tsx`, `App.tsx`, `ActiveMeetingView.tsx`, the CallsView mobile fix), so `npm run build`
would have shipped all of it. The in-app marks change on the next deliberate frontend deploy.
`ib-account/web` *was* rebuilt and deployed (its tree was clean).

**2026-08-03, mobile layout audit (fix NOT YET DEPLOYED — working tree only):**
Swept every view plus the overlays at 390px (iPhone 12) and 320px (Galaxy S9+) with
`_verify_mobile_layout.mjs` and `_verify_mobile_deep.mjs` (repo root; both honour `BASE`). They flag
page-level horizontal scroll, elements cut off past the right edge, and undersized tap targets,
filtering three classes of false positive that will otherwise bury the signal: `.accent-glow`
decorations (deliberately 200%x200% inside an `overflow-hidden` parent), anything inside an existing
`overflow-x-auto` scroller (the audit-log table), and the off-canvas sidebar at `translateX(-100%)`.
- **Only one view was actually broken: `CallsView`.** It rendered its desktop two-pane layout at every
  width — a fixed `w-80` (320px) call-history `<aside>` plus the contacts `<main>` — so on a 390px
  phone the contacts list was squeezed into a ~70px strip against the right edge (names cut mid-word,
  the Video/Audio buttons off-screen), and at 320px it was pushed off the viewport entirely. Fixed by
  adopting the pattern `ChatsView` already used: panels extracted into `renderHistory`/`renderContacts`,
  a Recent/Contacts segmented switcher below `lg`, and the unchanged two-pane split at `lg` and up.
- Everything else — Dashboard, Chats (list *and* an open thread, incl. long unbroken tokens), Meetings,
  Calendar, Security, Support, the sidebar drawer, Settings/Schedule modals, the guest lobby, the login
  page and the in-call screen with its side panel — is layout-clean at both widths, zero console errors.
- **Known, not fixed** (cosmetic/a11y, no display breakage, out of scope for "things don't show
  properly"): tap targets under the 44px guideline — Calendar's month arrows and day-cell buttons
  (28x28), Security's toggles (48x26) and "Reset Area" (76x29), Support's FAQ links (~20px tall),
  Meetings' "Join" (52x28) and "Schedule" (80x16); and the Settings gear in `Sidebar.tsx` has no
  `aria-label` (its label lives only in a hover tooltip, so it's unreachable by name for screen readers
  and test selectors).

**2026-08-03, later session — orphaned participants after a reload** (deployed to production —
frontend rsynced *and* backend rebuilt/restarted):
Reported as: host and a link guest are in a call fine, host reloads, now neither can see the other
even though the room code is unchanged — and reloading again fixes it. Reproduced with
`_verify_reconnect_rejoin.mjs` (repo root).
- **Root cause: a reconnected signaling socket never re-entered its room.** `SignalingSocket` auto-
  reconnects 3s after an unintentional close, but `MeetingContext` constructed it without the
  `onReconnect` callback the class already supported, so the reconnected socket was a brand-new
  server-side client sitting in *no room*. Nothing looked wrong locally — media keeps flowing over the
  existing `RTCPeerConnection`s — but the server had already broadcast `peer_left`, so anyone who
  joined or reloaded afterwards couldn't see that tab and vice versa. All it takes on a phone is a
  screen lock or a wifi→cellular hop. `MeetingContext` now tracks `activeRoomRef` and re-sends
  `join_room` on reconnect (falling back to `create_room` if the room was reaped and we're the host,
  matching the post-reload redial's rule), resetting peers and re-offering everyone.
- **`peer_joined` now discards any connection already held for that peer id.** Someone (re-)entering
  the room means the socket we were connected to is gone; reusing that `RTCPeerConnection` leaves both
  sides on a frozen tile. Previously this only worked because `peer_left` happened to arrive first.
- **Peers from `room_joined`/`room_created` get a tile immediately.** `registerPeerName` only *renames*
  an existing tile, so a peer whose media never arrived was completely invisible to the joiner while
  the joiner was visible to them. New `addPeers` in `useWebRTC` seeds "Connecting…" placeholders.
- **Remote tiles could sit paused forever.** `RemoteTile`/`ScreenTile` create their `<video>` only once
  a stream exists, then call `play()` once and swallow the rejection. A reloaded page holds no user
  activation and remote streams carry audio, so the autoplay policy can reject with `NotAllowedError`
  — leaving a black tile with live media arriving underneath (verified in headless; real devices with
  an active camera capture are usually exempt, so this is a robustness fix rather than the main cause).
  New `playWhenAllowed` retries on the next `pointerdown`/`keydown`, plus `onCanPlay`/`onPause` hooks.
- **Backend: `/ws` had no keepalive** (only `/chat-ws` did, added the session before). A socket that
  dies without a close frame blocked in `ReadMessage` forever, so the client stayed in its room as a
  ghost and the room never emptied. Mirrored the chat WS's ping/pong + read deadline
  (`sigPongWait`/`sigPingPeriod`). Also: relayed `offer`/`answer`/`ice_candidate` now carry
  `from_name`, which the client already read but the server never sent — without it a tile created
  from an offer fell back to a generic "Guest (…)" label for a known participant.
- Verified: `npx tsc --noEmit` clean, `go build` clean, `_verify_meeting_fixes.mjs` 20/20 and
  `_verify_reconnect_rejoin.mjs` (drop the guest's socket → host keeps them; host reload → both still
  visible; media `currentTime` advancing on both sides) — both against the throwaway `:3100`/`:8081`
  pair *and* against `https://meet.icebrkr.space` after deploying. Both suites now honour a `BASE` env
  var so the same script runs against either. Server keepalive confirmed live by opening a raw
  `wss://meet.icebrkr.space/ws` and observing the ping frame.

**2026-08-03 session** (deployed to production — frontend rsynced *and* backend rebuilt/restarted):
- **Ghost participants (backend, the big one).** `create_room` and `join_room` in `main.go` both set
  `client.room = room` without vacating the room the socket was already in, so the old room kept a
  stale `SigClient` forever: it never became empty (never reaped), and everyone still inside saw the
  departed user's name on a frozen blank tile. `create_room` also did `rooms[code] = room`
  unconditionally, orphaning everybody in a pre-existing room with that code. Both now call
  `leaveRoom(client)` first and reuse an existing room instead of clobbering it. Extracted `enterRoom`
  (registers the client, evicts a prior socket holding the same user id, returns peers excluding self).
- **Empty-room grace period.** `leaveRoom` no longer deletes an empty room immediately — it arms a
  90s `time.Timer` (`emptyRoomGrace`, `scheduleReap`/`cancelReapLocked`, `Room.reap` guarded by
  `roomsMu`). Without this, a *host* reloading destroys their own 1-person room before the redial
  lands. Lock order is always roomsMu → room.mu; `leaveRoom` also guards on
  `room.clients[client.id] == client` so a dying old socket can't evict the freshly-rejoined client
  or emit a bogus `peer_left`.
- **Reload no longer dumps you on the dashboard.** `DebriefView` only ever *prefilled* the code input
  from `autoJoinCode` — it never joined. Now `MeetingContext` persists `{roomId,isHost,title}` to
  sessionStorage (`ibconnect_active_meeting`, per-tab by design) and `App.tsx` redials it on mount via
  `rejoinMeeting`. Signed-in users opening a `/:roomCode` link also auto-join instead of landing on the
  Meetings page. **Watch the `rejoinState` machine** (`idle|pending|failed`): an earlier cut gated the
  "Rejoining…" screen on `rejoinTarget` alone, which outlives the meeting, so *leaving* a call wedged
  the app on the spinner forever. It must settle to `idle` on success.
- **Guest join by link** (`src/components/meeting/PreJoinScreen.tsx`): `/:roomCode` while signed out now
  shows a Meet-style lobby (camera preview + mic/cam pre-toggles + name field) instead of `LoginPage`.
  `/ws` never required auth, so this was purely a frontend gate. Guests render the bare
  `ActiveMeetingView` with no Sidebar/TopBar — the app shell assumes a `currentUser` (avatars,
  compliance-log actor) and `ChatContext` no-ops without one. The lobby's preview stream is its own
  `getUserMedia` call, stopped before `initMedia()` runs, because two live camera handles at once makes
  some webcams fail to open. `MeetingContext.nameRef` exists so a guest typing a name and joining in the
  same handler doesn't send the stale closure-captured name.
- **Tiling reworked toward LiveKit Meet.** Added a focus/spotlight layout with pinning: at most one
  thing on the main stage plus a carousel (right on `xl+`, bottom below that). Screen shares auto-focus;
  an explicit pin always wins so you can keep watching a person while someone presents. A pin pointing
  at a departed peer self-clears or it would wedge the stage on a dead id. Consolidated the tile chrome
  into one `ParticipantTile` (it was hand-rolled twice and had already drifted).
- **Tiles are now genuinely 16:9.** `computeTileSize` in `useGridLayout.ts` sizes each tile to
  `min(cellWidth, cellHeight * 16/9)` and the grid became a centered `flex-wrap` (which also centers a
  partially-filled last row, like Meet). Previously tiles stretched to fill the cell — two people on a
  1400x900 window got ~690x790 near-portrait boxes that `object-cover` cropped the sides off. This was
  the "tiling is improper/unfinished" complaint.
- Also fixed the screen-share spotlight overflowing its container on short windows (missing
  `grid-rows-1`, so the implicit `auto` row let the video's intrinsic height push past the flex box and
  overlap the camera strip + toolbar).
- **Testing infra**: `server/main.go` honours `PORT` and `vite.config.ts` honours `BACKEND_PORT`, so a
  throwaway backend+dev-server pair can be run alongside the live ones to exercise signaling changes
  without restarting production. `_verify_meeting_fixes.mjs` (repo root) is the reusable 20-check suite
  — reload-rejoin, ghost-tile absence, guest-link join, tile geometry at 3 viewports, pin/focus, and
  overlap detection. It passes against both `:3100` (throwaway) and `https://meet.icebrkr.space`.


**2026-07-29 session** (uncommitted as of this writing — nothing from this session has been `git commit`ed):
- Added `DashboardView` (new Home/landing view), `CommandPalette` (⌘K), `useTheme` hook + full light-mode
  CSS retrofit, `calendarLocal.ts`/`callsLocal.ts` (per-user localStorage persistence, extracted from
  inline code in the view components), `preferences.ts` (custom status + notification toggles, new
  Settings → Preferences tab), refactored chat "Intelligence Agent" extraction logic out of `ChatsView.tsx`
  into `lib/intelligence.ts`.
- Rewrote `CalendarView` with a real event CRUD modal, month/list view toggle, drag-and-drop event
  rescheduling (previously read-only).
- DB migration: moved from a remote hostpoint.ch MySQL instance to local MariaDB with a dedicated
  `ibconnect_app` user.
- Fixed two light-theme bugs surfaced by QA: (1) status-badge text colors invisible on white
  backgrounds (see Theming above), (2) `CalendarView`'s month grid had `content-start` on the day-cell
  grid, leaving a large dead-space rectangle below the 6 rows on tall viewports — changed to
  `content-start sm:content-stretch` so rows fill the available height like a normal calendar.
- Redesigned `Sidebar.tsx`: replaced the icon+9px-caption stacked nav items with an icon-only rail +
  hover tooltips, grouped primary/utility nav with a divider, softened the active-state style. Also
  fixed a real bug: the nav's `overflow-y-auto` (with no `overflow-x` set) was creating an invisible-but-
  functional horizontal scroll track, because per the CSS spec setting only one overflow axis forces the
  other to compute as `auto`, and the hover tooltips (wider than the 72px rail, `position: absolute`)
  overflowed horizontally. Fix was to drop `overflow-y-auto` entirely (the icon-only rail's content now
  comfortably fits any realistic viewport height, so scrolling was never actually needed). Rail width
  went from 72px → 76px; `App.tsx`'s `md:pl-[72px]` content offset was updated to match.
- Deployed all of the above to production (see Deployment steps above); verified live with zero console
  errors in a Playwright pass against the real domain.
- Known pre-existing bug found but **not** fixed (out of scope, predates this session, not in the diff):
  `SupportView.tsx`'s "Interactive Knowledge Base" header block has `overflow-hidden` on a container
  shorter than its content, clipping the heading/paragraph invisible in both themes.
- **Screen-share fix** (reported: "screenshare only half the screen is visible and own video also stops
  streaming"): both `LocalTile`/`RemoteTile` used `object-cover`, cropping wide screen captures to fill
  a square-ish grid cell; and the old design replaced the camera's outgoing video track with the screen
  track via `replaceTrack`, which stopped the presenter's camera for everyone (including their own
  preview) for the duration of the share. Rearchitected screen sharing onto its own parallel
  `RTCPeerConnection`s (see WebRTC section above) so the camera is never touched, and added a
  letterboxed (`object-contain`) spotlight tile for active screens with a small always-camera strip
  below it. Required a backend change: `SignalPayload` gained a `kind` field (opaque pass-through on
  `offer`/`answer`/`ice_candidate`) and a new `screen_share_state` broadcast case — backend rebuilt and
  `ibconnect-backend.service` restarted to pick it up. Verified end-to-end with two real accounts in two
  Playwright browser contexts and faked colored camera/screen streams (see Testing section) — confirmed
  both cameras keep playing throughout a share and the shared content arrives uncropped at full
  resolution on the remote side. Deployed to production (frontend rebuilt + redeployed, backend rebuilt
  + service restarted).
- Added a favicon (`public/favicon.svg` + PNG fallbacks at 16/32/180/512px, referenced in `index.html`)
  matching the in-app brand mark exactly — the lucide-react `Hexagon` icon's path data on a
  `#0066FF` rounded square, same as the sidebar's brand button. No image-generation tooling
  (imagemagick/rsvg/sharp) is installed in this environment; PNGs were rasterized by loading the SVG in
  a Playwright page sized to the target dimensions and screenshotting it — reuse that trick if icons
  need regenerating. **Superseded 2026-08-04 — see the brand mark entry below.**
- Added `MeetingInviteDialog` (`src/components/meeting/MeetingInviteDialog.tsx`): a floating "Your
  meeting is ready" card (not full-screen — the call stays visible/dimmed behind it, `absolute inset-0`
  inside `ActiveMeetingView`'s own portal, `z-[10000]`) shown automatically to the **host only**, once,
  right when `MeetingContext.createMeeting` resolves (new `showInviteDialog`/`dismissInviteDialog` on
  the context, reset on `leaveMeeting`) — a joiner via `joinMeeting` never sees it, verified with two
  real accounts in separate Playwright contexts. Link is `${location.origin}/${roomId}` (this app's
  actual `/:roomCode` route, not a `/meet/:id` path), copy button uses the Clipboard API with a ref-based
  timer guard so rapid re-clicks reset rather than stack the "Copied" state/toast, and clipboard failures
  are caught and swallowed rather than shown as a false success. "Joined as {email}" reads
  `useAuth().currentUser.email` directly and the whole section is omitted when there's no logged-in user
  (e.g. a guest). No in-call "add people" picker exists anywhere in the app — `onAddPeople` is a plain
  optional callback prop on the component (stays a clean placeholder), and `ActiveMeetingView` wires it
  to the closest real equivalent it has: closing the dialog and opening the existing People panel. The
  "anyone can join" vs "may need permission" copy is driven by an `anyoneCanJoin` prop (default `true`)
  since there's no lobby/approval feature in this app yet — flip that default the day one exists rather
  than editing the JSX.

**2026-08-02 session** (deployed to production):
- Rebuilt the call grid's tiling logic, inspired directly by Google Meet — see "Video tiling / grid
  layout" under WebRTC above for the full architecture. Summary: `selectGridLayout` (container-size +
  orientation aware, ported from `@livekit/components-react`'s real algorithm — fetched upstream source
  from `livekit/components-js` for reference) replaced the old tile-count-only breakpoint table;
  `useAudioLevels` adds a client-side active-speaker ring (mesh WebRTC has no SFU to compute this for
  us); `usePagination` pages tiles when a small container's picked layout can't hold everyone.
- Found and fixed the actual root cause of the "tiling is bad with multiple people" complaint: the right
  panel (`rightOpen` in `ActiveMeetingView`) defaulted **open** on any viewport >768px, which silently
  squeezed the video grid container down to a narrow near-square shape — so even 2 people on a spacious
  1400px desktop window rendered stacked vertically instead of side-by-side. Now defaults closed
  (Meet-style: full-width stage on join, panels opt-in via the toolbar toggle buttons, unchanged
  otherwise). Verified with two live Playwright WebRTC contexts: 2 tiles now correctly go side-by-side
  at 1400x900 and stack at narrow/portrait sizes.
- Found and fixed a second, more subtle bug while comparing against upstream LiveKit's actual
  `GridLayout.tsx`: `selectGridLayout` alone can pick a layout whose `maxTiles` is less than the real
  tile count on small containers (confirmed upstream has the exact same property — it's inherent to the
  algorithm, not a porting mistake), so without pagination extra tiles would have no grid cell to render
  into. Added `usePagination` + prev/next arrows + a dot indicator, verified end-to-end with 3 real
  Playwright peer contexts on a 390x800 viewport: page 1 correctly shows 2 tiles, page 2 shows the 3rd,
  nobody silently drops off.
- Corrected two stale doc inaccuracies found in the process (see Testing section above): the Testing
  approach section referenced a `POST /api/auth/signup` endpoint that does not exist in `main.go` — auth
  is OIDC-only; testing scripts mint JWTs directly for pre-existing seeded accounts instead.
- Type-checked (`tsc --noEmit`) and production-built (`npm run build`) clean. Deployed frontend to
  production (`rsync` to `/var/www/ibconnect`); no backend changes in this session, so
  `ibconnect-backend.service` was not restarted and no in-progress calls were affected.

**2026-08-12 (later), PUBLIC-REPO CREDENTIAL EXPOSURE — found, closed, DEPLOYED:**
While acting on "do what is best" I checked the git remote and found
`github.com/DhruvJyotiDas/IB-Connect-ver-2` is **`"visibility": "public"`**. Three live
credentials were readable in it. All are now rotated and both apps are deployed.
- **JWT signing key** (`origin/main:server/main.go:27`) — signed every session. Anyone could
  mint a token for any user id, no password, no OIDC. **This was an active auth bypass**, not a
  theoretical one: the same constant was used all session to mint valid tokens for real accounts.
- **MariaDB password** (`origin/main:server/main.go:1190`) — mitigated only by MariaDB binding to
  localhost, which stops mattering the moment anything else on the box is compromised.
- **TURN password** `webrtc123` (`origin/main:src/hooks/useWebRTC.ts:6`) — open relay for anyone.
- All three now come from `/etc/ibconnect/env` (600, backup `env.bak.20260812`); the backend
  **refuses to start** if any is missing. Old values verified dead: old DB password rejected by
  MariaDB, old TURN password rejected by coturn (`turnutils_uclient` → "Cannot complete
  Allocation", while the new one reaches channel-bind).
- **`git history still contains the old values forever` — rotation is what makes them harmless.**
  History rewriting was judged not worth the disruption. **Treat this repo as public.**
- Also closed: the Vite dev server serving uncompiled source over plain HTTP on `0.0.0.0:3000`
  for 14 days, and the backend listening on `0.0.0.0:8080` — directly reachable on the public IP,
  bypassing nginx and TLS. Now `127.0.0.1:8080` (`BIND_ADDR` overrides). Public listeners are now
  exactly 22, 80, 443, 3478, 5349.
- **`email-logo.png` gotcha permanently fixed** — moved into `public/`, so `rsync --delete` can no
  longer remove it. That workaround can be dropped from the deploy steps above.
- Deployed and verified **against production**: `_verify_multiparty_audio` 12/12 and
  `_verify_meeting_fixes` 20/20 before the TURN rotation, then 12/12 again after it.
- Gotcha worth keeping: `cp` onto a running binary fails with **"Text file busy"** and
  `systemctl restart` then silently re-launches the OLD binary. Caught it because
  `/api/turn-credentials` still 404'd. Always `stop` → replace → `start`, and verify with a
  request that only the new build can answer.

**2026-08-13, WebSocket session-expiry handling + connection diagnostics (DEPLOYED):**
Reported as "Firefox can't establish a connection to wss://…/chat-ws" plus an endless
`reconnecting…` loop. **Root cause: the 2026-08-12 JWT rotation invalidated live sessions, and
nothing in the stack could say so.**
- `handleChatWS` correctly returned 401 — but **the WebSocket API deliberately hides handshake
  status from JavaScript**, so the browser could only report a generic connection failure. A dead
  session was indistinguishable from an unreachable host.
- Both sockets then reconnected unconditionally every 3s **forever**
  (`signalingSocket.ts` + the chat socket in `api.ts`); grep for `401|unauthorized|sessionExpired`
  across both returned **zero hits**. This was never rotation-specific: `jwtExpiry` is 30 days, so
  every user would eventually hit it.
- **The single 401 that explained the whole incident existed ONLY in nginx's access log.**
- **Fix:** new `src/lib/diagnostics.ts`. On a non-intentional close both sockets call
  `classifyDisconnect()`, which probes `/api/auth/me` — where the status IS readable — and maps
  401/403 → `session-expired`, 5xx → `server-down`, else `network`. A dead session calls
  `reportSessionExpired()` (idempotent) → `AuthContext` clears the session and returns to sign-in
  **instead of reconnecting**. Genuine network faults now use exponential backoff with jitter
  (1s→30s) rather than a flat 3s forever.
- **Every connection event is now recorded**: a 300-entry ring buffer, dumpable in any browser via
  **`window.__ibDiag()`**, and shipped to `POST /api/client-events` which logs to the journal as
  `[Client] <user>@<ip> <cat>/<level> +Nms <event> {detail}`. Server side also logs
  `[ChatWS] AUTH REJECTED … expired | bad signature (key rotated?) | missing token`, and signaling
  connect/disconnect now carry IP, user-agent, duration and room.
- **Use `sendBeacon`, not `fetch`, for the flush.** A periodic fetch still in flight at page
  teardown surfaces as `net::ERR_ABORTED` — telemetry manufacturing the exact false signal this
  module exists to remove. Caught by `_verify_multiparty_audio` dropping to 11/12. sendBeacon can't
  set headers, so the token rides in the body and the server falls back to it.
- **Testing lesson worth keeping.** The first version of `_verify_session_expiry.mjs` set a stale
  token *at page load* — and passed locally but failed 3 checks on production. Not flaky: on
  production `AuthContext`'s mount-time `/api/auth/me` check wins the race and cleans up first, so
  the socket close is marked `intentional` and classification never runs. Correct behaviour, wrong
  assertion. **That was also not the reported scenario** — the user's page was already open and
  authenticated, so no mount-time check ever re-ran. The suite now reproduces the real thing:
  authenticate with a good token, swap localStorage to a stale one *without reloading*, sever the
  live socket via the `window.__sockets` trick, and assert on the reconnect. **10/10 against
  production.** A test that passes for the wrong reason is worse than no test.
- Also verified: `_verify_multiparty_audio` 12/12 and `_verify_meeting_fixes` 20/20 on production.

**2026-08-13, Virtual Interview — BUILT AND DEPLOYED (model not yet connected):**
CV upload → parsing → GitHub enrichment → AI mock interview → scored report. The model
(`Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit`) runs on a **separate GPU VM that does not exist yet**, so
this was built against a documented contract with a local mock — see `INTERVIEW_PLAN.md` and
`gpu/CONTRACT.md`.
- **Live now:** sidebar entry, CV upload, PDF/DOCX/text parsing, link + skill extraction, live
  GitHub enrichment, session history. **`/api/interview/status` reports `configured:false`** and the
  UI shows "AI interviewer not connected yet" instead of failing obscurely.
- **To connect the GPU box:** set `INTERVIEW_GPU_URL` + `INTERVIEW_GPU_TOKEN` in
  `/etc/ibconnect/env` and restart. Nothing else changes — implement `gpu/interview_server.py`
  against `gpu/CONTRACT.md` on that machine and it drops in.
- **No media in the database, by design.** Answer audio and JPEG frames go browser → Go → GPU →
  discarded; only transcripts and scores persist. `_verify_interview.mjs` fails if any audio or
  frame data appears in a stored session. Verified in production: **0 media-ish columns** across the
  four new tables.
- **No media containers anywhere.** Answers are 16 kHz mono WAV encoded in the browser plus sampled
  JPEG stills, because neither this box nor the GPU box has `ffmpeg`. Same PCM approach as
  `useSpeechTranscription.ts`.
- **LinkedIn is linked, never scraped** (no public API, blocked, ToS). GitHub is enriched for real.
- Interviewer voice uses the browser's `SpeechSynthesis`; `/v1/speak` exists in the contract and
  answers `501` until Qwen3-Omni's Talker is available. Swappable with no UI change.
- Verified: `_verify_interview.mjs` **17/17** against the mock, `_verify_interview_prod.mjs` **9/9**
  against production (honest-degradation path), `_verify_multiparty_audio` **12/12** post-deploy.
- **GOTCHA THAT BIT ME:** the throwaway test backend shares the PRODUCTION database, so building
  against it wrote real rows into `interview_*`. Found 3 test profiles/sessions in production after
  deploying and deleted them (`user-815ce7061367244d` / uitest1). **Check for test data before and
  after any feature that writes new tables** — see `DEFERRED.md` B7 for why staging matters.
