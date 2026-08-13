#!/usr/bin/env python3
"""
Mock implementation of gpu/CONTRACT.md.

Exists so the entire Virtual Interview feature — UI, CV pipeline, database,
session flow, scoring storage — can be built and verified with no GPU. When the
real GPU VM arrives it implements the same contract and this is swapped out by
changing one environment variable.

Deterministic on purpose: responses are derived from a hash of the input, so the
same CV and role always produce the same questions and scores. That makes it
usable in automated tests, which random output would not be.

Standard library only — no FastAPI, no pip install. Runs anywhere Python 3 does.

    python3 gpu/mock_server.py                  # port 8099
    PORT=9000 MOCK_TOKEN=secret python3 …
"""

import base64
import hashlib
import json
import os
import re
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "8099"))
TOKEN = os.environ.get("MOCK_TOKEN", "")          # empty = accept anything (local dev)
LATENCY = float(os.environ.get("MOCK_LATENCY", "0.4"))   # fake think-time, seconds
SPEAK_SUPPORTED = os.environ.get("MOCK_SPEAK", "0") == "1"

STARTED = time.time()
# Report "loading" briefly so the backend's readiness gating is actually exercised.
LOADING_FOR = float(os.environ.get("MOCK_LOADING_SEC", "0"))


def seeded(*parts) -> int:
    return int(hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:8], 16)


def pick(options, *seed_parts):
    return options[seeded(*seed_parts) % len(options)]


def score(lo, hi, *seed_parts):
    return lo + (seeded(*seed_parts) % (hi - lo + 1))


# ─── Question bank ───────────────────────────────────────────────────────────
# Templated but skill-aware, so the UI shows plausible, varied content and the
# "rationale" field is exercised end to end.

BEHAVIORAL = [
    ("Tell me about a project on your CV you're most proud of, and what you'd do differently.",
     "Opens with their own material so they can settle in"),
    ("Describe a time a technical decision you made turned out to be wrong. How did you find out?",
     "Tests self-awareness and how they handle being wrong"),
    ("Walk me through a disagreement with a teammate about an approach. How did it resolve?",
     "Collaboration under technical disagreement"),
    ("What's something you learned recently that changed how you work?",
     "Signals curiosity and rate of learning"),
]

TECHNICAL = [
    ("You have {skill} in your CV. Explain how you'd debug a production issue where it's involved.",
     "Probes depth in {skill}, which they listed as a core skill"),
    ("How would you test the {skill} code you've written? What would you deliberately not test?",
     "Testing judgement, not just testing knowledge"),
    ("Your GitHub shows work in {lang}. What's a footgun in {lang} that bit you?",
     "Verifies the {lang} experience their public repos suggest"),
    ("Explain {skill} to someone who has never used it, in under a minute.",
     "Communication of technical ideas — the hardest thing to fake"),
]

SYSTEM_DESIGN = [
    ("Design a system that lets 1,000 people join a live video call. Where does it break first?",
     "Scaling intuition and knowing where bottlenecks actually appear"),
    ("How would you store and serve user-uploaded files for an app with 100k users?",
     "Storage trade-offs and cost awareness"),
    ("A page takes 8 seconds to load. Walk me through how you'd find out why.",
     "Systematic diagnosis rather than guessing"),
]


