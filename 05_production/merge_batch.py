#!/usr/bin/env python3
"""Merge a finished batch: validate chapters, update V01/LEDGER/matrix/audit, build reader."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BAN = re.compile(
    r"即时目标|核心选择|最终目标|结构评分|记忆点捕获|感谢您的理解|重复领取概不补发|"
    r"我困了|认命了|大概吧|泪刀|泪点|剧透|翻篇|案[一二三四五六七八九十\d]+"
)


def chapter_files(start: int, end: int) -> list[Path]:
    out = []
    for n in range(start, end + 1):
        ps = list((ROOT / "章节").glob(f"第{n:03d}章*.txt"))
        if not ps:
            raise SystemExit(f"missing chapter {n}")
        out.append(ps[0])
    return out


def validate(files: list[Path]) -> None:
    for p in files:
        t = p.read_text(encoding="utf-8")
        if t.count("【章末自报】") != 1:
            raise SystemExit(f"{p.name}: bad report marker")
        body = t.split("【章末自报】", 1)[0]
        cn = sum("\u4e00" <= c <= "\u9fff" for c in body)
        if not 2800 <= cn <= 4500:
            raise SystemExit(f"{p.name}: chars={cn}")
        hits = BAN.findall(body)
        if hits:
            raise SystemExit(f"{p.name}: banned {hits}")
        print(f"OK {p.name} {cn}")


def mark_cards(cards: Path, start: int, end: int, summaries: dict[int, str]) -> None:
    t = cards.read_text(encoding="utf-8")
    parts = re.split(r"(?=^### 第\d{3}章)", t, flags=re.M)
    out = []
    for b in parts:
        m = re.match(r"### 第(\d{3})章 ([^\n]+)", b)
        if m and int(m.group(1)) in summaries:
            n = int(m.group(1))
            title = m.group(2).strip()
            out.append(f"### 第{n:03d}章 {title}\n{summaries[n]}\n\n")
        else:
            out.append(b)
    cards.write_text("".join(out), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--start", type=int, required=True)
    ap.add_argument("--end", type=int, required=True)
    ap.add_argument("--matrix-line", required=True, help="exact pending matrix row to mark done")
    ap.add_argument("--audit", required=True)
    ap.add_argument("--ledger", required=True, help="path to replacement LEDGER.md content file")
    ap.add_argument("--summary", action="append", required=True, help="N:summary")
    ap.add_argument("--cards", default="03_structure/cards/V01.md")
    ap.add_argument("--matrix", default="审核日志/BATCH_MATRIX_V01.md")
    ap.add_argument("--audit-name", default="", help="override audit filename stem, e.g. V02_01")
    args = ap.parse_args()

    files = chapter_files(args.start, args.end)
    validate(files)

    summaries = {}
    for item in args.summary:
        n_s, s = item.split(":", 1)
        summaries[int(n_s)] = s
    mark_cards(ROOT / args.cards, args.start, args.end, summaries)

    matrix = ROOT / args.matrix
    mt = matrix.read_text(encoding="utf-8")
    if args.matrix_line not in mt:
        raise SystemExit("matrix line not found")
    matrix.write_text(mt.replace(args.matrix_line, args.matrix_line.replace("| pending |", "| done |")), encoding="utf-8")

    audit_stem = args.audit_name or f"BATCH_{args.batch}"
    (ROOT / f"审核日志/{audit_stem}_读者体验审计.md").write_text(args.audit + "\n", encoding="utf-8")
    (ROOT / "06_continuity/LEDGER.md").write_text(Path(args.ledger).read_text(encoding="utf-8"), encoding="utf-8")

    subprocess.check_call(["python3", str(ROOT / "build_reader.py")])
    d = json.loads((ROOT / "dist/chapters.json").read_text(encoding="utf-8"))
    print("reader", len(d["chapters"]))


if __name__ == "__main__":
    main()
