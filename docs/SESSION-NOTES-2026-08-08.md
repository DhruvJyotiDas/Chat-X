# IB Connect — session notes, 2026-08-08

Everything done in this session: what changed, why, what was verified, what was **not**, and what's
still open. Deep architectural detail lives in `CLAUDE.md`; this file is the session record.

**All six changes below are deployed to https://meet.icebrkr.space.**
Live bundle at time of writing: `index-CF5w0l2H.js`.

---

## Contents

1. [Deployment state](#1-deployment-state)
2. [Audio transcription turned off](#2-audio-transcription-turned-off)
3. [Chat: wrong name/avatar in DMs](#3-chat-wrong-nameavatar-in-dms)
4. [Chat: images render inline](#4-chat-images-render-inline)
5. [Image lightbox + a modal z-index bug](#5-image-lightbox--a-modal-z-index-bug)
6. [Document preview](#6-document-preview)
7. [Floating (minimised) call](#7-floating-minimised-call)
8. [Back-to-app button + nginx cache headers](#8-back-to-app-button--nginx-cache-headers)
9. [Verification scripts](#9-verification-scripts)
10. [Known limitations / NOT verified](#10-known-limitations--not-verified)
11. [Open items](#11-open-items)
12. [Gotchas worth remembering](#12-gotchas-worth-remembering)

---

## 1. Deployment state

| Change | Frontend | Backend | Other |
|---|---|---|---|
| Transcription off | deployed | — | `ibconnect-transcription.service` stopped + disabled |
| DM name/avatar fix | deployed | **rebuilt + restarted** | — |
| Inline images | deployed | — | — |
| Image lightbox + z-index | deployed | — | — |
| Document preview | deployed | — | — |
| Floating call | deployed | — | — |
| Back button | deployed | — | **nginx reloaded** (cache headers) |

The backend was rebuilt/restarted exactly once (for the DM fix). Every other deploy was a static
rsync with no call disruption. Services confirmed `active` after each.

### Deploy procedure actually used

```bash
npm run build
# ALWAYS diff first — see the email-logo.png trap in §12
comm -23 <(sudo find /var/www/ibconnect -type f | sed 's|/var/www/ibconnect/||' | sort) \
         <(find dist -type f | sed 's|^dist/||' | sort)
sudo rsync -a --delete dist/ /var/www/ibconnect/
sudo cp <backup>/email-logo.png /var/www/ibconnect/email-logo.png   # see §12
sudo chown -R www-data:www-data /var/www/ibconnect
curl -s https://meet.icebrkr.space/ | grep -o 'index-[^"]*\.js'      # must match dist/assets
```

Backend (only when `server/main.go` changes — **drops calls in progress**):

```bash
cd server && /usr/local/go/bin/go build -o ibconnect-backend .
sudo systemctl restart ibconnect-backend
```

---

## 2. Audio transcription turned off

**Why:** the Whisper pipeline is correct but runs at ~27x real time on this CPU-only box, so live
transcription never produced output — the panel just sat empty with no indication it had fallen
behind.

**Changed**

- New `src/lib/features.ts` — a single `TRANSCRIPTION_ENABLED` flag, default `false`.
  Build with `VITE_ENABLE_TRANSCRIPTION=true` to restore it with no code change.
- `useSpeechTranscription.start()` short-circuits on the flag, so no mic handle and no `/asr`
  socket can open even if something calls it. `isSupported` reports `false`.
- `ActiveMeetingView` drops all four entry points: desktop "Live Transcript" sidebar, the
  Transcript tab, the `lg:hidden` toolbar button, both Transcribe buttons.
- `ibconnect-transcription.service` **stopped and disabled** — it was holding 7.7 GB resident.
  Restore with `sudo systemctl enable --now ibconnect-transcription`.

**Knock-on that mattered:** the desktop transcript sidebar also owned the **room code, Copy-code and
Copy-join-link** controls. Hiding it would have removed the only way to share a meeting from
desktop, so those moved onto the floating code badge over the stage, which is now visible at all
widths (it was `lg:hidden`). If transcription is ever re-enabled, the badge reverts to `lg:hidden`
and the sidebar takes the controls back — **both branches are in the same JSX, keep them in sync.**

The panel was dropped rather than left in place empty on purpose: a near-empty 288px column squeezes
the video grid, which is the documented root cause of an earlier "tiling looks bad" complaint.

**Left alone:** `/asr` proxy entries in `vite.config.ts` and nginx (so re-enabling is a one-line
flip; `/asr` 502s until the service is started again, and nothing calls it), and the
transcript-related *policy copy* in `SecurityView.tsx` / `data.ts`.

**Verified:** 18/18 at 1400x900 and 390x844, local and production.

---

## 3. Chat: wrong name/avatar in DMs

**Reported as:** "the other person's name is shown wrong, instead it shows my image".

**Root cause — `loadThread` in `server/main.go`.** It takes a `forUID` but used it *only* for the
unread count: `t.Name` / `t.Avatar` came straight off the `threads` row. A DM row is stamped at
creation time with **the other participant as the creator saw them**. So the creator saw the right
person and **the recipient saw themselves**.

Confirmed in live data:

| DM thread | created by | stored name |
|---|---|---|
| dhruv ↔ Priyanshu grover | Priyanshu grover | `dhruv` |
| Ridh saha ↔ Admin | Admin | `Ridh saha` |

Before/after on the same DM:

```
:8080 (old)     creator uitest1 → "Second Tester"   recipient uitest2 → "Second Tester"   ← wrong
:8081 (patched) creator uitest1 → "Second Tester"   recipient uitest2 → "UI Test User"    ← right
```

**Fixed:** `loadThread` resolves the counterpart live per viewer for `type='dm'`. Side benefit: DM
titles now track display-name/avatar changes instead of freezing at creation.

**No migration needed** — the stored `threads.name`/`avatar` columns are simply ignored for DMs now.
They're still written on create (harmless), and group threads still use them.

**Frontend belt-and-braces:** `ChatsView` gained `getThreadDisplay()`, which prefers the resolved
participant for DM name/avatar in the list, the header and the search filter. Keeps the UI right
against a stale cached thread or an unpatched backend. **If you change one, change both.**

---

## 4. Chat: images render inline

Every `fileAttachment` went through the same `FileText` + `Download` card regardless of type.

New `MessageAttachment` renders `image/*` inline; everything else keeps the card.

- Type detection falls back from `file.type` → sniffing the `data:` URL → file extension, because
  some Android pickers hand back an empty MIME type.
- `onError` falls back to the card, so a truncated data URL is still downloadable rather than an
  empty box.

**Storage note:** attachments are data URLs in `messages.file_data` (`LONGTEXT` live, verified). The
5 MB client cap in `handleFileAttach` matters — MariaDB's `max_allowed_packet` is 16 MB and base64
inflates ~1.37x, so raising that cap much past ~11 MB will start failing inserts.

**Verified:** 13/13 local and production.

---

## 5. Image lightbox + a modal z-index bug

Clicking an image used to be an `<a target="_blank">` to the data URL, which navigated away from the
chat. It now opens a contained preview box (512px desktop / 358px at 390px wide), image capped at
`max-h-[60vh]`, closable via ✕ / Escape / backdrop, with **Share and Download on the box**.

**Share** uses the Web Share API with a real `File` (`fetch` on the data URL → blob → `File`), giving
a genuine share sheet on mobile. Desktop browsers largely can't share files, so it falls back to
writing the image to the clipboard (Chrome only accepts `image/png` there — hence the try/catch),
then to a transient "Use Download" label. `AbortError` means the user dismissed the sheet and is
deliberately **not** treated as a failure.

### The z-index bug found while testing

The first run failed on "clicking the backdrop closes the preview". The screenshot showed why:
**every modal in the app rendered *under* the sidebar.** Modals were `z-50`; the sidebar rail is
`z-[70]`, its mobile drawer backdrop `z-[65]`, the hamburger `z-[80]`. The left 76px stayed undimmed
and clicks there hit the sidebar instead of the modal backdrop.

Chat-flow modals raised to `z-[90]` — above the chrome, below `CommandPalette` (`z-[100]`) and
`IncomingCallModal` (`z-[99999]`), so an incoming call still surfaces over an open modal.
Covers: image preview, NewDM, NewGroup, `UserProfileModal`.

**Still unfixed, same defect:** `SettingsModal.tsx:426` and `CalendarView.tsx:46` are both `z-50`.

---

## 6. Document preview

`ImagePreviewModal` → `AttachmentPreviewModal`, body chosen by type:

| Type | Body | Box |
|---|---|---|
| Images | `<img>` | `max-w-lg` |
| PDF | iframe, `h-[70vh]` | `max-w-3xl` |
| Text-ish (`.txt .md .csv .json .log .xml .yaml .sql` + code) | scrollable `<pre>`, wraps long tokens, truncated at 200 000 chars | `max-w-2xl` |
| Anything else (`.docx .xlsx .zip`) | "No inline preview — download it to open" | `max-w-lg` |

Share/Download are on the box in every case, including the unsupported one, so a click never appears
to do nothing. The file card's *body* opens the preview; its download button stays put so "just save
it" is one click.

**Security decisions, deliberate:**

- PDFs need a **`blob:` URL** — Chrome refuses `data:` in an iframe. Revoked on unmount.
- **HTML/SVG documents are shown as escaped text, never iframed.** Attachments come from other users
  and a `blob:` URL inherits this origin, so iframing their markup would run their script against
  the session. Only PDFs get a frame, because the browser hands those to its own sandboxed viewer.

**`PdfPreviewBody` gates on `navigator.pdfViewerEnabled`** — without it the iframe renders as a
silent blank rectangle in any browser lacking a PDF viewer. See §10.

---

## 7. Floating (minimised) call

Meet/WhatsApp-style picture-in-picture. A **Minimise call** button drops you back into the app with
the call running in a small draggable window (`src/components/meeting/FloatingCallWindow.tsx`).

This works at all only because **`useWebRTC` lives in `MeetingContext`, not in `ActiveMeetingView`** —
minimising unmounts the call screen but every `RTCPeerConnection` and `MediaStream` is untouched.
**Do not move the WebRTC hook into a view component.**

### The load-bearing detail: remote audio

On the full screen, each peer's audio comes out of *that peer's* `<video>` element — and those
unmount with `ActiveMeetingView`. The floating window shows exactly one tile, so routing audio
through it would mute everyone else the moment you minimise a 3-way call.

`FloatingCallWindow` therefore renders one hidden `<audio>` **per peer** (`PeerAudio`) and keeps the
visible `<video muted>`. Verified with three real peers: 2 audio elements, both attached/unmuted/
playing, and dropping one peer retires exactly one element.

### Wiring

- `MeetingContext`: `isMinimized` / `minimizeMeeting()` / `expandMeeting()`, reset to expanded on
  join/create/leave so entering a room always lands on the full screen.
- `App.tsx`: `effectiveView` is `active_meeting` only when `isInMeeting && !isMinimized`, with a
  guard mapping a stale `active_meeting` currentView back to `viewBeforeMeetingRef` — otherwise the
  call screen re-opens *behind* the floating window. `viewBeforeMeetingRef` is why minimising
  returns you to whatever page you were on rather than a default.
- **Guests get no minimise button** — `onMinimize` is optional and App only passes it on the
  signed-in path. A guest has no app to go back to.
- Drag uses pointer capture, clamped into the viewport on drag *and* on resize/rotate; a tap without
  movement expands. 232px wide desktop / 150px under 640px. `z-[95]`.

---

## 8. Back-to-app button + nginx cache headers

**Reported as:** "I cannot see the back button for going from calls to main IB Connect platform."

The button existed and was on-screen at every width from 1400 down to 320 — it was just **the sixth
unlabelled grey circle in a row of seven**, its only label a `title` tooltip, which does not exist on
touch. Same failure mode `CLAUDE.md` already documents for group chat: discoverability, not function.

- Added a labelled **"← IB Connect"** button top-left of the call screen, next to the room-code
  badge. The toolbar glyph stays; both call `onMinimize`.
- `CtrlBtn` now mirrors `title` into `aria-label`, so *every* in-call control is finally named for
  screen readers and touch, not just on hover.

### nginx caching (real, separate bug)

`index.html` was served with **no `Cache-Control` at all**. It is the only thing pointing at the
hashed bundle, so a browser holding a cached copy stays pinned to an old deploy — a plausible reason
a shipped change appears missing.

```nginx
location = /index.html {
    add_header Cache-Control "no-cache, must-revalidate";
}
location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
location / {
    try_files $uri /index.html;
}
```

Original config backed up to `ops/nginx-ibconnect.conf.before-cache-headers`. `nginx -t` clean,
**reloaded not restarted** (no connections dropped), SPA deep-link fallback re-checked
(`/ABCD-1234` → 200), and both header values confirmed live.

---

## 9. Verification scripts

Copied into the repo root (they were in an ephemeral scratchpad; two were lost mid-session to an
aborted cleanup chain and had to be rewritten). All follow the existing `_verify_*.mjs` convention
and honour `BASE`:

```bash
BASE=https://meet.icebrkr.space node _verify_floating_call.mjs
```

| Script | Covers | Result |
|---|---|---|
| `_verify_transcription_off.mjs` | no transcript UI, room code + copy controls survive, `/asr` never opened | 18/18 |
| `_verify_chat_fixes.mjs` | DM name both directions, counterpart avatar, inline image, `.txt` stays a card | 13/13 |
| `_verify_image_preview.mjs` | lightbox opens in place, no new tab, Share/Download/Close, 3 close paths | 19/19 |
| `_verify_doc_preview.mjs` | PDF / text / CSV / unsupported bodies, card download vs preview | 19/19 |
| `_verify_floating_call.mjs` | 2-peer: media survives minimise, navigation, drag, expand, leave | 26/26 |
| `_verify_floating_call_3way.mjs` | 3-peer: per-peer audio, peer-leave retires one element | 8/8 |

`_verify_doc_preview.mjs` needs fixtures (`FIXTURES` env var, default `/tmp/ibconnect-fixtures`):
`test-image.png` (any real image), `test-notes.txt` (must contain `Quarterly notes`),
`test-sheet.csv` (must contain `Dhruv,Founder,Zurich`), `test-report.docx` (any zip renamed), and
`test-doc.pdf`. Pillow **cannot** write the PDF here (no JPEG encoder — `KeyError: 'JPEG'`); a
hand-built minimal PDF works fine.

**All test data written during verification was cleaned up** — attachment messages deleted from the
`uitest1`/`uitest2` DM and the temporary `uitest1` avatar reverted to `NULL`, both confirmed at zero.

---

## 10. Known limitations / NOT verified

Three things are **explicitly unproven**. Don't read the green check counts as covering them.

1. **PDF rendering.** Nothing in this environment can render a PDF — headless Chromium reports
   `navigator.pdfViewerEnabled: false` with 0 plugins. A first run "passed" on an assertion that an
   iframe existed, over a blank rectangle; that's what prompted the `pdfViewerEnabled` gate. **The
   fallback path is verified; the rendering path is not.** Open a PDF in a real browser to confirm.
2. **Mobile share sheet.** Headless has no `navigator.share` for files, so only the graceful
   degradation is proven, not the real share sheet.
3. **Screen sharing in the floating window.** The floating window shows a camera tile only. A share
   keeps running and reappears on expand, but it is not displayed in the 232px box.

---

## 11. Open items

- [ ] `SettingsModal.tsx:426` and `CalendarView.tsx:46` still render under the sidebar (`z-50`) —
      one-token fix each, left alone as out of scope.
- [ ] Screen share not shown in the floating call window.
- [ ] Confirm PDF preview and the mobile share sheet by hand (§10).
- [ ] **Everything this session is uncommitted.** The tree also carries unrelated work from
      2026-08-03/04 that shipped in this session's first deploy.
- [ ] Move `email-logo.png` into `public/` so the deploy stops depending on a manual restore (§12).

---

## 12. Gotchas worth remembering

**`rsync --delete` deletes `email-logo.png`.** It lives only on the server — it is *not* in
`public/`, so it is *not* in `dist/` — and it is hotlinked by already-sent transactional emails. It
was backed up and restored by hand on every deploy this session. Diff the live file list against
`dist/` before any `--delete` rsync, or move the asset into `public/`.

**`ChatsView` renders its mobile (`lg:hidden`) and desktop branches both into the DOM**, so every
message element exists twice. Selectors need `:visible` or a count of 2. The thread-list preview
`<p class="text-[10px]">` also contains the attachment filename, which will false-positive a naive
"is it a file card" check — the card's name is `p.text-xs.font-semibold`.

**The Bash working directory persists between commands.** A `cd server` in one step left a later
`vite` invocation serving from `server/`, which has no `index.html` — it 404'd on `/` and looked like
a broken dev server.

**A failing command in a `&&`/`;` chain can silently skip later steps.** A `pkill` returning a
non-zero status aborted a cleanup chain before its archive step, losing two verification scripts that
were deleted in the next command. Archive first, kill afterwards.

**Don't assert presence when you mean behaviour.** "An iframe exists with non-zero size" passed over
a blank PDF viewer. Prefer decoded dimensions, advancing `currentTime`, `paused === false`, and
actual text content.