def build_questions(profile, role, seniority, kind, count):
    skills = profile.get("skills") or ["your main language"]
    gh = profile.get("github") or {}
    langs = gh.get("top_languages") or skills
    name = profile.get("full_name") or "the candidate"

    pools = {
        "behavioral": [BEHAVIORAL],
        "technical": [TECHNICAL],
        "system_design": [SYSTEM_DESIGN],
        "mixed": [BEHAVIORAL, TECHNICAL, SYSTEM_DESIGN],
    }.get(kind, [BEHAVIORAL, TECHNICAL, SYSTEM_DESIGN])

    flat = []
    for i, pool in enumerate(pools):
        for j, (text, why) in enumerate(pool):
            flat.append((text, why, ["behavioral", "technical", "system_design"][i % 3]
                         if kind == "mixed" else kind))

    out = []
    for i in range(max(1, min(int(count or 6), 12))):
        text, why, cat = flat[seeded(name, role, i) % len(flat)]
        skill = skills[i % len(skills)]
        lang = langs[i % len(langs)] if langs else skill
        out.append({
            "text": text.format(skill=skill, lang=lang),
            "category": {"behavioral": "Behavioral", "technical": "Technical",
                         "system_design": "System Design"}.get(cat, "General"),
            "rationale": why.format(skill=skill, lang=lang),
            "expected_points": [
                f"Concrete example rather than generalities",
                f"Explains the reasoning, not just the outcome",
                f"Mentions trade-offs relevant to a {seniority} {role}",
            ],
        })
    return out


# ─── Evaluation ──────────────────────────────────────────────────────────────

FILLERS = re.compile(r"\b(um|uh|like|you know|basically|actually|sort of|kind of)\b", re.I)


