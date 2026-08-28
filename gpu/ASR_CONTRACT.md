# Live captions inference contract

The single interface between IB Connect (this VM: UI + Go backend) and the
**GPU VM** running the live-captions pipeline: Whisper (language ID) →
IndicConformer / `nvidia/nemotron-3.5-asr-streaming-0.6b` (ASR, routed by
detected language) → NLLB (translation).

**Provenance note (2026-08-21):** this doc was originally written here first
and handed to the GPU VM to implement against. The GPU VM's own Claude Code
instance had no access to this repo and, independently, authored its own
`CONTRACT.md` from the feature description alone before this file ever
reached it. The two came out *close* but not identical — this file has been
updated to match what the GPU VM actually implements and ships (its
`CONTRACT.md`, at `ubuntu@ib-bom-dev-gpu0:~/asr_server/CONTRACT.md`, is the
more authoritative source if the two ever disagree again — it describes
running code). `server/asr_gpu.go` / `server/transcription_relay.go` are
written against *this* corrected version and were verified against it via
`gpu/mock_asr_server.py`, which was updated to match too.

`gpu/asr_server.py` in this repo — the draft reference implementation written
before the GPU VM existed — is **not** what's actually deployed there; the
GPU VM's team built their own server independently, in their own repo on
that machine. Left here for its concurrency/VAD reasoning, which is still
generally applicable, but don't treat it as the source of truth for wire
format — this document and the GPU VM's own `CONTRACT.md` are.

Two implementations exist against this contract, same split as
`CONTRACT.md`'s interview feature:

| Implementation | Where | Purpose |
|---|---|---|
| `gpu/mock_asr_server.py` | this VM, port 8098 | Deterministic fake transcripts/translations. Lets the whole feature — audio capture, relay, room fan-out, both caption UIs — be built and tested with no GPU. |
| the GPU VM's own server | `ib-bom-dev-gpu0`, port 8443 (currently bound to `127.0.0.1` only — not yet reachable from this VM, see Networking below) | The real thing. Not `gpu/asr_server.py` — see the provenance note above. |

**The Go backend is the only client.** The browser never reaches the GPU box —
same reasoning as the interview contract: the token stays server-side, and
rate limiting / room-membership checks happen in one place
(`server/transcription_relay.go`).

Unlike the interview contract, this one is **streaming**: captions must appear
while someone is still talking, not after the call. One WebSocket connection
per active speaker carries audio in and partial/final transcript events out;
translation is a separate, stateless, on-demand call so it never blocks the
live loop.

---

## Configuration (on this VM)

```
ASR_GPU_URL=http://10.x.x.x:8001      # unset ⇒ feature reports "not configured"
ASR_GPU_TOKEN=<shared secret>         # sent as Authorization: Bearer
ASR_GPU_TIMEOUT=15s                   # optional, /v1/translate and /healthz only
```

Both live in `/etc/ibconnect/env` (chmod 600). **Never in the repo — it is
public.**

With `ASR_GPU_URL` unset, the caption toggle in the meeting UI stays visible
but shows "captions aren't set up yet" and **never opens a microphone** —
same "everything that doesn't need the model keeps working" rule as
Interview.

---

## Auth

