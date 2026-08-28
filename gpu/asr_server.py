#!/usr/bin/env python3
"""
Real implementation of gpu/ASR_CONTRACT.md — the live-captions pipeline.

    speaker audio (Int16 PCM 16kHz mono, over WS)
      -> Silero VAD segments speech from silence
      -> Whisper detects the segment's language (LID only, not transcription)
      -> routed to IndicConformer (Indic languages) or
         nvidia/nemotron-3.5-asr-streaming-0.6b (everything else)
      -> partial hypotheses re-decoded periodically while speech continues,
         a final decode on end-of-segment (or the 30s force-flush)
      -> POST /v1/translate does NLLB, decoupled from the streaming loop,
         called by the Go backend only for languages a room's viewers
         actually have selected

This file cannot be run or verified in the environment it was written in —
there is no GPU and no downloaded model weights there. It is a structurally
complete reference implementation, written against each model's documented
public API, for the user to deploy on the real GPU VM and iterate on for real
inference behavior, latency, and per-model worker-pool sizing. Everything
marked "NEEDS GPU-SIDE VALIDATION" below is exactly that: correct by
documentation, unverified in practice.

Install (approximate — pin versions once running against the real VM):
    pip install fastapi uvicorn silero-vad torch openai-whisper \
                nemo_toolkit[asr] transformers sentencepiece

Run:
    ASR_GPU_TOKEN=secret \
    INDIC_CONFORMER_MODEL_ID=<TODO: exact AI4Bharat checkpoint id> \
    python3 gpu/asr_server.py                      # port 8001
"""

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("asr")

# ── Config ──────────────────────────────────────────────────────────────────

PORT = int(os.environ.get("PORT", "8001"))
TOKEN = os.environ.get("ASR_GPU_TOKEN", "")

# AI4Bharat publishes several IndicConformer checkpoints (often one per
# language or language group), not one confirmed single "multilingual" id.
# Left explicit rather than guessed — set this once the real target
# language set is decided.
INDIC_CONFORMER_MODEL_ID = os.environ.get(
    "INDIC_CONFORMER_MODEL_ID", "TODO-set-indic-conformer-checkpoint-id",
)
NEMOTRON_MODEL_ID = os.environ.get(
    "NEMOTRON_MODEL_ID", "nvidia/nemotron-3.5-asr-streaming-0.6b",
)
WHISPER_LID_MODEL = os.environ.get("WHISPER_LID_MODEL", "base")
NLLB_MODEL_ID = os.environ.get("NLLB_MODEL_ID", "facebook/nllb-200-distilled-600M")

# Per-model concurrency caps — this is the direct fix for the retired
# transcription_server.py's bug, where every stream's inference went through
# Python's single default asyncio executor and serialized behind it
# regardless of which model was involved. Each model here gets its own
# bounded pool, sized independently, so a burst of Indic speakers can't
# starve LID (needed by every speaker, Indic or not) or Nemotron users.
# These defaults are guesses for a single mid-range GPU — the real numbers
# depend on the VM's actual VRAM and need tuning once it exists.
LID_WORKERS = int(os.environ.get("LID_WORKERS", "3"))
INDIC_WORKERS = int(os.environ.get("INDIC_WORKERS", "2"))
NEMOTRON_WORKERS = int(os.environ.get("NEMOTRON_WORKERS", "2"))
NLLB_WORKERS = int(os.environ.get("NLLB_WORKERS", "3"))

SAMPLE_RATE = 16000
VAD_CHUNK = 512             # samples per Silero VAD window (32ms @ 16kHz)
MAX_SPEECH_S = 30           # force-flush a segment this long, same as the old prototype
MIN_AUDIO_S = 0.3
PARTIAL_INTERVAL_S = 0.6    # re-decode the in-progress buffer this often for partials

