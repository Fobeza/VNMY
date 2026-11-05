#!/usr/bin/env python3
"""Собирает story.json «Ледовой смены» из актов.

Запуск:
    python3 stories/tihaya/novels/ice-shift/_source/build.py
Затем:
    npm run build && npm test
"""
import json
import pathlib

from act1 import CHARACTERS, SCENES as ACT1, VARS
from act2 import SCENES as ACT2

OUT = pathlib.Path(__file__).resolve().parents[1] / "story.json"

SCENES = ACT1 + ACT2

story = {
    "schema": 1,
    "id": "story_ice_shift",
    "title": "Ледовая смена · Акты I–II",
    "author": "Fobeza",
    "description": "Полярная станция «Тихая», шесть человек и пять суток без связи. Первые два акта: знакомство, первый сбой и ночь, когда станция сама позвала на помощь.",
    "cover": "assets/bg-antenna.webp",
    "accent": "#8fb8d8",
    "universe": "tihaya",
    "lang": "ru",
    "vars": VARS,
    "characters": CHARACTERS,
    "scenes": SCENES,
}

OUT.write_text(json.dumps(story, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

words = sum(len((st.get("text") or "").split()) for sc in SCENES for st in sc["steps"])
steps = sum(len(sc["steps"]) for sc in SCENES)
print(f"acts: 2, scenes: {len(SCENES)}, steps: {steps}, words: {words}")
print(f"written: {OUT}")