Every request — including the WebSocket dial — carries
`Authorization: Bearer $ASR_GPU_TOKEN`. This hop is server-to-server (Go's
outbound WS dialer sets the header; no browser is ever involved), so there is
no browser-side header limitation to work around and the fallback
auth methods the GPU VM's contract also accepts (`Sec-WebSocket-Protocol:
bearer.<token>`, or a `token` query param) are never used by this client —
they exist on the GPU side only for other, browser-constrained callers.

A request without a valid token gets `401` (REST) or WS close code `4401`
(the WS case is checked post-upgrade, since auth on a raw WS dial can only be
validated once the connection exists) — `asrDialStream` in `server/asr_gpu.go`
distinguishes 4401 from an ordinary connection failure.

### Networking

The two VMs are on **different cloud providers/accounts** — no shared VPC, no
existing private link. Standing up a real cross-provider VPN (WireGuard) is
real work on both ends; the pragmatic path for now is the floor option the
GPU VM's own contract already anticipates: **TLS + bearer token + IP
allowlist**, not a private network.

Concretely, on the GPU VM:
- Put a TLS-terminating reverse proxy (nginx/caddy) in front of the ASR
  service on port 8443, since it currently binds to `127.0.0.1` only — not
  reachable from anywhere but itself.
- Firewall inbound on 8443 to only this VM's public IP (`163.128.34.19`).
- The bearer token is the last line of defense on top of that.

`ASR_GPU_URL` will be `https://<gpu-vm-public-address>:8443` once this is
done — not a private IP, since there's no private path between the two
boxes. Upgrading to a real VPN later is a networking change only; nothing
in this contract or either side's code depends on which transport carries
it, as long as TLS + the token are both present.

---

## Endpoints

### `GET /healthz`

Readiness, not liveness. One VM loads four models with different load times,
so the backend gates on the *overall* `status` before offering captions, and
`models` is there for diagnosing which one is still loading.

```json
{
  "status": "ready",
  "models": {
    "whisper_lid": "ready",
    "indic_conformer": "ready",
    "nemotron": "ready",
    "nllb": "ready"
  },
  "supported_languages": ["en", "hi", "bn", "ta", "te", "mr", "es", "fr", "..."],
  "gpu": {"name": "NVIDIA L4", "vram_total_gb": 23.0, "vram_used_gb": 8.4}
}
```
`status` and each model's value ∈ `ready` | `loading` | `error`. `status` is
`ready` only if all four sub-models are. `gpu` is informational/extra — the
Go client's `asrHealthResp` doesn't parse it, ignore it or not as convenient.
`supported_languages` drives the caption language picker in the UI directly —
it must never claim a language none of the loaded models actually produce or
NLLB can't translate into. This endpoint always returns `200`, even when
degraded — the body carries the real status, not the HTTP status line.

---

### `WS /v1/stream` — one connection per active speaker

Opened by the Go backend, one per participant who currently has captions
active (i.e. is unmuted with the caption feature on) — **not** one per
listener. First frame is a JSON handshake (text frame):

```json
{ "room_id": "KKPZ-ABAF", "user_id": "user-815ce7061367244d" }
```

The server acks with a text frame **before any audio should be sent**:

```json
{ "type": "ready", "sample_rate": 16000, "encoding": "pcm_s16le" }
```

`asrDialStream` (`server/asr_gpu.go`) blocks on this ack (bounded by
`ASR_GPU_TIMEOUT`) before handing the connection back to
`transcription_relay.go` — audio is never written before `ready` arrives. A
missing/malformed handshake, or audio arriving before the handshake, gets the
connection closed with code `4400`.

Every frame after the ack is **binary**: raw **Int16 PCM, 16 kHz, mono**. Not
a compressed container. Any chunk size works; ~20-100ms per frame is what the
GPU VM recommends for responsive partials, sent at real-time pace (the GPU
service does not buffer/pace on its own).

The server replies with JSON text frames as speech is recognized:

```json
{ "type": "partial", "seq": 4, "text": "so basically what happens", "language": "en", "utterance_id": "u-1" }
{ "type": "final", "seq": 7, "text": "so basically what happens is...", "language": "en", "utterance_id": "u-1", "duration_ms": 3120, "end_reason": "vad_pause" }
{ "type": "error", "code": "decode_failed", "message": "..." }
```

- `partial` fires as hypotheses firm up mid-utterance — approximate, may be
  revised by the next `partial` or replaced entirely by `final`. Never
  translated (too slow/wasteful per-token) — always shown in the original
  spoken language.
- `final` fires once per VAD-detected end-of-speech segment (`end_reason:
  "vad_pause"`) or after a 30s hard cap on one utterance (`end_reason:
  "max_duration"`). `language` is the Whisper-LID result for that segment
  specifically — a bilingual speaker can legitimately produce a stream of
  finals with different `language` values. This is the text the Go backend
  sends to `/v1/translate`.
