#!/usr/bin/env python3
"""
Mock implementation of gpu/AI_CONTRACT.md.

Exists so the AI chat/reply/writing/understanding/memory/task/reminder
feature set can be built and tested without waiting on the real GPU service
(10.1.1.4:8000) for every iteration — that service is real and working now,
but it's also slow (15-30s per call, confirmed) and has no test-account
isolation, so this stays useful for fast local iteration even though it's no
longer the only way to test the feature.

Matches the REAL, CONFIRMED contract, not a guess: /v1/chat/completions (and
/chat as an alias) take {"messages":[{"role","content"}], "max_tokens"} and
return {"result": "<think>...</think>\n\nANSWER"} — every real response is
wrapped in a thinking block unconditionally, so this mock wraps its canned
replies the same way. That matters: it's the only thing that exercises
ai_gpu.go's stripThinking()/extractJSONObject() against something other than
the real (slow) service.

Deterministic on purpose, same philosophy as mock_asr_server.py: a plain
question gets a fixed echo reply; anything asking for JSON (checked for the
substring "json", case-insensitive, in the request) gets a canned JSON object
wrapped in thinking, so the reply-suggestions/extraction code paths stay
testable without the real service's latency. /query (vision) returns a fixed
description tagged with the image_url it was given, never real OCR — and
also wrapped in thinking, matching the real /query's confirmed behavior once
its OTHER (still open) bug is fixed.

    pip install fastapi uvicorn
    python3 gpu/mock_ai_server.py                  # port 8000, matches AI_CONTRACT.md
    PORT=9002 MOCK_TOKEN=secret python3 gpu/mock_ai_server.py
"""

import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

PORT = int(os.environ.get("PORT", "8000"))
TOKEN = os.environ.get("MOCK_TOKEN", "")  # empty = accept anything (local dev)

app = FastAPI()

FAKE_THINK = (
    "<think>\nThe user asked something. Let me consider how to respond "
    "helpfully and concisely, staying within any formatting rules given.\n</think>\n\n"
)


def _check_auth(request: Request):
    if not TOKEN:
        return None
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {TOKEN}":
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return None


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/query")
async def query(request: Request):
    unauth = _check_auth(request)
    if unauth:
        return unauth
    body = await request.json()
    image_url = body.get("image_url", "")
    text = body.get("text", "")
    if not image_url or not text:
        return JSONResponse(
            {"detail": [{"loc": ["body"], "msg": "field required", "type": "missing"}]},
            status_code=422,
        )
    return {
        "result": FAKE_THINK + (
            f"[mock vision reply] Asked about image {image_url!r} with prompt "
            f"{text!r} — no real OCR is performed by this mock."
        )
    }


async def _chat(request: Request):
    unauth = _check_auth(request)
    if unauth:
        return unauth
    body = await request.json()
    messages = body.get("messages", [])
    last_user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    system_text = " ".join((m.get("content", "") or "") for m in messages if m.get("role") == "system")

    # Distinguished by which JSON shape the caller's own prompt names — good
    # enough to exercise each JSON-shaped feature's real parsing code with a
    # plausible-looking fake object, not just prove extractJSONObject() can
    # find *a* JSON blob.
    if "actionItems" in system_text:
        fake_json = (
            '{"summary":"[mock] short summary of the conversation.",'
            '"keyPoints":["[mock] key point one","[mock] key point two"],'
            '"decisions":["[mock] decision one"],'
            '"questions":["[mock] open question one"],'
            '"actionItems":[{"description":"[mock] follow up on the file","assignee":"unclear","due":""}]}'
        )
        return {"result": FAKE_THINK + fake_json}
    if "suggestions" in system_text:
        fake_json = '{"suggestions":[{"tone":"professional","text":"[mock] professional reply"},{"tone":"casual","text":"[mock] casual reply"},{"tone":"friendly","text":"[mock] friendly reply"}]}'
        return {"result": FAKE_THINK + fake_json}
    if "json" in system_text.lower() or "json" in last_user.lower():
        return {"result": FAKE_THINK + "{}"}

    return {"result": FAKE_THINK + f"[mock chat reply] You said: {last_user[:200]}"}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    return await _chat(request)


@app.post("/chat")
async def chat_alias(request: Request):
    return await _chat(request)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
