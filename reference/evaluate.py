"""Score the app on eval/questions.csv.

    python evaluate.py                 # retrieval only: did each search mode find the right section? (almost free)
    python evaluate.py --answers       # also ask the model and score the answers (costs a few cents)

Retrieval: for each answerable question, is its source_id among the top chunks? Scored for
keyword, vector and hybrid search. Answers: correct if the answer contains `expected`;
for questions that should not be answered, correct if the app refuses.
"""
import csv
import sys
import time

from openai import OpenAI

import rag

rows = list(csv.DictReader(open("eval/questions.csv", encoding="utf-8-sig")))
answerable = [r for r in rows if r["should_answer"].strip().lower() == "yes"]
client = OpenAI()

print(f"{len(rows)} questions ({len(answerable)} answerable)\n\nRetrieval: right section in the top {rag.TOP_K}")
for mode in ("keyword", "vector", "hybrid"):
    hit = 0
    for r in answerable:
        hits = rag.kb().hybrid(r["question"], client, k=rag.TOP_K, mode=mode)
        hit += any(h["record_id"] == r["source_id"].strip() for h in hits)
    print(f"  {mode:8} {hit}/{len(answerable)}")

if "--answers" in sys.argv:
    print("\nAnswers")
    ok = total_cost = total_time = 0
    for r in rows:
        res = rag.answer(r["question"])
        text = res["text"].lower().replace("’", "'")
        refused = rag.NOT_FOUND.lower().rstrip(".") in text
        good = refused if r["should_answer"].strip().lower() == "no" else (r["expected"].strip().lower() in text and not refused)
        ok += good
        total_cost += res["cost_usd"]
        total_time += res["seconds"]
        print(("PASS " if good else "FAIL ") + r["question"])
        if not good:
            print("     got: " + res["text"][:160].replace("\n", " "))
            print("     from: " + ", ".join(h["record_id"] for h in res["sources"]))
    n = len(rows)
    print(f"\n{ok}/{n} correct · average {total_time / n:.1f}s · about ${total_cost / n:.5f} per question")
