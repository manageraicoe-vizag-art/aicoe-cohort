"""Week 2: hybrid search over knowledge.db.

keyword()  BM25 over the chunks' text, title, section and keywords (SQLite FTS5)
vector()   cosine similarity between the question's embedding and every chunk's
hybrid()   both lists merged by reciprocal rank fusion (RRF)
rerank()   Week 3 experiment: a small model re-orders the best candidates
"""
import json
import re
import sqlite3

import numpy as np

EMBED_MODEL = "text-embedding-3-small"
RRF_K = 60          # standard constant for reciprocal rank fusion
CANDIDATES = 20     # how many results each search contributes before fusing


class KnowledgeBase:
    def __init__(self, path="knowledge.db"):
        self.con = sqlite3.connect(path, check_same_thread=False)
        rows = self.con.execute("""
            SELECT c.chunk_id, c.record_id, c.section, c.page, c.text, d.title, d.source_url, d.doc_type, d.audience, e.vector
            FROM chunks c JOIN documents d ON d.doc_id = c.doc_id JOIN embeddings e ON e.chunk_id = c.chunk_id
            ORDER BY c.chunk_id""").fetchall()
        cols = ["chunk_id", "record_id", "section", "page", "text", "title", "source_url", "doc_type", "audience"]
        self.chunks = [dict(zip(cols, r[:-1])) for r in rows]
        self.index = {c["chunk_id"]: i for i, c in enumerate(self.chunks)}
        mat = np.vstack([np.frombuffer(r[-1], dtype=np.float32) for r in rows])
        self.matrix = mat / np.linalg.norm(mat, axis=1, keepdims=True)

    def _allowed(self, filters):
        if not filters:
            return None
        return {c["chunk_id"] for c in self.chunks if all(c.get(k) == v for k, v in filters.items() if v)}

    def keyword(self, question, k=CANDIDATES, filters=None):
        terms = [t for t in re.findall(r"\w+", question.lower()) if len(t) > 1]
        if not terms:
            return []
        match = " OR ".join(f'"{t}"' for t in terms)
        # column weights: chunk_id (unused), title, section, text, keywords
        rows = self.con.execute(
            "SELECT chunk_id, bm25(chunks_fts, 0, 2.0, 2.0, 1.0, 3.0) AS s FROM chunks_fts "
            "WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?", (match, k * 3)).fetchall()
        allowed = self._allowed(filters)
        return [(cid, -s) for cid, s in rows if allowed is None or cid in allowed][:k]

    def embed(self, client, question):
        v = np.asarray(client.embeddings.create(model=EMBED_MODEL, input=[question]).data[0].embedding, dtype=np.float32)
        return v / np.linalg.norm(v)

    def vector(self, qvec, k=CANDIDATES, filters=None):
        scores = self.matrix @ qvec
        allowed = self._allowed(filters)
        out = []
        for i in np.argsort(-scores):
            cid = self.chunks[i]["chunk_id"]
            if allowed is None or cid in allowed:
                out.append((cid, float(scores[i])))
            if len(out) == k:
                break
        return out

    def hybrid(self, question, client, k=5, filters=None, mode="hybrid"):
        """Return the top k chunks as dicts, each with its scores. mode: hybrid, keyword or vector."""
        kw = self.keyword(question, filters=filters) if mode in ("hybrid", "keyword") else []
        vec = self.vector(self.embed(client, question), filters=filters) if mode in ("hybrid", "vector") else []
        fused = {}
        for ranked in (kw, vec):
            for rank, (cid, _) in enumerate(ranked):
                fused[cid] = fused.get(cid, 0) + 1 / (RRF_K + rank + 1)
        best_sim = dict(vec)
        top = sorted(fused, key=lambda c: -fused[c])[:k]
        return [{**self.chunks[self.index[c]], "rrf": fused[c], "similarity": best_sim.get(c)} for c in top]


def rerank(question, hits, client, model, keep=5):
    """Week 3 experiment: ask a small model to score each candidate 0-10 and keep the best."""
    listing = "\n\n".join(f"[{i}] {h['title']} | {h['section']}\n{h['text'][:800]}" for i, h in enumerate(hits))
    resp = client.responses.create(
        model=model,
        instructions="Rate how well each passage answers the question, 0 (useless) to 10 (answers it fully). "
                     'Reply with JSON only: {"scores": [score for passage 0, score for passage 1, ...]}',
        input=f"Question: {question}\n\nPassages:\n{listing}",
        reasoning={"effort": "none"},  # a quick scoring job: no thinking needed
    )
    try:
        scores = json.loads(re.search(r"\{.*\}", resp.output_text, re.S).group())["scores"]
    except (AttributeError, ValueError, KeyError):
        return hits[:keep]  # if the reply can't be read, keep the original order
    order = sorted(range(len(hits)), key=lambda i: -(scores[i] if i < len(scores) else 0))
    return [hits[i] for i in order][:keep]
