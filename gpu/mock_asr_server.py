#!/usr/bin/env python3
"""
Mock implementation of gpu/ASR_CONTRACT.md.

Exists so the entire live-captions feature — mic capture, the Go backend's
/asr relay, per-viewer translation fan-out, the on-screen caption bar, the
Transcript side panel — can be built and Playwright-tested with no GPU. When
the real GPU VM arrives it implements the same contract
(gpu/asr_server.py) and this is swapped out by changing one environment
variable (ASR_GPU_URL) on the main VM.

Unlike gpu/mock_server.py (the interview mock), this can't stay standard-
library-only: /v1/stream is a WebSocket, and stdlib has no WS server. FastAPI
+ uvicorn is used instead — the same choice gpu/asr_server.py needs anyway,
so mock and real share one shape.

Deterministic on purpose: fake transcripts cycle through a fixed script keyed
by how many Int16 PCM bytes have arrived on a given stream, and fake
translation is a reversible tag ("[es] " + text) rather than a real model —
tests can assert exactly what came out for exactly what went in.

    pip install fastapi uvicorn websockets   # websockets is required — without it
                                              # uvicorn silently 404s every /v1/stream
                                              # upgrade instead of erroring loudly.
    python3 gpu/mock_asr_server.py                       # port 8098
    PORT=9001 MOCK_TOKEN=secret python3 gpu/mock_asr_server.py
"""

import asyncio
import os
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
import uvicorn

PORT = int(os.environ.get("PORT", "8098"))
TOKEN = os.environ.get("MOCK_TOKEN", "")          # empty = accept anything (local dev)
LOADING_FOR = float(os.environ.get("MOCK_LOADING_SEC", "0"))
STARTED = time.time()

# Bytes of Int16 PCM @16kHz mono per second of audio — used to fake "enough
# speech has arrived" without doing any real signal processing.
BYTES_PER_SEC = 16000 * 2
SEGMENT_SECONDS = 2.5   # a fake "final" fires roughly this often

SUPPORTED_LANGUAGES = ["en", "hi", "bn", "ta", "te", "mr", "es", "fr", "de", "ja"]

# A tiny deterministic script so a segment's fake text is a pure function of
# its index, not wall-clock time — reruns of a test are reproducible.
SCRIPT = [
    ("Good morning everyone, thanks for joining.", "en"),
    ("नमस्ते, आज हम प्रोजेक्ट की स्थिति पर चर्चा करेंगे।", "hi"),
    ("Let's start with the roadmap for next quarter.", "en"),
    ("मुझे लगता है कि हमें पहले बजट पर बात करनी चाहिए।", "hi"),
    ("Sounds good, I'll share my screen.", "en"),
]

app = FastAPI()


def _authorized(auth_header: str | None) -> bool:
    if not TOKEN:
        return True
    return auth_header == f"Bearer {TOKEN}"


@app.get("/healthz")
def healthz(request: Request):
    if not _authorized(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    loading = (time.time() - STARTED) < LOADING_FOR
    status = "loading" if loading else "ready"
    return {
        "status": status,
        "models": {
            "whisper_lid": status,
            "indic_conformer": status,
            "nemotron": status,
            "nllb": status,
        },
        "supported_languages": SUPPORTED_LANGUAGES,
    }


@app.post("/v1/translate")
async def translate(request: Request):
    if not _authorized(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    body = await request.json()
    text = body.get("text", "")
    targets = body.get("target_languages", [])
    # Fake, reversible "translation" — a real NLLB call is replaced by a tag
    # so a test can assert the exact expected string came back for each lang.
    await asyncio.sleep(0.05)
    return {"translations": {lang: f"[{lang}] {text}" for lang in targets}}


@app.websocket("/v1/stream")
async def stream(ws: WebSocket):
    auth = ws.headers.get("authorization")
    if not _authorized(auth):
        await ws.close(code=4401)
        return
    await ws.accept()

    total_bytes = 0
    next_segment_at = SEGMENT_SECONDS * BYTES_PER_SEC
    script_idx = 0
    room_id = user_id = None

    try:
        # First frame is the JSON handshake, per ASR_CONTRACT.md — acked with
        # a "ready" text frame before any audio should be sent.
        handshake = await ws.receive_json()
        room_id = handshake.get("room_id")
        user_id = handshake.get("user_id")
        await ws.send_json({"type": "ready", "sample_rate": 16000, "encoding": "pcm_s16le"})

        seq = 0
        utterance_idx = 1

        while True:
            msg = await ws.receive()
            if "bytes" not in msg or msg["bytes"] is None:
                continue
            chunk = msg["bytes"]
            total_bytes += len(chunk)

            # Fake a "partial" every time audio arrives, and a "final" once
            # enough fake-speech-time has accumulated — mirrors the real
            # contract's cadence (partials frequent, finals every couple of
            # seconds) without doing any actual VAD or ASR.
            text, lang = SCRIPT[script_idx % len(SCRIPT)]
            partial_text = text[: max(4, int(len(text) * min(1.0, total_bytes / next_segment_at)))]
            await ws.send_json({
                "type": "partial", "seq": seq, "text": partial_text,
                "language": lang, "utterance_id": f"u-{utterance_idx}",
            })
            seq += 1

            if total_bytes >= next_segment_at:
                await ws.send_json({
                    "type": "final", "seq": seq, "text": text, "language": lang,
                    "utterance_id": f"u-{utterance_idx}",
                    "duration_ms": int(SEGMENT_SECONDS * 1000), "end_reason": "vad_pause",
                })
                seq += 1
                utterance_idx += 1
                script_idx += 1
                next_segment_at = total_bytes + SEGMENT_SECONDS * BYTES_PER_SEC
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    print(f"[mock-asr] room-agnostic fake ASR/translate on ws://0.0.0.0:{PORT}/v1/stream")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
