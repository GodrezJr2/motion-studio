"""Free draft voice-over via edge-tts (Microsoft Edge read-aloud voices).

usage: python tts_edge.py <voice> <rate> <pitch> <out.mp3>   (text on stdin)
Prints JSON: {"words": [{"w": "Satu", "t": 0.1, "d": 0.3}, ...]} with times in seconds from the file start.
"""
import asyncio
import json
import sys

import edge_tts


async def main(voice, rate, pitch, out):
    text = sys.stdin.read().strip()
    com = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    words = []
    with open(out, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                # offsets come in 100 ns ticks
                words.append({"w": chunk["text"], "t": round(chunk["offset"] / 1e7, 3), "d": round(chunk["duration"] / 1e7, 3)})
    print(json.dumps({"words": words}))


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    asyncio.run(main(*sys.argv[1:5]))
