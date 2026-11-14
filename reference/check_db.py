"""Week 1, step 3: check the knowledge base before anyone builds on it.

    python check_db.py                     # the first 5 questions in eval/questions.csv
    python check_db.py "hostel gate time"  # or your own question

For each question it shows the top 3 chunks found by keyword search and by meaning search,
and whether the section your test question points to (source_id) was found.
"""
import csv
import re
import sqlite3
import sys

import numpy as np
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
con = sqlite3.connect("knowledge.db")

n_docs, n_chunks, n_emb = (con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("documents", "chunks", "embeddings"))
lengths = [len(t.split()) for (t,) in con.execute("SELECT text FROM chunks")]
print(f"{n_docs} documents, {n_chunks} chunks, {n_emb} embeddings")
print(f"chunk length in words: min {min(lengths)}, median {sorted(lengths)[len(lengths) // 2]}, max {max(lengths)}")
if n_emb != n_chunks:
    print("WARNING: some chunks have no embedding. Run build_db.py again.")
no_kw = con.execute("SELECT COUNT(*) FROM chunks WHERE keywords = ''").fetchone()[0]
if no_kw:
    print(f"WARNING: {no_kw} chunks have no keywords.")

ids, mat = [], []
for cid, vec in con.execute("SELECT chunk_id, vector FROM embeddings"):
    ids.append(cid)
    mat.append(np.frombuffer(vec, dtype=np.float32))
mat = np.vstack(mat)
mat /= np.linalg.norm(mat, axis=1, keepdims=True)
client = OpenAI()


def keyword_top(q, k=3):
    terms = re.findall(r"\w+", q.lower())
    if not terms:
        return []
    match = " OR ".join(f'"{t}"' for t in terms)
    return [r[0] for r in con.execute(
        "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?", (match, k))]


def vector_top(q, k=3):
    v = np.asarray(client.embeddings.create(model="text-embedding-3-small", input=[q]).data[0].embedding, dtype=np.float32)
    scores = mat @ (v / np.linalg.norm(v))
    return [ids[i] for i in np.argsort(-scores)[:k]]


if len(sys.argv) > 1:
    questions = [(" ".join(sys.argv[1:]), "")]
else:
    rows = list(csv.DictReader(open("eval/questions.csv", encoding="utf-8-sig")))
    questions = [(r["question"], r["source_id"]) for r in rows if r.get("should_answer", "yes").lower() == "yes"][:5]

found = {"keyword": 0, "meaning": 0}
for q, want in questions:
    print(f"\nQ: {q}" + (f"   (answer is in {want})" if want else ""))
    for name, hits in (("keyword", keyword_top(q)), ("meaning", vector_top(q))):
        ok = bool(want) and any(h.split("~")[0] == want for h in hits)
        found[name] += ok
        print(f"  {name:8} {'FOUND' if ok else '     '}  " + ", ".join(hits))
if questions and questions[0][1]:
    print(f"\nRight section in the top 3: keyword {found['keyword']}/{len(questions)}, meaning {found['meaning']}/{len(questions)}")
