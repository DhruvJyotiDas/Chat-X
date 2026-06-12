"""
Oriserve/Whisper-Hindi2Hinglish-Prime + Silero VAD live transcription server.

Pipeline:
  browser → raw float32 PCM at 16kHz →
  Silero VAD (512-sample / 32ms windows) → speech segments only →
  Oriserve/Whisper-Hindi2Hinglish-Prime → transcript JSON → browser

Install deps:
  pip install silero-vad soundfile websockets transformers torch accelerate
"""

import asyncio
import json
import logging
import numpy as np
import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

MODEL_NAME   = "Oriserve/Whisper-Hindi2Hinglish-Prime"
SAMPLE_RATE  = 16000
VAD_CHUNK    = 512          # samples per VAD window (32 ms @ 16kHz) — required by Silero
MAX_SPEECH_S = 30           # hard-cap a single speech segment at 30 s to avoid OOM
MIN_AUDIO_S  = 0.3          # don't transcribe segments shorter than this

asr_pipe = None
vad_model = None


# ── Model loading ─────────────────────────────────────────────────────────────

def load_models():
    global asr_pipe, vad_model

    # Silero VAD
    log.info("Loading Silero VAD …")
    from silero_vad import load_silero_vad
    vad_model = load_silero_vad()
    log.info("Silero VAD ready.")

    # Whisper Hindi2Hinglish
    import torch
    from transformers import pipeline

    device = 0 if torch.cuda.is_available() else -1
    log.info("Loading %s on %s …", MODEL_NAME, "GPU" if device == 0 else "CPU")
    asr_pipe = pipeline(
        "automatic-speech-recognition",
        model=MODEL_NAME,
        device=device,
    )
    log.info("%s ready.", MODEL_NAME)


# ── Transcription helper ──────────────────────────────────────────────────────

# Words/phrases Whisper hallucinates on silence or noise
_HALLUCINATION_EXACT = {
    "nan", "NaN", "NAN", ".", "..", "...", "…",
    "Thank you.", "Thanks.", "Thank you for watching.",
    "Subtitles by", "Transcribed by", "[ Silence ]", "[BLANK_AUDIO]",
}
_HALLUCINATION_WORDS = {"nan"}   # single-token repeats to strip anywhere in output


def _clean(text: str) -> str:
    if not text:
        return ""
    # Strip exact hallucination phrases
    if text.strip() in _HALLUCINATION_EXACT:
        return ""
    # Remove any standalone "nan" tokens (case-insensitive)
    import re
    cleaned = re.sub(r'\bnan\b', '', text, flags=re.IGNORECASE).strip()
    # Collapse leftover whitespace / punctuation-only remains
    cleaned = re.sub(r'^[\s\W]+$', '', cleaned).strip()
    return cleaned


def transcribe_segment(audio_np: np.ndarray) -> str:
    if asr_pipe is None or len(audio_np) < int(SAMPLE_RATE * MIN_AUDIO_S):
        return ""
    try:
        result = asr_pipe(
            {"raw": audio_np.astype(np.float32), "sampling_rate": SAMPLE_RATE}
        )
        return _clean(result.get("text", "").strip())
    except Exception as e:
        log.warning("Transcription error: %s", e)
    return ""


# ── Per-connection VAD state ──────────────────────────────────────────────────

class VADState:
    """Holds Silero VAD iterator + speech accumulator for one WebSocket client."""

    def __init__(self):
        from silero_vad import VADIterator
        self.iterator = VADIterator(
            vad_model,
            sampling_rate=SAMPLE_RATE,
            threshold=0.45,
            min_silence_duration_ms=400,
            speech_pad_ms=100,
        )
        self.speech_buf: list[np.ndarray] = []
        self.in_speech = False
        self.remainder = np.array([], dtype=np.float32)

    def reset(self):
        self.iterator.reset_states()
        self.speech_buf.clear()
        self.in_speech = False
        self.remainder = np.array([], dtype=np.float32)

    def feed(self, pcm: np.ndarray):
        """
        Feed raw PCM. Yields complete speech segments (np.ndarray) ready for ASR.
        VADIterator requires exact VAD_CHUNK-sized windows.
        """
        pcm = np.concatenate([self.remainder, pcm])

        offset = 0
        while offset + VAD_CHUNK <= len(pcm):
            window = pcm[offset: offset + VAD_CHUNK]
            offset += VAD_CHUNK

            import torch
            tensor = torch.from_numpy(window)
            event = self.iterator(tensor, return_seconds=False)

            if event:
                if "start" in event:
                    self.in_speech = True
                    self.speech_buf.clear()
                if "end" in event and self.in_speech:
                    self.in_speech = False
                    segment = np.concatenate(self.speech_buf) if self.speech_buf else np.array([], dtype=np.float32)
                    self.speech_buf.clear()
                    if len(segment) >= int(SAMPLE_RATE * MIN_AUDIO_S):
                        yield segment

            if self.in_speech:
                self.speech_buf.append(window)
                # Hard cap — avoid runaway accumulation
                total = sum(len(b) for b in self.speech_buf)
                if total >= MAX_SPEECH_S * SAMPLE_RATE:
                    segment = np.concatenate(self.speech_buf)
                    self.speech_buf.clear()
                    yield segment

        self.remainder = pcm[offset:]

    def flush(self):
        """Force-emit whatever speech is buffered (called on 'flush' message or disconnect)."""
        self.iterator.reset_states()
        if self.speech_buf:
            segment = np.concatenate(self.speech_buf)
            self.speech_buf.clear()
            self.in_speech = False
            if len(segment) >= int(SAMPLE_RATE * MIN_AUDIO_S):
                return segment
        return None


# ── WebSocket handler ─────────────────────────────────────────────────────────

async def handle_client(ws: WebSocketServerProtocol):
    log.info("Client connected: %s", ws.remote_address)
    vad = VADState()

    try:
        async for message in ws:
            if isinstance(message, bytes):
                # Raw float32 PCM at 16 kHz, mono
                chunk = np.frombuffer(message, dtype=np.float32).copy()

                for segment in vad.feed(chunk):
                    text = await asyncio.get_event_loop().run_in_executor(
                        None, transcribe_segment, segment
                    )
                    if text:
                        log.info("Transcript: %s", text)
                        await ws.send(json.dumps({"type": "transcript", "text": text, "isFinal": True}))

            elif isinstance(message, str):
                try:
                    msg = json.loads(message)
                    if msg.get("type") == "flush":
                        segment = vad.flush()
                        if segment is not None:
                            text = await asyncio.get_event_loop().run_in_executor(
                                None, transcribe_segment, segment
                            )
                            if text:
                                await ws.send(json.dumps({"type": "transcript", "text": text, "isFinal": True}))
                        vad.reset()
                    elif msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                except json.JSONDecodeError:
                    pass

    except websockets.exceptions.ConnectionClosed:
        log.info("Client disconnected: %s", ws.remote_address)
    except Exception as e:
        log.error("Handler error: %s", e)


# ── Entry point ───────────────────────────────────────────────────────────────

async def main():
    load_models()
    host, port = "0.0.0.0", 8765
    log.info("Transcription server ready on ws://%s:%d", host, port)
    async with websockets.serve(handle_client, host, port, max_size=10 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
