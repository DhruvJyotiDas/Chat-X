# Virtual Interview — build plan

Written 2026-08-13. Feature: upload a CV, have it enriched from public sources,
sit an AI-run video interview, get scored feedback. Model is
`cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit`, **running on a separate GPU VM**.

**This VM hosts only the UI, the Go backend and MariaDB.** No model, no GPU work,
no media transcoding. The GPU box is reached over a narrow HTTP contract.

---

## 0. The decision that shapes everything else

**Define the GPU contract first and build a mock that implements it**, so the UI,
the CV pipeline, the database and the whole user journey can be finished and
verified *before the GPU machine exists*. Roughly 5 of the ~8 days of work need no
GPU at all.

Without this, every hour of frontend work is blocked on hardware procurement.

---

## 1. Split of responsibilities

| | This VM (`meet.icebrkr.space`) | GPU VM |
|---|---|---|
| React UI | ✅ | — |
| Go API, sessions, auth | ✅ | — |
| MariaDB (profiles, scores, transcripts) | ✅ | — |
| CV parsing (PDF/DOCX/TXT) | ✅ | — |
| GitHub enrichment | ✅ | — |
| Question generation | — | ✅ |
| Speech→text | — | ✅ |
| Answer scoring | — | ✅ |
| Text→speech (interviewer voice) | — | ✅ |

The Go backend is the **only** thing that talks to the GPU box. The browser never
does — that keeps the GPU token server-side and lets us rate-limit centrally.

---

## 2. Media format: no containers, anywhere

**Hard constraint, already verified: there is no `ffmpeg` on this box**, and the
GPU box should not need one either. So nothing in this feature ships a webm/mp4
container.

- **Audio** — Web Audio API captures 16 kHz mono Float32 PCM, the browser encodes
  a WAV header, base64. Reuses the exact pipeline proven in
  `useSpeechTranscription.ts`. 90 s ≈ 2.9 MB.
- **Video** — `canvas.drawImage` samples JPEG stills off the camera, ~1 per 5 s,
  max 6 per answer (~300 KB). Enough for delivery/presence signal; no demuxing.

Qwen3-Omni ingests WAV and images natively, so both sides stay free of media
tooling. This is also why we are *not* shipping full video: a 90 s webm would need
decoding on the GPU side and buys little over frames plus clean audio.

## 3. Media is never written to MariaDB

`DEFERRED.md` B5 already documents why: chat attachments are base64 in `LONGTEXT`
against a 16 MB `max_allowed_packet`, which is why the file cap can't move past
~11 MB. Interview audio is an order of magnitude larger.

**Flow:** browser → Go → GPU → discarded. The database stores only transcript
text, scores and feedback. Letting a candidate re-listen to their answers is a
later feature that needs object storage (B5), not a reason to put audio in the DB
now.

---

## 4. Reuse rather than rebuild

Several pieces built earlier in this codebase land directly:

| Existing | Used for |
|---|---|
| `src/lib/mediaErrors.ts` | Camera/mic failure taxonomy — denied vs busy vs missing |
| `src/lib/diagnostics.ts` | Every interview event logged + shipped to `/api/client-events` |
| `initMedia(prefs)` in `useWebRTC.ts` | Acquiring camera/mic with the lobby's choices applied |
| `playWhenAllowed` in `ActiveMeetingView` | Autoplay of the interviewer's spoken question |
| `PreJoinScreen.tsx` | Pattern for the device-check screen |
| `mustEnv()` in `main.go` | GPU token from environment, never from source |

A failed interview must be as diagnosable as a failed call — same `diag()` calls,
same journal, same `window.__ibDiag()`.

---

## 5. The GPU contract

`gpu/CONTRACT.md` is the source of truth; both the mock and the real service
implement it. Auth on every call: `Authorization: Bearer $INTERVIEW_GPU_TOKEN`.

