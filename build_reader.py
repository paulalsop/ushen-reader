#!/usr/bin/env python3
"""Build the dependency-free static reader for GitHub Pages."""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
NUMBER_RE = re.compile(r"第(\d+)章")


def chapter_number(path: Path) -> int:
    match = NUMBER_RE.search(path.stem)
    return int(match.group(1)) if match else 999_999


def chapter_title(path: Path) -> str:
    with path.open(encoding="utf-8") as handle:
        first_line = handle.readline().strip()
    return first_line or path.stem.replace("_", " ")


def reader_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"\n---\s*\n\s*【章末自报】.*\Z", "", text, flags=re.DOTALL)
    return text.rstrip() + "\n"


def collect_chapters() -> list[dict[str, object]]:
    chapters: list[dict[str, object]] = []
    sources = (
        ("published", ROOT / "章节"),
        ("draft", ROOT / "合并队列"),
    )

    for status, source_dir in sources:
        if not source_dir.exists():
            continue
        for source in source_dir.glob("*.txt"):
            destination_dir = DIST / "content" / status
            destination_dir.mkdir(parents=True, exist_ok=True)
            destination = destination_dir / source.name
            destination.write_text(reader_text(source), encoding="utf-8")
            chapters.append(
                {
                    "id": f"{status}-{source.stem}",
                    "number": chapter_number(source),
                    "title": chapter_title(source),
                    "status": status,
                    "url": destination.relative_to(DIST).as_posix(),
                    "updatedAt": datetime.fromtimestamp(
                        source.stat().st_mtime, timezone.utc
                    ).isoformat(),
                }
            )

    # Published chapters take precedence when the same chapter is present in drafts.
    chapters.sort(key=lambda item: (int(item["number"]), item["status"] != "published"))
    seen: set[int] = set()
    unique: list[dict[str, object]] = []
    for chapter in chapters:
        number = int(chapter["number"])
        if number in seen:
            continue
        seen.add(number)
        unique.append(chapter)
    return unique


def build() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    for asset in ("index.html", "reader.css", "reader.js"):
        shutil.copy2(ROOT / "reader" / asset, DIST / asset)

    payload = {
        "book": "有神",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "chapters": collect_chapters(),
    }
    (DIST / "chapters.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DIST / ".nojekyll").touch()
    print(f"Built reader with {len(payload['chapters'])} chapters in {DIST}")


if __name__ == "__main__":
    build()