def evaluate(question, transcript, duration, role, seniority, has_audio, has_frames):
    words = len(transcript.split())
    fillers = len(FILLERS.findall(transcript))
    wpm = round(words / max(duration / 60.0, 0.01)) if duration else 0

    # Length and filler density genuinely move the numbers, so the UI shows a
    # believable spread and a short/empty answer scores badly — which is what a
    # test needs in order to assert anything meaningful.
    base = 4 if words < 20 else 6 if words < 60 else 7
    penalty = min(2, fillers // 4)

    scores = {
        "communication": max(1, min(10, base + (1 if 110 <= wpm <= 170 else -1) - penalty)),
        "technical_depth": max(1, min(10, base + score(-1, 2, question, transcript, "d"))),
        "structure": max(1, min(10, base + score(-1, 2, question, "s"))),
        "confidence": max(1, min(10, base + (1 if has_audio else 0) + score(-1, 1, transcript, "c"))),
        "relevance": max(1, min(10, base + score(0, 2, question, "r"))),
    }
    overall = round(sum(scores.values()) / len(scores), 1)

    strengths, improvements = [], []
    if words >= 60:
        strengths.append("Gave a substantial answer with room for specifics")
    if 110 <= wpm <= 170:
        strengths.append(f"Well-paced delivery at {wpm} words per minute")
    if has_frames:
        strengths.append("Maintained presence on camera throughout")
    if not strengths:
        strengths.append("Attempted the question directly")

    if words < 40:
        improvements.append("Answer was short — aim for a concrete example with an outcome")
    if fillers >= 4:
        improvements.append(f"Used {fillers} filler words; pausing beats filling")
    if wpm > 180:
        improvements.append("Slow down — you're speaking faster than most listeners follow")
    if not improvements:
        improvements.append("Add a specific measurable result to make it land harder")

    return {
        "scores": scores,
        "overall": overall,
        "strengths": strengths[:3],
        "improvements": improvements[:3],
        "feedback": (
            f"For a {seniority} {role}, this answer {'lands well' if overall >= 7 else 'needs more substance'}. "
            f"{strengths[0]}. {improvements[0]}."
        ),
        "filler_word_count": fillers,
        "words_per_minute": wpm,
    }


def build_report(role, seniority, answers):
    if not answers:
        return {"overall": 0, "verdict": "No answers recorded", "summary": "",
                "strengths": [], "improvements": [], "focus_areas": []}
    keys = ["communication", "technical_depth", "structure", "confidence", "relevance"]
    agg = {k: round(sum(a.get("scores", {}).get(k, 0) for a in answers) / len(answers), 1) for k in keys}
    overall = round(sum(agg.values()) / len(agg), 1)
    verdict = ("Strong — ready for real interviews" if overall >= 8 else
               "Promising — a few areas to tighten" if overall >= 6.5 else
               "Needs practice before the real thing")
    weakest = min(agg, key=agg.get)
    strongest = max(agg, key=agg.get)
    pretty = {"technical_depth": "technical depth", "communication": "communication",
              "structure": "structure", "confidence": "confidence", "relevance": "relevance"}
    return {
        "overall": overall,
        "scores": agg,
        "verdict": verdict,
        "summary": (f"Across {len(answers)} answers your strongest dimension was "
                    f"{pretty[strongest]} ({agg[strongest]}/10) and your weakest was "
                    f"{pretty[weakest]} ({agg[weakest]}/10). "
                    f"For a {seniority} {role}, focus next on {pretty[weakest]}."),
        "strengths": [f"Consistent {pretty[strongest]} ({agg[strongest]}/10)"],
        "improvements": [f"{pretty[weakest].capitalize()} was the weakest at {agg[weakest]}/10"],
        "focus_areas": [pretty[weakest].capitalize(), "Concrete examples with measurable outcomes"],
    }


def silent_wav(seconds=1.2, rate=16000):
    """A valid 16 kHz mono WAV so the client's audio path can be exercised."""
    n = int(rate * seconds)
    data = b"\x00\x00" * n
    hdr = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " +
           struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) +
           b"data" + struct.pack("<I", len(data)))
    return base64.b64encode(hdr + data).decode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-gpu] %s\n" % (fmt % args))

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path.split("?")[0] != "/healthz":
            return self._send(404, {"error": "not found"})
        status = "loading" if (time.time() - STARTED) < LOADING_FOR else "ready"
        self._send(200, {"status": status, "model": "mock-qwen3-omni", "vram_used_mb": 0})

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._auth_ok():
            return self._send(401, {"error": "bad token"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send(400, {"error": f"bad json: {e}"})

        time.sleep(LATENCY)  # make the UI's loading states real

        if path == "/v1/plan":
            qs = build_questions(body.get("profile") or {}, body.get("role") or "Engineer",
                                 body.get("seniority") or "junior",
                                 body.get("kind") or "mixed", body.get("count") or 6)
            return self._send(200, {"questions": qs})

        if path == "/v1/transcribe":
            b64 = body.get("audio_wav_b64") or ""
            # Derive duration from the WAV size (16kHz mono 16-bit => 32000 B/s,
            # and base64 inflates by 4/3), then generate text at a REALISTIC
            # speaking rate. Sizing the transcript from byte length instead
            # produced thousands of words per minute, which made the delivery
            # metrics meaningless in the UI and in tests.
            raw_bytes = len(b64) * 3 / 4
            duration = max(0.5, raw_bytes / 32000.0)
            target_words = max(6, int(duration * 2.4))   # ~145 wpm
            sentence = ("So the way I approached this was to break the problem down "
                        "look at what was actually failing and then fix the root cause "
                        "rather than the symptom ").split()
            words = [sentence[i % len(sentence)] for i in range(target_words)]
            return self._send(200, {
                "text": " ".join(words).strip() + ".",
                "duration_sec": round(duration, 1),
            })

        if path == "/v1/evaluate":
            return self._send(200, evaluate(
                body.get("question") or "", body.get("transcript") or "",
                float(body.get("duration_sec") or 0),
                body.get("role") or "Engineer", body.get("seniority") or "junior",
                bool(body.get("audio_wav_b64")), bool(body.get("frames_b64")),
            ))

        if path == "/v1/report":
            return self._send(200, build_report(
                body.get("role") or "Engineer", body.get("seniority") or "junior",
                body.get("answers") or []))

        if path == "/v1/speak":
            if not SPEAK_SUPPORTED:
                # Exactly what the real service should return until the Talker
                # path works — the client then uses browser TTS.
                return self._send(501, {"error": "speech synthesis not implemented"})
            return self._send(200, {"audio_wav_b64": silent_wav()})

        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    print(f"[mock-gpu] listening on :{PORT}  (token={'set' if TOKEN else 'none'}, "
          f"speak={'on' if SPEAK_SUPPORTED else 'off → 501'})", file=sys.stderr)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