```
GET  /healthz        → {status:"ready"|"loading", model, vram_used_mb}
POST /v1/plan        {profile, role, seniority, kind, count} → {questions:[…]}
POST /v1/transcribe  {audio_wav_b64}                         → {text}
POST /v1/evaluate    {question, transcript, audio_wav_b64?, frames_b64[]?}
                                                             → {scores{}, strengths[], improvements[], feedback}
POST /v1/report      {role, seniority, answers[]}            → {overall, verdict, summary, …}
POST /v1/speak       {text, voice}                           → {audio_wav_b64}
```

**Why a thin FastAPI wrapper instead of pointing Go at vLLM's OpenAI endpoint:**

1. Qwen3-Omni's speech output (the *Talker*) is not exposed through vLLM's
   OpenAI-compatible API. `/v1/speak` needs the wrapper regardless.
2. Prompts and the scoring rubric stay versioned in this repo, not baked into a
   serving config.
3. Go talks one stable contract whether the GPU side runs vLLM, transformers, or
   is swapped for a hosted API later.

---

## 6. Data model

```
interview_profiles   id, user_id, file_name, full_name, email, phone, headline,
                     location, summary, skills JSON, links JSON, github JSON, created_at
interview_sessions   id, user_id, profile_id, role, seniority, kind, status,
                     overall_score, report JSON, created_at, completed_at
interview_questions  id, session_id, idx, text, category, rationale, expected_points JSON
interview_answers    id, session_id, question_id, transcript TEXT, duration_sec,
                     scores JSON, strengths JSON, improvements JSON, feedback TEXT, answered_at
```

No media columns anywhere — see §3. Written via `migrate()` in `main.go`, which
uses `CREATE TABLE IF NOT EXISTS`; **note it will not retro-alter existing
tables**, so get the columns right first time or write an explicit `ALTER`.

---

## 7. Phases

### Phase 0 — Contract + mock · ~0.5 day · no GPU
`gpu/CONTRACT.md`, `gpu/mock_server.py` (deterministic canned responses),
`server/interview_gpu.go` (typed client: timeouts, bounded retries, health
gating, clear errors when the GPU is unreachable).

### Phase 1 — CV pipeline · ~1.5 days · no GPU
- PDF via `github.com/ledongthuc/pdf` (pure Go, module fetch already verified);
  DOCX via stdlib `archive/zip` + `encoding/xml`; TXT/MD direct.
- Extract links/handles (LinkedIn, GitHub, portfolio, X, …), email, phone, skills.
- **GitHub public REST enrichment** — repos, languages, stars, followers. Cached
  per handle; handles the 60 req/hr unauthenticated limit explicitly.
- **LinkedIn is detected and displayed, never scraped** — no public API, actively
  blocked, ToS. This was settled at the start: parse the link, don't fetch it.
- `POST /api/interview/cv` → parsed profile.

### Phase 2 — UI · ~3 days · against the mock
- `AppView 'interview'` + Sidebar entry + CommandPalette. **Adding to `AppView`
  requires updating `TopBar.tsx`'s `Record<AppView, …>` or the build breaks** —
  this bit once already.
- Five stages: Upload → Profile review & configure → Device check → Live
  interview → Report. Plus session history.
- `useInterviewRecorder` hook — WAV encoding + frame sampling (§2).
- Live screen: self-view, interviewer panel, question text + spoken audio,
  per-question timer, submit/skip, progress.
- Must survive 320 px; new hex colours need light-mode overrides in `index.css`.

### Phase 3 — GPU service · ~2 days · on the GPU box
FastAPI + Qwen3-Omni, systemd unit, readiness endpoint that reports `loading`
until weights are resident, prompt + rubric implementation, deploy script.

### Phase 4 — Integration & tuning · ~2 days
Swap mock → real, tune prompts against real CVs, `_verify_interview.mjs`
end-to-end suite following the existing `_verify_*.mjs` conventions.

### Phase 5 — Hardening · ~1 day
Per-user rate limits, retention policy enforcement, GPU-down degradation,
diagnostics review.

**≈ 8–9 working days, ~5 of them with no GPU dependency.**

---

## 8. Risks

