# IB Connect

Secure messaging / video calling / calendar web app. React + Go, deployed at **https://meet.icebrkr.space**.

## Stack

- **Frontend**: React 19 + TypeScript, Vite 6, Tailwind CSS v4 (`@tailwindcss/vite`, arbitrary-value utility classes like `bg-[#1c1b1b]` rather than a theme config — see Theming below), `lucide-react` icons, `motion` for animation.
- **Backend**: Go (`server/main.go`) — REST API + WebSocket signaling/chat, JWT auth, MariaDB via `go-sql-driver/mysql`.
- **DB**: MariaDB 10.11, local (`127.0.0.1:3306`, db `lolafire_IBConnect`, user `ibconnect_app`). Migrated off a remote hostpoint.ch DB during this session's work — `main.go`'s `migrate()` uses `CREATE TABLE IF NOT EXISTS`, so it will **not** retroactively alter columns on tables that already exist (e.g. an `avatar TEXT`→`LONGTEXT` widening won't apply to a pre-existing table without a manual `ALTER TABLE`).
- **ASR**: separate Python Whisper transcription server (`server/transcription_server.py`), systemd service `ibconnect-transcription.service`, proxied at `/asr` (port 8765).
- **WebRTC**: TURN server at `meet.icebrkr.space` (user `webrtc` — see `src/hooks/useWebRTC.ts`).

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
  hooks/            useWebRTC.ts, useTheme.ts
  lib/              api.ts (REST client), signalingSocket.ts, calendarLocal.ts, callsLocal.ts,
                     intelligence.ts (chat message → meeting/deadline/action extraction, regex-based),
                     preferences.ts (per-user localStorage: status, notification prefs)
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
- `ibconnect-transcription.service` — ASR.
Both managed via systemd; `sudo systemctl status/restart ibconnect-backend`.

## Deployment (frontend)

The live site is **static files**, not the Vite dev server. nginx (`/etc/nginx/sites-enabled/ibconnect`)
serves `/var/www/ibconnect` (root) and reverse-proxies `/api`, `/health`, `/ws`, `/chat-ws`, `/asr` to
the Go backend on :8080 (and ASR on :8765). To ship a frontend change:

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
`payload.to`'s socket with the sender's id attached; it does not parse SDP. Any new WS message type
must be added to the `switch` in `handleSignaling` or it's silently dropped.

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
need independent `localStorage`/auth) logged in as two different real accounts (sign up a throwaway one
via `POST /api/auth/signup`), have one start a meeting and read the room code from the DOM, have the
other log in and join via the in-app "Join a Meeting" code input on the Meetings/`DebriefView` page —
there is no working anonymous-guest deep-link flow for an unauthenticated Playwright context (`/{code}`
without a session lands on `LoginPage`, which requires signup/signin, not a guest-name shortcut). Feed
each fake camera a distinct solid color and sample pixels off a `<video>` via an offscreen canvas
(`drawImage` + `getImageData`) on the other side to verify tracks actually arrive and decode, and check
`video.currentTime` advances over a wait to prove a stream isn't just present but actively still
playing (not frozen).

## Recent work log

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
  need regenerating.
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
