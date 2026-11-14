"""Week 1, step 1: turn the documents in data/raw/ into clean, structured records.

    python prepare.py

Reads every file listed in data/sources.csv (PDF, Markdown, text or saved web page),
extracts the text, cleans it, removes personal data, splits it into the document's own
sections, and writes one record per section to data/processed/records.jsonl.
"""
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from bs4 import BeautifulSoup
from pypdf import PdfReader

RAW = Path("data/raw")
SOURCES = Path("data/sources.csv")
OUT = Path("data/processed/records.jsonl")
MIN_SECTION_CHARS = 80   # shorter sections are joined to the one before

# Personal data we never keep. Add patterns for anything else your documents contain.
PII = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[email removed]"),
    (re.compile(r"(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), "[phone removed]"),
    (re.compile(r"(?<!\d)\d{4}\s\d{4}\s\d{4}(?!\d)"), "[id number removed]"),
]


def read_pages(path):
    """Return a list of (page number or None, text)."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return [(i + 1, p.extract_text() or "") for i, p in enumerate(PdfReader(path).pages)]
    text = path.read_text(encoding="utf-8", errors="ignore")
    if suffix in (".html", ".htm"):
        soup = BeautifulSoup(text, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer"]):
            tag.decompose()
        # keep headings recognisable for the section splitter
        for h in soup.find_all(["h1", "h2", "h3", "h4"]):
            h.insert_before("\n# ")
        text = soup.get_text("\n")
    return [(None, text)]


def clean(pages):
    """Remove repeated headers and footers, page numbers, broken hyphenation and personal data."""
    lines_per_page = [[ln.strip() for ln in text.splitlines()] for _, text in pages]
    # a line that appears on more than half of the pages is a header or footer
    counts = Counter(ln for lines in lines_per_page for ln in set(lines) if ln)
    repeated = {ln for ln, n in counts.items() if len(pages) > 2 and n > len(pages) / 2}
    out, removed = [], Counter()
    for (page, _), lines in zip(pages, lines_per_page):
        keep = []
        for ln in lines:
            if ln in repeated or re.fullmatch(r"(page\s*)?\d+(\s*of\s*\d+)?", ln, re.I):
                continue
            keep.append(ln)
        text = "\n".join(keep)
        text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # join words broken across lines
        for pattern, label in PII:
            text, n = pattern.subn(label, text)
            removed[label] += n
        out.append((page, text))
    return out, removed


def is_heading(line):
    if line.startswith("#"):
        return True
    if not (3 <= len(line) <= 80) or line.endswith((".", ",", ";", ":")):
        return False
    words = line.split()
    if len(words) > 10:
        return False
    numbered = re.match(r"^(\d+(\.\d+)*\.?|[IVX]+\.)\s+\w", line)
    return bool(numbered) or line.isupper() or sum(w[:1].isupper() for w in words) >= max(1, len(words) - 1)


def sections(pages, title):
    """Split cleaned pages into (section name, first page, text)."""
    out, name, page_start, buf = [], title, pages[0][0] if pages else None, []
    for page, text in pages:
        for line in text.splitlines():
            if not line:
                buf.append("")
                continue
            if is_heading(line):
                if "".join(buf).strip():
                    out.append([name, page_start, "\n".join(buf).strip()])
                name, page_start, buf = line.lstrip("# ").strip()[:120], page, []
            else:
                buf.append(line)
    if "".join(buf).strip():
        out.append([name, page_start, "\n".join(buf).strip()])
    merged = []
    for sec in out:
        if merged and len(sec[2]) < MIN_SECTION_CHARS:
            merged[-1][2] += "\n" + sec[2]
        else:
            merged.append(sec)
    return merged


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50]


def main():
    sources = {r["file"].strip(): r for r in csv.DictReader(SOURCES.open(encoding="utf-8-sig"))}
    files = sorted(p for p in RAW.rglob("*") if p.is_file() and not p.name.startswith("."))
    missing = [p.name for p in files if p.name not in sources]
    if missing:
        print("Not in data/sources.csv, skipped (add a row for each):", ", ".join(missing))

    records, seen, total_removed = [], set(), Counter()
    for path in files:
        meta = sources.get(path.name)
        if not meta:
            continue
        pages, removed = clean(read_pages(path))
        total_removed.update(removed)
        text_chars = sum(len(t.strip()) for _, t in pages)
        if text_chars < 100:
            print(f"WARNING {path.name}: almost no text. Scanned PDF? Replace it with a text version.")
            continue
        title = meta.get("title") or path.stem
        for i, (name, page, text) in enumerate(sections(pages, title), 1):
            text = re.sub(r"[ \t]+", " ", text)
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            h = hashlib.sha1(text.lower().encode()).hexdigest()
            if h in seen:  # the same text twice (a repeated page or copied section)
                continue
            seen.add(h)
            records.append({
                "id": f"{slug(path.stem)}#{i}",
                "file": path.name,
                "title": title,
                "section": name,
                "page": page,
                "source_url": meta.get("source_url", ""),
                "date": meta.get("date", ""),
                "doc_type": meta.get("doc_type", ""),
                "audience": meta.get("audience", ""),
                "text": text,
            })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"{len(records)} records from {len({r['file'] for r in records})} files -> {OUT}")
    if total_removed:
        print("Personal data removed:", dict(total_removed))


if __name__ == "__main__":
    main()
