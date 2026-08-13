# Interview inference contract

The single interface between IB Connect (this VM: UI + Go backend + MariaDB) and
the **GPU VM** running `cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit`.

Two implementations exist against this contract:

| Implementation | Where | Purpose |
|---|---|---|
| `gpu/mock_server.py` | this VM, port 8099 | Deterministic responses. Lets the entire product be built and tested with no GPU. |
| `gpu/interview_server.py` | GPU VM, port 8000 | The real thing. Written once the GPU box exists. |

**The Go backend is the only client.** The browser never reaches the GPU box, so
the token stays server-side and rate limiting happens in one place.

---

## Configuration (on this VM)

```
INTERVIEW_GPU_URL=http://10.x.x.x:8000     # unset ⇒ feature reports "not configured"
INTERVIEW_GPU_TOKEN=<shared secret>        # sent as Authorization: Bearer
INTERVIEW_GPU_TIMEOUT=120s                 # optional, per-request
```

Both live in `/etc/ibconnect/env` (chmod 600). **Never in the repo — it is public.**

With `INTERVIEW_GPU_URL` unset the backend still serves everything that does not
need the model (CV upload, parsing, GitHub enrichment, history) and returns a
clear "interview engine not configured" error for the rest. That is the intended
state until the GPU VM exists.

---

## Auth

Every request carries `Authorization: Bearer $INTERVIEW_GPU_TOKEN`.
The service must reject anything else with `401`.

The GPU VM should not be reachable from the public internet. Private network or
WireGuard preferred; TLS + token + IP allowlist is the floor.

---

## Endpoints

### `GET /healthz`

Readiness, not liveness. A 30B model takes minutes to load, so the backend gates
on `status == "ready"` before offering an interview.

```json
{ "status": "ready", "model": "Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit", "vram_used_mb": 21500 }
```
`status` ∈ `ready` | `loading` | `error`.

---

### `POST /v1/plan` — generate the question set

```json
{
  "profile": { "full_name": "…", "headline": "…", "summary": "…",
               "skills": ["Go","React"], "github": { "top_languages": ["Go"], "top_repos": [...] } },
  "role": "Backend Engineer", "seniority": "junior",
  "kind": "mixed", "count": 6
}
```
`seniority` ∈ `intern|junior|mid|senior|staff` · `kind` ∈ `technical|behavioral|mixed|system_design`

```json
{ "questions": [
  { "text": "…", "category": "Behavioral",
    "rationale": "Ties to the Go microservice on their CV",
    "expected_points": ["…"] } ] }
```

`rationale` is shown to the candidate in the report — it is why *this* question
was asked of *them*, which is the thing a generic question bank cannot do.

---

### `POST /v1/transcribe` — speech → text

```json
{ "audio_wav_b64": "…" }        → { "text": "…", "duration_sec": 42.5 }
```

Audio is **16 kHz mono PCM in a WAV container**, base64. Deliberately not a
compressed container: neither this VM nor the GPU VM has `ffmpeg`, and Qwen3-Omni
reads WAV natively. See `INTERVIEW_PLAN.md` §2.

---

### `POST /v1/evaluate` — score one answer

```json
{
  "question": "…", "expected_points": ["…"],
  "transcript": "…", "duration_sec": 42.5,
  "audio_wav_b64": "…",            // optional — enables delivery/tone assessment
  "frames_b64": ["…"],             // optional — up to 6 JPEG stills, ~1 per 5s
  "role": "Backend Engineer", "seniority": "junior"
}
```

```json
{
  "scores": { "communication": 7, "technical_depth": 6, "structure": 8,
              "confidence": 6, "relevance": 9 },
  "overall": 7.2,
  "strengths": ["…"], "improvements": ["…"],
  "feedback": "…",
  "filler_word_count": 12, "words_per_minute": 145
}
```
All scores 0–10. `overall` is the service's weighting, not a naive mean — the
backend stores whatever is returned and does not recompute.

Audio and frames are **processed and discarded**. Nothing is persisted GPU-side.

---

### `POST /v1/report` — whole-session summary

```json
{ "role": "…", "seniority": "…",
  "answers": [ { "question": "…", "transcript": "…", "scores": {…} } ] }
```

```json
{ "overall": 6.8, "verdict": "Promising — needs depth on system design",
  "summary": "…", "strengths": ["…"], "improvements": ["…"],
  "focus_areas": ["Concurrency", "Testing"] }
```

---

### `POST /v1/speak` — interviewer voice *(optional)*

```json
{ "text": "…", "voice": "default" }   → { "audio_wav_b64": "…" }
```

**Not required for v1.** The client falls back to the browser's `SpeechSynthesis`,
which costs nothing and removes the dependency on Qwen3-Omni's Talker — which is
not exposed through vLLM's OpenAI-compatible API and needs the transformers path.

If the endpoint returns `501 Not Implemented`, the backend reports speech as
unavailable and the UI uses browser TTS. Implement it later without touching any
other layer.

---

## Errors

Non-2xx returns `{ "error": "human readable" }`. The Go client maps:

| Condition | Behaviour |
|---|---|
| `INTERVIEW_GPU_URL` unset | "interview engine is not configured" — never reaches the network |
| Connection refused / DNS fail | "interview engine is unreachable" |
| `/healthz` reports `loading` | "interview engine is still starting up" |
| 401 | "interview engine rejected our credentials" |
| 5xx / timeout | retried once with backoff, then surfaced |

Every one is logged server-side with the endpoint and elapsed time, and mirrored
into the client diagnostics stream (`/api/client-events`) so a failed interview is
as diagnosable as a failed call.
