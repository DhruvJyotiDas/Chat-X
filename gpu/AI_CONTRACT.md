# AI features inference contract

The single interface between IB Connect (this VM: UI + Go backend + MariaDB) and
the **Qwen model service** on the GPU VM (`10.1.1.4`), for the AI chat/reply/
writing/understanding/memory/task/reminder feature set (see the work-log entry
this contract was written alongside for the full feature list).

This is a SEPARATE service from the existing ASR/Interview GPU contracts on the
same box (`gpu/ASR_CONTRACT.md`, `gpu/CONTRACT.md`) — same machine, same
"Go backend is the only client" rule, different port/process.

Two implementations exist against this contract:

| Implementation | Where | Purpose |
|---|---|---|
| `gpu/mock_ai_server.py` | this VM | Deterministic responses. Lets the whole feature set be built and tested with no GPU. |
| the real Qwen service | GPU VM, `10.1.1.4:8000` | The real thing. |

**Status: the text side (`/v1/chat/completions`) works and is confirmed against
the real service, not assumed.** The vision side (`/query`) does not — see its
own section below. History, worth keeping: the first version of this file
described `/query` failing with a chat-template error and no text endpoint at
all. Both were fixed by the GPU side the same day, but the real shape that
landed differs from what this file originally proposed for `/chat` in ways that
matter — read the Endpoints section below rather than assuming the original
guess was right.

---

## Configuration (on this VM)

```
AI_GPU_URL=http://10.1.1.4:8000        # unset ⇒ feature reports "not configured"
AI_GPU_TOKEN=<shared secret>            # sent as Authorization: Bearer, once the
                                         # real service actually checks one — see
                                         # the Auth section below
AI_GPU_TIMEOUT=60s                      # optional, per-request — see the Latency
                                         # note below before lowering this
```

Both live in `/etc/ibconnect/env` (chmod 600). **Never in the repo — it is public.**

With `AI_GPU_URL` unset the backend reports every AI feature as "not configured"
rather than failing obscurely — same convention as `INTERVIEW_GPU_URL`/
`ASR_GPU_URL`.

---

## Auth

Every request carries `Authorization: Bearer $AI_GPU_TOKEN` when set. **As
observed, the real service does not currently check this at all** — every
endpoint responds identically with or without the header. The mock does not
enforce it either, matching the real service's current (unintended, presumably
temporary) behavior; tighten the mock the day the real service actually starts
rejecting unauthenticated requests, so a passing local suite doesn't mask a real
regression.

The GPU VM should not be reachable from the public internet — see the network
note in `gpu/ASR_CONTRACT.md`, which applies identically here (same box).

---

## Latency — read before wiring this into anything expecting a fast response

**This is a reasoning model and it is slow: 15-30 seconds per call, measured
directly, not estimated.** Every response — regardless of how simple the
question is — begins with a `<think>...</think>` block that alone can run into
the hundreds of tokens before the real answer even starts (see the Thinking
section below). A one-sentence rewrite of a one-sentence message took ~21s in
direct testing; a structured extraction call took longer. `AI_GPU_TIMEOUT` in
`server/ai_gpu.go` defaults to 60s per attempt with one retry — don't lower it
without re-measuring, and design any UI against this as "shows a spinner for
up to half a minute," not "feels instant." A "make professional" button that
takes 20+ seconds is a real UX cost worth knowing about going in, not
discovering after shipping.

---

## Thinking — read before parsing `result` directly

**Every response is wrapped as `"<think>\n...reasoning...\n</think>\n\nACTUAL
ANSWER"`, unconditionally.** Tried passing `"enable_thinking": false` (a real
parameter some Qwen3 deployments honor) — this service ignores it and thinks
anyway, confirmed directly. `server/ai_gpu.go`'s `stripThinking()` removes the
`<think>...</think>` block and returns only what follows; **never show `result`
to a user without stripping this first**, or every reply becomes a wall of the
model's internal monologue.

A response with `<think>` but no closing `</think>` means generation was cut off
mid-thought — `max_tokens` was too low for however long this particular call's
reasoning happened to run (not correlated with how hard the task looks — a
one-line summarize call ran out of budget at 700 tokens in direct testing, which
is why the client defaults to 1200). Treat this as a failure, not as "the answer
must be in the thinking somewhere" — it usually isn't, the real answer hadn't
started yet.

---

## Structured output — there is none

