"""Week 3: save answers to your example questions, for visitors without a key (demo mode).

    python make_demo.py "Question one" "Question two" "Question three"
"""
import json
import sys

import rag

demo = {}
for q in sys.argv[1:]:
    r = rag.answer(q)
    demo[q] = {"text": r["text"], "sources": [{k: h[k] for k in ("title", "section", "page", "source_url", "text")} for h in r["sources"]]}
    print("saved:", q)
json.dump(demo, open("demo_answers.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
