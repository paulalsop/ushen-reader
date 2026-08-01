#!/usr/bin/env python3
"""Build the dependency-free static reader for GitHub Pages."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
NUMBER_RE = re.compile(r"第(\d+)章")
sys.path.insert(0, str(ROOT / "05_production"))

from synthesize_audio import synthesize_chapters  # noqa: E402


def chapter_number(path: Path) -> int:
    match = NUMBER_RE.search(path.stem)
    return int(match.group(1)) if match else 999_999


def chapter_title(path: Path) -> str:
    with path.open(encoding="utf-8") as handle:
        first_line = handle.readline().strip()
    return first_line or path.stem.replace("_", " ")


def reader_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    separator = "\n---\n"
    if text.count(separator) != 1 or text.count("【章末自报】") != 1:
        raise ValueError(f"{path.name}: expected one final separator and one chapter report")
    body, report = text.split(separator, 1)
    if not report.lstrip().startswith("【章末自报】"):
        raise ValueError(f"{path.name}: separator must be immediately followed by chapter report")
    published = body.rstrip() + "\n"
    if "【章末自报】" in published or "\n---\n" in published:
        raise ValueError(f"{path.name}: production metadata leaked into reader text")
    return published


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


def build(*, with_audio: bool | None = None) -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    for asset in ("index.html", "reader.css", "reader.js"):
        shutil.copy2(ROOT / "reader" / asset, DIST / asset)

    chapters = collect_chapters()
    synthesize_chapters(chapters, DIST, enabled=with_audio)

    payload = {
        "book": "有神",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "chapters": chapters,
    }
    (DIST / "chapters.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DIST / ".nojekyll").touch()
    audio_count = sum(1 for chapter in chapters if chapter.get("audioUrl"))
    print(f"Built reader with {len(chapters)} chapters ({audio_count} with audio) in {DIST}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the static novel reader")
    parser.add_argument(
        "--with-audio",
        action="store_true",
        help="Synthesize chapter audio with edge-tts (also enabled in GitHub Actions)",
    )
    parser.add_argument(
        "--skip-audio",
        action="store_true",
        help="Skip audio synthesis even in CI",
    )
    args = parser.parse_args()
    enabled: bool | None
    if args.skip_audio:
        enabled = False
    elif args.with_audio:
        enabled = True
    else:
        enabled = None
    build(with_audio=enabled)


if __name__ == "__main__":
    main()
