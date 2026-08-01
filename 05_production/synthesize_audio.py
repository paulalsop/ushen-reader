#!/usr/bin/env python3
"""Synthesize chapter audio with edge-tts for the static reader."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / ".tts-cache"
VOICE = os.environ.get("USHEN_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
CHUNK_SIZE = 2800
MAX_RETRIES = 3
DEFAULT_BATCH = 15


def content_hash(text: str) -> str:
    payload = f"{VOICE}\n{text}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:24]


def batch_limit() -> int:
    raw = os.environ.get("USHEN_TTS_BATCH", "").strip()
    if raw.isdigit():
        return max(0, int(raw))
    return DEFAULT_BATCH


def split_chunks(text: str) -> list[str]:
    cleaned = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(cleaned) <= CHUNK_SIZE:
        return [cleaned]

    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", cleaned) if part.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        candidate = paragraph if not current else f"{current}\n\n{paragraph}"
        if current and len(candidate) > CHUNK_SIZE:
            chunks.append(current)
            current = paragraph
        else:
            current = candidate
        while len(current) > CHUNK_SIZE:
            chunks.append(current[:CHUNK_SIZE])
            current = current[CHUNK_SIZE:].lstrip()
    if current:
        chunks.append(current)
    return chunks


async def synthesize_text(text: str, destination: Path) -> None:
    import edge_tts

    chunks = split_chunks(text)
    if len(chunks) == 1:
        communicate = edge_tts.Communicate(chunks[0], VOICE)
        await communicate.save(str(destination))
        return

    parts_dir = destination.with_suffix(".parts")
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_files: list[Path] = []
    try:
        for index, chunk in enumerate(chunks):
            part_path = parts_dir / f"{index:03d}.mp3"
            communicate = edge_tts.Communicate(chunk, VOICE)
            await communicate.save(str(part_path))
            part_files.append(part_path)
            await asyncio.sleep(0.35)

        with destination.open("wb") as output:
            for part_path in part_files:
                output.write(part_path.read_bytes())
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


def cache_path_for(text: str) -> Path:
    return CACHE_DIR / f"{content_hash(text)}.mp3"


def copy_cached_audio(number: int, text: str, audio_dir: Path) -> str | None:
    cached = cache_path_for(text)
    if not cached.exists() or cached.stat().st_size <= 0:
        return None
    audio_dir.mkdir(parents=True, exist_ok=True)
    relative = f"audio/{number:03d}.mp3"
    shutil.copy2(cached, audio_dir / f"{number:03d}.mp3")
    return relative


async def synthesize_chapter(number: int, text: str, audio_dir: Path) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    cached = cache_path_for(text)
    relative = f"audio/{number:03d}.mp3"
    target = audio_dir / f"{number:03d}.mp3"

    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            temporary = CACHE_DIR / f"{content_hash(text)}.partial.mp3"
            await synthesize_text(text, temporary)
            temporary.replace(cached)
            shutil.copy2(cached, target)
            print(f"  audio ok  ch{number:03d} ({attempt}/{MAX_RETRIES})")
            return relative
        except Exception as error:  # noqa: BLE001 - keep build resilient
            last_error = error
            print(f"  audio fail ch{number:03d} attempt {attempt}: {error}", file=sys.stderr)
            await asyncio.sleep(1.5 * attempt)

    print(f"  audio skip ch{number:03d}: {last_error}", file=sys.stderr)
    return None


def edge_tts_available() -> bool:
    try:
        import edge_tts  # noqa: F401

        return True
    except ImportError:
        return False


def should_synthesize(enabled: bool | None = None) -> bool:
    if enabled is not None:
        return enabled
    flag = os.environ.get("USHEN_TTS", "").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    if flag in {"1", "true", "yes", "on"}:
        return True
    return os.environ.get("GITHUB_ACTIONS") == "true"


async def attach_audio(
    chapters: list[dict[str, object]],
    dist: Path,
    *,
    enabled: bool | None = None,
) -> None:
    if not should_synthesize(enabled):
        print("Audio synthesis skipped (set USHEN_TTS=1 to enable locally).")
        return
    if not edge_tts_available():
        print("edge-tts not installed; skipping audio synthesis.", file=sys.stderr)
        return

    audio_dir = dist / "audio"
    published = [chapter for chapter in chapters if chapter.get("status") == "published"]
    hard_limit = os.environ.get("USHEN_TTS_LIMIT", "").strip()
    if hard_limit.isdigit():
        published = published[: int(hard_limit)]

    cached_count = 0
    pending: list[tuple[dict[str, object], str]] = []

    for chapter in published:
        number = int(chapter["number"])
        source = dist / str(chapter["url"])
        if not source.exists():
            continue
        text = source.read_text(encoding="utf-8")
        audio_url = copy_cached_audio(number, text, audio_dir)
        if audio_url:
            chapter["audioUrl"] = audio_url
            cached_count += 1
        else:
            pending.append((chapter, text))

    # Prefer earlier chapters so reading order fills first; content changes are
    # already cache misses because the hash includes chapter text.
    pending.sort(key=lambda item: int(item[0]["number"]))

    budget = batch_limit()
    to_synthesize = pending if budget <= 0 else pending[:budget]
    deferred = 0 if budget <= 0 else max(0, len(pending) - budget)

    print(
        f"Audio plan with {VOICE}: {cached_count} cached, "
        f"{len(to_synthesize)} to synthesize this run, {deferred} deferred"
    )

    synthesized = 0
    for chapter, text in to_synthesize:
        number = int(chapter["number"])
        audio_url = await synthesize_chapter(number, text, audio_dir)
        if audio_url:
            chapter["audioUrl"] = audio_url
            synthesized += 1

    ready = sum(1 for chapter in published if chapter.get("audioUrl"))
    print(
        f"Audio summary: {ready}/{len(published)} ready "
        f"({cached_count} from cache, {synthesized} newly synthesized, {deferred} still pending)"
    )


def synthesize_chapters(
    chapters: list[dict[str, object]],
    dist: Path,
    *,
    enabled: bool | None = None,
) -> None:
    asyncio.run(attach_audio(chapters, dist, enabled=enabled))