- `error` is **non-fatal** — one utterance failed to decode, the connection
  stays open. `handleASREvent`'s caller (`pumpASRSession` in
  `transcription_relay.go`) logs it and keeps pumping; it never reaches the
  browser as a caption.
- `seq` increments per event on the connection (monotonic from 0).
  `utterance_id` (`u-1`, `u-2`, ...) is shared by all partials and the one
  final for a given utterance. Neither is currently consumed on the IB
  Connect side — captions are shown as "latest per speaker", not a
  partial-replaces-partial log — but both are parsed-safe to add if that
  ever changes.

Client may send `{"type":"end"}` to end cleanly (server flushes any
in-flight utterance as a final with `end_reason: "client_end"` and closes
with code `1000`); simply closing the socket also works and discards
whatever utterance was in flight, silently.

Connection close from either side ends that speaker's stream; the Go backend
redials on unexpected drops with backoff (`runASRSession` in
`transcription_relay.go`) — the GPU VM does not need to buffer or resume
anything across a reconnect, each dial starts a fresh segment state and a
fresh `utterance_id` sequence.

---

### `POST /v1/translate` — final text → one or more target languages

```json
{ "text": "So I think the next step is a soft launch.", "source_language": "en", "target_languages": ["es", "fr", "hi"] }
```

```json
{ "translations": { "es": "…", "fr": "…", "hi": "…" } }
```

If one target language fails to translate, it's simply omitted from
`translations` and reported separately, and the call still succeeds overall:

```json
{ "translations": { "es": "…" }, "errors": { "hi": "translation_failed" } }
```

`asrTranslate` (`server/asr_gpu.go`) logs `errors` but still returns whatever
`translations` did come back, rather than failing the whole final over one
bad target language.

Called only for **final** segments, only for the distinct set of languages
viewers in that room currently have selected (the Go backend snapshots and
dedupes this before calling — see `Room.broadcastAll` / `caption_lang` in
`server/main.go`), so this endpoint is never on the hot path of a partial and
never pays for a language nobody in the room is reading. A `target_languages`
entry equal to `source_language` is never sent (translating a language into
itself is the caller's job to skip, not this endpoint's).

`400` for a malformed body, `401` for a bad/missing token.

---

## Errors

Non-2xx returns `{ "error": "human readable" }`; the WS equivalent is closing
with a close-frame reason. The Go client maps:

| Condition | Behaviour |
|---|---|
| `ASR_GPU_URL` unset | "captions aren't set up yet" — never reaches the network, never opens a mic |
| Connection refused / DNS fail | "captions temporarily unavailable" |
| `/healthz` reports `loading` | "captions are starting up" |
| WS close `4400` (bad handshake) or non-`"ready"` first frame | "captions temporarily unavailable" |
| `401` REST / WS close `4401` | "captions engine rejected our credentials" |
| WS drops mid-stream | reconnect with backoff; "captions temporarily unavailable" if it doesn't come back |

None of these can affect the call itself — this contract's traffic never
touches the WebRTC audio/video path, only a side-channel WebSocket.

---

## Known gap, flagged by the GPU VM's own contract doc

Detected language routes to IndicConformer for a specific Indic-language set
(`as, bn, brx, doi, gu, hi, kn, kok, ks, mai, ml, mni, mr, ne, or, pa, sa,
sat, sd, ta, te, ur`) and Nemotron otherwise — but **Whisper's LID vocabulary
doesn't cover all of those codes**, so a language in that set that Whisper
can't identify falls through to Nemotron instead of IndicConformer. Purely
GPU-side (server/asr_gpu.go and the relay have no visibility into this — it
never surfaces as an error, just a possible accuracy gap for the affected
languages). Not something to fix from the IB Connect side; noted here so it
isn't mistaken for an IB Connect bug if reported.