**There is no `json_schema` or any other structured-output enforcement on this
service.** Confirmed directly: passing a `json_schema` parameter is silently
ignored — the model still free-associates in `<think>` and the requested shape
never materializes if the response is cut off before it gets there. The only
way to get JSON back is to ask for it in the prompt (system + user turns, both
explicit) and extract the first balanced `{...}` substring from the answer after
stripping thinking — `server/ai_gpu.go`'s `extractJSONObject()`. This is
tolerant of stray text around the JSON, which is necessary: even with an
explicit "output ONLY this JSON object" instruction, the model does not always
comply cleanly.

**A single strict system-level formatting instruction works far better than
folding "reply with ONLY X" into a task-specific prompt.** Confirmed directly on
the rewrite feature: a per-mode instruction ending in "reply with ONLY the
rewritten message" was not enough on its own — the model returned three labeled
options under markdown headers with commentary instead of one plain rewrite.
Separating "what to do" (the task, as the user turn) from "how to format the
answer" (a shared, explicit system turn: no options, no markdown, no
commentary, exactly one thing back) fixed this consistently across every
rewrite mode tested (grammar, professional, casual, shorten, summarize — not
just one lucky case).

---

## Endpoints

### `GET /health`

Liveness only, not readiness — confirmed the real service returns
`{"status":"healthy"}` even while `/query` is completely broken. Do **not** gate
anything on this alone.

### `POST /v1/chat/completions` — text (also aliased at `/chat`)

**Confirmed working against the real service:**
```json
{
  "messages": [
    { "role": "system", "content": "..." },   // optional
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }  // prior turns, optional
  ],
  "max_tokens": 1200
}
→ { "result": "<think>...</think>\n\nACTUAL ANSWER" }
```
Note this is **not** the standard OpenAI response shape (`choices[].message.
content`) despite the OpenAI-style request — it wraps everything in the same
`{"result": "..."}` envelope every other endpoint on this service uses. Multi-
turn history is respected (confirmed: told a fact in turn 1, correctly recalled
it in turn 3). System-role instructions are respected too (confirmed: told to
always answer in French, did). `server/ai_gpu.go`'s `aiChat()` builds this
request from its own public `aiChatMessage{Role, Text}` shape — that public
shape didn't need to change when this was corrected, only the internal wire
format.

Backs: AI Chat Assistant, AI Reply (confirmed: given real thread context, has
returned three genuinely distinct, contextually correct tone variants — not
generic filler), AI Writing (confirmed working across 5+ rewrite modes once the
system-prompt structure above was fixed), AI Conversation Understanding, AI
Memory (the model proposes what to remember; storage is a plain DB table, not
part of this contract), AI Task Extraction, AI Calendar Intelligence (suggestion
only — see the work-log note on why this doesn't write to the calendar
directly), AI Reminders. All of the JSON-shaped ones go through the prompt-and-
extract pattern above, not a schema parameter.

### `POST /query` — vision (image + text)

**Still broken, but with a different error than before — progress, not a fix.**
Original error (`apply_chat_template`) is gone; current one, confirmed directly:
```json
{"detail":"The following `model_kwargs` are not used by the model: ['mm_token_type_ids'] (note: typos in the generate arguments will also show up in this list)"}
```
This is the multimodal image-processing path passing a kwarg the model's
`generate()` call doesn't accept — a GPU-side integration bug between the
processor and the model, not a client-side usage mistake (same request shape
that works are `{"image_url": ..., "text": ...}`, unchanged from the original
report). Still a real, required field per the service's own OpenAPI schema —
there is no way to send a text-only query through `/query`; that's what
`/v1/chat/completions` above is for.

Backs: AI Vision (OCR, screenshots, receipts, charts, diagrams), and AI Documents
for pages already rendered to images. **Still not usable.**
`gpu/mock_ai_server.py`'s `/query` returns a plausible fixed description so the
vision-side UI can be built and demoed; it does not perform real OCR — nothing
does, until this is actually fixed.

---

## Not backed by this contract at all, by design

- Translation — reuses the NLLB model already running on this same GPU VM via
  `gpu/ASR_CONTRACT.md`'s `/v1/translate`, through the existing `asr_gpu.go`
  client. Do not re-implement translation against the Qwen model.
- Voice transcription — reuses the existing Whisper/IndicConformer/Nemotron
  pipeline on this same box via the ASR contract, not this one.
- Text-to-speech / real-time voice chat — no model exists anywhere for this yet;
  out of scope until one is stood up.
- Semantic search (embeddings) — a 2B chat model is a poor embedder; out of
  scope for this contract until a dedicated embedding endpoint exists. The
  search feature ships first on keyword/recency scoring over stored messages.
