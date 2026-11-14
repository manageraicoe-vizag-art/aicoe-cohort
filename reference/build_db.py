"""Week 1, step 2: build the knowledge base, knowledge.db, from data/processed/records.jsonl.

    python build_db.py

Cuts each record into chunks, picks keywords for each chunk, builds a BM25 keyword index
(SQLite FTS5) and stores an embedding for every chunk. Chunks whose text hasn't changed
keep their old embedding, so running it again costs almost nothing.
"""
import hashlib
import json
import math
import re
import sqlite3
from collections import Counter
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

RECORDS = Path("data/processed/records.jsonl")
DB = Path("knowledge.db")
EMBED_MODEL = "text-embedding-3-small"
CHUNK_WORDS = 250      # target chunk size
OVERLAP_WORDS = 40     # words shared between neighbouring chunks of the same section
KEYWORDS_PER_CHUNK = 8
MAX_CHUNKS = 500       # programme limit: the knowledge base holds at most this many chunks

STOP = set("""a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it
its may more most must no not of on or our shall she should so such than that the their them then there these they this those
to under up upon us was we were what when where which while who will with would you your also any each other only same per
all one two after before between during about over within without being""".split())


def chunk(text):
    """Split one section's text into overlapping pieces of about CHUNK_WORDS words."""
    words = text.split()
    if len(words) <= CHUNK_WORDS + OVERLAP_WORDS:
        return [text]
    out, start = [], 0
    while start < len(words):
        end = min(start + CHUNK_WORDS, len(words))
        out.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start = end - OVERLAP_WORDS
    return out


def tokens(text):
    text = re.sub(r"\[[a-z ]+ removed\]", " ", text)  # labels left by prepare.py are not keywords
    return [w for w in re.findall(r"[a-z][a-z0-9]{2,}", text.lower()) if w not in STOP]


def keywords(chunks):
    """Top TF-IDF terms of each chunk, plus names, codes and numbers that people search for exactly."""
    df = Counter()
    toks = [tokens(c["text"]) for c in chunks]
    for t in toks:
        df.update(set(t))
    n = len(chunks)
    out = []
    for c, t in zip(chunks, toks):
        tf = Counter(t)
        scored = sorted(tf, key=lambda w: -tf[w] * math.log((n + 1) / (df[w] + 0.5)))
        exact = re.findall(r"\b(?:[A-Z]{2,}[A-Z0-9-]*|\d[\d,]{2,}\d|[A-Z][a-z]+[A-Z]\w*)\b", c["text"])
        kw = list(dict.fromkeys(scored[:KEYWORDS_PER_CHUNK] + exact[:5]))
        out.append(" ".join(kw))
    return out


def create_tables(con):
    con.executescript("""
    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS chunks_fts;
    CREATE TABLE documents (doc_id TEXT PRIMARY KEY, file TEXT, title TEXT, source_url TEXT,
                            date TEXT, doc_type TEXT, audience TEXT);
    CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, record_id TEXT, doc_id TEXT, section TEXT,
                         page INTEGER, position INTEGER, text TEXT, keywords TEXT, text_hash TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, title, section, text, keywords,
                                               tokenize = 'porter unicode61');
    CREATE TABLE IF NOT EXISTS embeddings (chunk_id TEXT PRIMARY KEY, model TEXT, text_hash TEXT, vector BLOB);
    """)


def embed_text(c):
    # the title and section travel with the text, so a chunk keeps its context
    return f"{c['title']} | {c['section']}\n{c['text']}"


def main():
    records = [json.loads(line) for line in RECORDS.open(encoding="utf-8")]
    chunks = []
    for r in records:
        for i, piece in enumerate(chunk(r["text"])):
            chunks.append({**r, "chunk_id": f"{r['id']}~{i}", "record_id": r["id"], "position": i, "text": piece})
    if len(chunks) > MAX_CHUNKS:
        raise SystemExit(f"{len(chunks)} chunks is over the limit of {MAX_CHUNKS}. Use fewer or shorter documents "
                         "(keep the ones your users need most), then run prepare.py and build_db.py again.")
    for c, kw in zip(chunks, keywords(chunks)):
        c["keywords"] = kw
        c["text_hash"] = hashlib.sha1(embed_text(c).encode()).hexdigest()

    con = sqlite3.connect(DB)
    create_tables(con)
    docs = {}
    for r in records:
        doc_id = r["id"].split("#")[0]
        docs[doc_id] = (doc_id, r["file"], r["title"], r["source_url"], r["date"], r["doc_type"], r["audience"])
    con.executemany("INSERT INTO documents VALUES (?,?,?,?,?,?,?)", docs.values())
    con.executemany("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)", [
        (c["chunk_id"], c["record_id"], c["record_id"].split("#")[0], c["section"], c["page"], c["position"],
         c["text"], c["keywords"], c["text_hash"]) for c in chunks])
    con.executemany("INSERT INTO chunks_fts VALUES (?,?,?,?,?)", [
        (c["chunk_id"], c["title"], c["section"], c["text"], c["keywords"]) for c in chunks])

    # embeddings: reuse the ones whose text and model are unchanged
    have = {cid: h for cid, h in con.execute("SELECT chunk_id, text_hash FROM embeddings WHERE model = ?", (EMBED_MODEL,))}
    todo = [c for c in chunks if have.get(c["chunk_id"]) != c["text_hash"]]
    if todo:
        est_tokens = sum(len(embed_text(c)) for c in todo) / 4
        usd = est_tokens * 0.02 / 1e6
        print(f"Embedding {len(todo)} chunks (about {est_tokens / 1000:.0f}k tokens, " + ("less than one cent" if usd < 0.01 else f"about ${usd:.2f}") + ")...")
        client = OpenAI()
        for i in range(0, len(todo), 100):
            batch = todo[i:i + 100]
            resp = client.embeddings.create(model=EMBED_MODEL, input=[embed_text(c) for c in batch])
            con.executemany("INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?)", [
                (c["chunk_id"], EMBED_MODEL, c["text_hash"], np.asarray(d.embedding, dtype=np.float32).tobytes())
                for c, d in zip(batch, resp.data)])
            con.commit()
    con.execute("DELETE FROM embeddings WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks) OR model != ?", (EMBED_MODEL,))
    con.commit()
    n_emb = con.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
    con.execute("VACUUM")
    con.close()
    print(f"{len(chunks)} chunks from {len(records)} records; {len(todo)} newly embedded, {n_emb} embeddings in {DB}")


if __name__ == "__main__":
    main()
