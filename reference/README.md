# Reference implementation (for mentors)

The tested code behind the Student Guide. Students write these files themselves, week by week, from the
guide; mentors use this folder to check what working code looks like.

| File | Week | What it does |
| --- | --- | --- |
| prepare.py | 1 | documents in data/raw + data/sources.csv -> clean sections in data/processed/records.jsonl |
| build_db.py | 1 | records -> knowledge.db: chunks, keywords, FTS5 keyword index, embeddings |
| check_db.py | 1 | keyword vs meaning search on the first 5 test questions |
| search.py | 2 | hybrid search (BM25 + vector, reciprocal rank fusion), filters, Week 3 reranking |
| rag.py, prompt.md | 2 | answers with numbered sources, refusal, cost per question |
| evaluate.py | 2-3 | retrieval score per search mode, answer score, cost and time |
| app.py | 3 | Streamlit app with bring-your-own-key and demo mode |
| make_demo.py | 3 | saves answers for demo mode |

Tested with a stand-in for the OpenAI client (no API calls); not yet run against the real API.
The student repo template is in ../starter.