# ISO 639-1 (what the contract and the UI use) -> FLORES-200 (what NLLB needs).
# Extend as more languages are added to SUPPORTED_LANGUAGES in the contract.
FLORES_CODE = {
    "en": "eng_Latn", "hi": "hin_Deva", "bn": "ben_Beng", "ta": "tam_Taml",
    "te": "tel_Telu", "mr": "mar_Deva", "gu": "guj_Gujr", "kn": "kan_Knda",
    "ml": "mal_Mlym", "pa": "pan_Guru", "ur": "urd_Arab",
    "es": "spa_Latn", "fr": "fra_Latn", "de": "deu_Latn", "ja": "jpn_Jpan",
}

# Whisper's LID is a general detector; only these count as "Indic" for
# routing to IndicConformer. Everything else (including languages Whisper
# detects but IndicConformer/Nemotron don't actually support) falls through
# to Nemotron, which is the broader-coverage model per the user's spec.
INDIC_LANGS = {"hi", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa", "ur", "or", "as"}

app = FastAPI()


def _authorized(auth_header: str | None) -> bool:
    if not TOKEN:
        return True
    return auth_header == f"Bearer {TOKEN}"


# ── Model registry: lazy-loaded once at startup, health tracks progress ────

@dataclass
class ModelRegistry:
    vad_model: object = None
    whisper_model: object = None
    indic_model: object = None
    nemotron_model: object = None
    nllb_tokenizer: object = None
    nllb_model: object = None
    status: dict = field(default_factory=lambda: {
        "whisper_lid": "loading", "indic_conformer": "loading",
        "nemotron": "loading", "nllb": "loading",
    })
    sems: dict = field(default_factory=dict)


models = ModelRegistry()


def load_models():
    """Blocking, run once in a startup thread. Loads worst-case-slowest
    first (ASR models) so health flips to ready as each becomes usable
    rather than all-at-once at the very end."""
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        log.warning("No CUDA device found — running on CPU, which will be far "
                    "too slow for live captions. Expected only in a smoke test.")

    log.info("Loading Silero VAD…")
    from silero_vad import load_silero_vad
    models.vad_model = load_silero_vad()

    log.info("Loading Whisper (%s) for language ID…", WHISPER_LID_MODEL)
    import whisper
    models.whisper_model = whisper.load_model(WHISPER_LID_MODEL, device=device)
    models.status["whisper_lid"] = "ready"

    # NEEDS GPU-SIDE VALIDATION: exact NeMo ASRModel subclass and .transcribe()
    # call signature can vary by checkpoint (EncDecRNNTBPEModel vs
    # EncDecCTCModelBPE etc.); from_pretrained() picks the right class for a
    # given checkpoint automatically, which is why this uses the generic
    # ASRModel.from_pretrained() from the user's own snippet rather than a
    # specific subclass.
    try:
        import nemo.collections.asr as nemo_asr
        log.info("Loading Nemotron ASR (%s)…", NEMOTRON_MODEL_ID)
        models.nemotron_model = nemo_asr.models.ASRModel.from_pretrained(NEMOTRON_MODEL_ID)
        models.nemotron_model = models.nemotron_model.to(device).eval()
        models.status["nemotron"] = "ready"
    except Exception:
        log.exception("Failed to load Nemotron ASR — /v1/stream will report "
                       "errors for non-Indic languages until this is fixed.")
        models.status["nemotron"] = "error"

    if INDIC_CONFORMER_MODEL_ID.startswith("TODO"):
        log.error("INDIC_CONFORMER_MODEL_ID not set — Indic-language routing "
                   "will fail until this env var points at a real checkpoint.")
        models.status["indic_conformer"] = "error"
    else:
        try:
            import nemo.collections.asr as nemo_asr
            log.info("Loading IndicConformer (%s)…", INDIC_CONFORMER_MODEL_ID)
            models.indic_model = nemo_asr.models.ASRModel.from_pretrained(INDIC_CONFORMER_MODEL_ID)
            models.indic_model = models.indic_model.to(device).eval()
            models.status["indic_conformer"] = "ready"
        except Exception:
            log.exception("Failed to load IndicConformer.")
            models.status["indic_conformer"] = "error"

    log.info("Loading NLLB (%s)…", NLLB_MODEL_ID)
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    models.nllb_tokenizer = AutoTokenizer.from_pretrained(NLLB_MODEL_ID)
    models.nllb_model = AutoModelForSeq2SeqLM.from_pretrained(NLLB_MODEL_ID).to(device).eval()
    models.status["nllb"] = "ready"

    models.sems = {
        "lid": asyncio.Semaphore(LID_WORKERS),
        "indic": asyncio.Semaphore(INDIC_WORKERS),
        "nemotron": asyncio.Semaphore(NEMOTRON_WORKERS),
        "nllb": asyncio.Semaphore(NLLB_WORKERS),
    }
    log.info("All models loaded. Status: %s", models.status)


@app.on_event("startup")
async def startup():
    loop = asyncio.get_event_loop()
    # Runs in a thread so uvicorn can start answering /healthz with "loading"
    # immediately rather than blocking the whole process on model downloads.
    loop.run_in_executor(None, load_models)


# ── Inference helpers — each wrapped in its model's semaphore so the total
#    number of concurrent GPU forward passes per model is bounded regardless
#    of how many speaker streams are active at once. ─────────────────────────

async def detect_language(audio: np.ndarray) -> str:
    async with models.sems["lid"]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _detect_language_sync, audio)


