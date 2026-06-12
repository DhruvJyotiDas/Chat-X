#!/bin/bash
# Start the Whisper Hindi2Hinglish ASR transcription WebSocket server
# This must be running for live transcription to work in meetings.
#
# First-time setup:
#   pip install silero-vad soundfile websockets transformers torch accelerate
#
# The server listens on ws://localhost:8765

set -e
cd "$(dirname "$0")"
echo "[ASR] Starting Whisper Hindi2Hinglish transcription server on ws://localhost:8765"
python3 transcription_server.py
