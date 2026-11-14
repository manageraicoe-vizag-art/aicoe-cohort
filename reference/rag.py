"""Week 2: answer a question from the knowledge base, with numbered sources.

    python rag.py            # ask questions in the terminal
"""
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from search import KnowledgeBase, rerank

load_dotenv()

CHAT_MODEL = "gpt-6-luna"  # the only chat model your key allows
TOP_K = 5             # chunks sent to the model
MIN_SIMILARITY = 0.25 # below this, nothing in the documents is close enough: refuse without calling the model
USE_RERANK = False    # Week 3 experiment
NOT_FOUND = "I couldn't find this in our documents."
# USD per million tokens (input, output), from the OpenAI Pricing page
PRICES = {"gpt-6-luna": (0.10, 0.50), "text-embedding-3-small": (0.02, 0)}

PROMPT = Path("prompt.md").read_text(encoding="utf-8")
_kb = None


def kb():
    global _kb
    if _kb is None:
        _kb = KnowledgeBase()
    return _kb


def cost(model, usage):
    if usage is None:
        return 0.0
    p_in, p_out = PRICES.get(model, (0, 0))
    return (usage.input_tokens * p_in + usage.output_tokens * p_out) / 1e6


def label(h):
    return f"{h['title']}, {h['section']}" + (f", page {h['page']}" if h.get("page") else "")


def answer(question, api_key=None, filters=None, mode="hybrid"):
    """Return {"text", "sources", "cost_usd", "seconds"}. api_key: the visitor's key in Week 3."""
    t0 = time.time()
    client = OpenAI(api_key=api_key) if api_key else OpenAI()
    k = TOP_K * 2 if USE_RERANK else TOP_K
    hits = kb().hybrid(question, client, k=k, filters=filters, mode=mode)
    spent = len(question) / 4 * PRICES["text-embedding-3-small"][0] / 1e6
    best = max((h["similarity"] or 0 for h in hits), default=0)
    if not hits or (mode != "keyword" and best < MIN_SIMILARITY):
        return {"text": NOT_FOUND, "sources": [], "cost_usd": spent, "seconds": time.time() - t0}
    if USE_RERANK:
        hits = rerank(question, hits, client, CHAT_MODEL, keep=TOP_K)
    sources = "\n\n".join(f"[{n}] ({label(h)})\n{h['text']}" for n, h in enumerate(hits, 1))
    resp = client.responses.create(
        model=CHAT_MODEL,
        instructions=PROMPT,
        input=f"Sources:\n\n{sources}\n\nQuestion: {question}",
        max_output_tokens=2000,
        reasoning={"effort": "low"},
    )
    spent += cost(CHAT_MODEL, getattr(resp, "usage", None))
    return {"text": resp.output_text or NOT_FOUND, "sources": hits, "cost_usd": spent, "seconds": time.time() - t0}


if __name__ == "__main__":
    while True:
        q = input("\nQuestion (Enter to quit): ").strip()
        if not q:
            break
        r = answer(q)
        print("\n" + r["text"])
        for n, h in enumerate(r["sources"], 1):
            sim = f"{h['similarity']:.2f}" if h["similarity"] is not None else "-"
            print(f"  [{n}] {label(h)}  (similarity {sim})")
        print(f"  {r['seconds']:.1f}s, about ${r['cost_usd']:.5f}")