def _detect_language_sync(audio: np.ndarray) -> str:
    import whisper
    audio = whisper.pad_or_trim(audio.astype(np.float32))
    mel = whisper.log_mel_spectrogram(audio).to(models.whisper_model.device)
    _, probs = models.whisper_model.detect_language(mel)
    return max(probs, key=probs.get)


async def transcribe(audio: np.ndarray, lang: str) -> str:
    use_indic = lang in INDIC_LANGS and models.indic_model is not None
    model = models.indic_model if use_indic else models.nemotron_model
    sem = models.sems["indic"] if use_indic else models.sems["nemotron"]
    if model is None:
        raise RuntimeError(f"no ASR model loaded for lang={lang}")
    async with sem:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _transcribe_sync, model, audio)


def _transcribe_sync(model, audio: np.ndarray) -> str:
    # NEEDS GPU-SIDE VALIDATION: this is a plain batch decode of whatever
    # buffer it's given (the full segment for a "final", a growing prefix
    # for a "partial") — correct and simple, but not the lowest-latency
    # option. nemotron-3.5-asr-streaming specifically supports NeMo's
    # cache-aware streaming decode API (incremental state carried between
    # calls instead of re-decoding the whole buffer each time), which would
    # cut partial-update latency further — a follow-up once this baseline is
    # confirmed working end-to-end on real hardware.
    result = model.transcribe([audio], batch_size=1, verbose=False)
    hyp = result[0]
    return hyp.text if hasattr(hyp, "text") else str(hyp)


async def translate_text(text: str, source_lang: str, target_langs: list[str]) -> dict:
    out = {}
    for lang in target_langs:
        if lang == source_lang or lang not in FLORES_CODE:
            continue
        async with models.sems["nllb"]:
            loop = asyncio.get_event_loop()
            out[lang] = await loop.run_in_executor(None, _translate_sync, text, source_lang, lang)
    return out


def _translate_sync(text: str, source_lang: str, target_lang: str) -> str:
    src, tgt = FLORES_CODE.get(source_lang), FLORES_CODE[target_lang]
    tok = models.nllb_tokenizer
    tok.src_lang = src or "eng_Latn"
    inputs = tok(text, return_tensors="pt").to(models.nllb_model.device)
    forced_bos = tok.convert_tokens_to_ids(tgt)
    out = models.nllb_model.generate(**inputs, forced_bos_token_id=forced_bos, max_new_tokens=200)
    return tok.batch_decode(out, skip_special_tokens=True)[0]


# ── VAD segmentation — ported from the retired transcription_server.py,
#    same thresholds, now per-connection state inside StreamSession. ───────