**The Talker (speech output) is the biggest technical unknown.** vLLM's Qwen3-Omni
support has historically covered the Thinker (text) only; speech generation needs
the transformers path, which is slower and heavier. **Fallback if it doesn't
work:** interviewer question as text, spoken with the browser's built-in
`SpeechSynthesis`. Costs nothing, removes the dependency, and is a v1-acceptable
experience. Decide this early — it changes GPU sizing.

**GPU sizing (estimate, needs confirming against the real checkpoint):** 30B MoE
at 4-bit ≈ 17–20 GB of weights, plus vision/audio encoders, Talker and KV cache →
**realistically 40–48 GB VRAM**. One L40S / A6000 48 GB comfortably; A100 40 GB
tight. Model load is minutes, so the readiness endpoint is not optional.

**Cold start and latency.** A 30B model answering per question is seconds, not
milliseconds. The UI must show honest progress, never a frozen screen — the same
mistake the ASR feature made, where a silent 27×-real-time pipeline looked like
nothing was happening.

**Network between the two VMs.** The GPU box must **not** be publicly reachable.
Preference: private network or WireGuard. Minimum acceptable: TLS + strong bearer
token + IP allowlist. Note `ufw` on this box is still inactive (`DEFERRED.md` A6).

**PII.** Parsed CVs contain name, email, phone, sometimes address. This is the
most sensitive data the product will hold. Retention must be a deliberate choice,
and the repo is public — nothing about a real candidate goes in it.

---

## 9. Open questions — needed before Phase 3

1. **GPU VM**: does it exist, what card, and how do the two boxes network?
2. **Interviewer voice**: real Qwen3-Omni speech, or text + browser TTS for v1?
   (Directly changes GPU sizing and Phase 3 scope.)
3. **CV retention**: how long do we keep parsed CV data, and can a user delete it?
4. **Usage limits**: interviews per user per day — GPU time is the real cost.

---

## STATUS — 2026-08-13: Phases 0–2 COMPLETE, verified against the mock

Everything except the model is built and passing **17/17** end-to-end through the
real UI (`_verify_interview.mjs`).

| Phase | State |
|---|---|
| 0 · Contract + mock + Go client | ✅ `gpu/CONTRACT.md`, `gpu/mock_server.py`, `server/interview_gpu.go` |
| 1 · CV parsing + GitHub | ✅ `server/interview_cv.go`, `server/interview_github.go` |
| 2a · Schema + REST API | ✅ `server/interview.go` — 4 tables, 8 endpoints |
| 2b · Recorder + UI | ✅ `useInterviewRecorder.ts`, `InterviewView.tsx` |
| 3 · GPU service | ⏳ **needs the GPU VM** |
| 4 · Integration + tuning | ⏳ after Phase 3 |

### To connect the real GPU VM — this is the whole job

```bash
# /etc/ibconnect/env  (chmod 600, never in the repo — it is public)
INTERVIEW_GPU_URL=http://<gpu-vm>:8000
INTERVIEW_GPU_TOKEN=<shared secret>
```
then `systemctl restart ibconnect-backend`. Nothing else changes: the UI, the
database and every endpoint already speak the contract. Implement
`gpu/interview_server.py` against `gpu/CONTRACT.md` on the GPU box and it drops in.

**Until then the feature degrades honestly** — CV upload, parsing, GitHub
enrichment and history all work; the UI shows *"AI interviewer not connected
yet"* rather than failing obscurely.

### Decisions taken while building

- **Browser speech for the interviewer's voice.** `/v1/speak` exists in the
  contract and currently answers `501`; the UI uses `SpeechSynthesis`. This
  removes the dependency on Qwen3-Omni's Talker (not exposed via vLLM) and can be
  swapped to real model audio with no UI change.
- **No media in the database.** Answer audio and frames go browser → Go → GPU →
  discarded. Verified by a test that fails if any audio or frame data appears in
  a stored session.
- **WAV + JPEG stills, never a container.** No `ffmpeg` on either machine.
- **LinkedIn is linked, never scraped.** GitHub is enriched live from the public
  API (verified fetching a real profile).