class VADState:
    def __init__(self):
        from silero_vad import VADIterator
        self.iterator = VADIterator(
            models.vad_model, sampling_rate=SAMPLE_RATE,
            threshold=0.45, min_silence_duration_ms=400, speech_pad_ms=100,
        )
        self.speech_buf: list[np.ndarray] = []
        self.in_speech = False
        self.remainder = np.array([], dtype=np.float32)

    def feed(self, pcm: np.ndarray):
        """Yields ('partial'|'final', np.ndarray) as speech is detected."""
        import torch
        pcm = np.concatenate([self.remainder, pcm])
        offset = 0
        while offset + VAD_CHUNK <= len(pcm):
            window = pcm[offset:offset + VAD_CHUNK]
            offset += VAD_CHUNK
            event = self.iterator(torch.from_numpy(window), return_seconds=False)
            if event:
                if "start" in event:
                    self.in_speech = True
                    self.speech_buf.clear()
                if "end" in event and self.in_speech:
                    self.in_speech = False
                    if self.speech_buf:
                        segment = np.concatenate(self.speech_buf)
                        self.speech_buf.clear()
                        if len(segment) >= int(SAMPLE_RATE * MIN_AUDIO_S):
                            yield ("final", segment)
            if self.in_speech:
                self.speech_buf.append(window)
                total = sum(len(b) for b in self.speech_buf)
                if total >= MAX_SPEECH_S * SAMPLE_RATE:
                    segment = np.concatenate(self.speech_buf)
                    self.speech_buf.clear()
                    self.in_speech = False
                    self.iterator.reset_states()
                    yield ("final", segment)
        self.remainder = pcm[offset:]

    def in_progress_buffer(self) -> np.ndarray | None:
        if not self.in_speech or not self.speech_buf:
            return None
        return np.concatenate(self.speech_buf)


# ── WS handler: one per active speaker ───────────────────────────────────

@app.get("/healthz")
def healthz(request: Request):
    if not _authorized(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    overall = "ready" if all(v == "ready" for v in models.status.values()) else (
        "error" if any(v == "error" for v in models.status.values()) else "loading"
    )
    return {
        "status": overall,
        "models": models.status,
        "supported_languages": sorted(set(FLORES_CODE) | INDIC_LANGS | {"en"}),
    }


@app.post("/v1/translate")
async def translate_endpoint(request: Request):
    if not _authorized(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    body = await request.json()
    translations = await translate_text(body["text"], body["source_lang"], body.get("target_langs", []))
    return {"translations": translations}


@app.websocket("/v1/stream")
async def stream(ws: WebSocket):
    if not _authorized(ws.headers.get("authorization")):
        await ws.close(code=4401)
        return
    await ws.accept()
    vad = VADState()
    last_partial_at = 0.0
    detected_lang = "en"  # updated once LID runs on the first segment

    try:
        handshake = await ws.receive_json()
        room_id, user_id = handshake.get("room_id"), handshake.get("user_id")
        log.info("Stream opened: room=%s user=%s", room_id, user_id)

        while True:
            msg = await ws.receive()
            if "bytes" not in msg or msg["bytes"] is None:
                continue
            pcm = np.frombuffer(msg["bytes"], dtype=np.int16).astype(np.float32) / 32768.0

            for kind, segment in vad.feed(pcm):
                if kind == "final":
                    detected_lang = await detect_language(segment)
                    text = await transcribe(segment, detected_lang)
                    if text.strip():
                        await ws.send_json({
                            "type": "final", "text": text.strip(),
                            "lang": detected_lang, "confidence": 0.9,
                        })

            # Periodic partial re-decode of whatever's accumulated so far —
            # see the NEEDS GPU-SIDE VALIDATION note on _transcribe_sync for
            # why this isn't true incremental streaming decode yet.
            now = time.monotonic()
            if now - last_partial_at >= PARTIAL_INTERVAL_S:
                buf = vad.in_progress_buffer()
                if buf is not None and len(buf) >= int(SAMPLE_RATE * MIN_AUDIO_S):
                    last_partial_at = now
                    text = await transcribe(buf, detected_lang)
                    if text.strip():
                        await ws.send_json({"type": "partial", "text": text.strip(), "lang": detected_lang})
    except WebSocketDisconnect:
        log.info("Stream closed: room=%s user=%s", room_id, user_id)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
