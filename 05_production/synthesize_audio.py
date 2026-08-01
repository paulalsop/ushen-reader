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
CHUNK_SIZE = 2800
MAX_RETRIES = 3
DEFAULT_BATCH = 12

# Stable reader-facing ids mapped to Edge neural voices.
VOICE_CATALOG = (
    {"id": "xiaoxiao", "label": "晓晓", "edge": "zh-CN-XiaoxiaoNeural"},
    {"id": "yunjian", "label": "云健", "edge": "zh-CN-YunjianNeural"},
)


def enabled_voices() -> list[dict[str, str]]:
    raw = os.environ.get("USHEN_TTS_VOICES", "").strip()
    if not raw:
        return [dict(item) for item in VOICE_CATALOG]
    wanted = {part.strip() for part in raw.split(",") if part.strip()}
    selected = [dict(item) for item in VOICE_CATALOG if item["id"] in wanted or item["edge"] in wanted]
    return selected or [dict(item) for item in VOICE_CATALOG]


def content_hash(text: str, edge_voice: str) -> str:
    payload = f"{edge_voice}\n{text}".encode("utf-8")
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


async def synthesize_text(text: str, destination: Path, edge_voice: str) -> None:
    import edge_tts

    chunks = split_chunks(text)
    if len(chunks) == 1:
        communicate = edge_tts.Communicate(chunks[0], edge_voice)
        await communicate.save(str(destination))
        return

    parts_dir = destination.with_suffix(".parts")
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_files: list[Path] = []
    try:
        for index, chunk in enumerate(chunks):
            part_path = parts_dir / f"{index:03d}.mp3"
            communicate = edge_tts.Communicate(chunk, edge_voice)
            await communicate.save(str(part_path))
            part_files.append(part_path)
            await asyncio.sleep(0.35)

        with destination.open("wb") as output:
            for part_path in part_files:
                output.write(part_path.read_bytes())
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


def cache_path_for(text: str, edge_voice: str) -> Path:
    return CACHE_DIR / f"{content_hash(text, edge_voice)}.mp3"


def audio_url(voice_id: str, number: int) -> str:
    return f"audio/{voice_id}/{number:03d}.mp3"


def copy_cached_audio(number: int, text: str, voice: dict[str, str], audio_dir: Path) -> str | None:
    cached = cache_path_for(text, voice["edge"])
    if not cached.exists() or cached.stat().st_size <= 0:
        return None
    voice_dir = audio_dir / voice["id"]
    voice_dir.mkdir(parents=True, exist_ok=True)
    target = voice_dir / f"{number:03d}.mp3"
    shutil.copy2(cached, target)
    return audio_url(voice["id"], number)


async def synthesize_chapter_voice(
    number: int,
    text: str,
    voice: dict[str, str],
    audio_dir: Path,
) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    voice_dir = audio_dir / voice["id"]
    voice_dir.mkdir(parents=True, exist_ok=True)

    cached = cache_path_for(text, voice["edge"])
    target = voice_dir / f"{number:03d}.mp3"
    url = audio_url(voice["id"], number)

    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            temporary = CACHE_DIR / f"{content_hash(text, voice['edge'])}.partial.mp3"
            await synthesize_text(text, temporary, voice["edge"])
            temporary.replace(cached)
            shutil.copy2(cached, target)
            print(f"  audio ok  ch{number:03d}/{voice['id']} ({attempt}/{MAX_RETRIES})")
            return url
        except Exception as error:  # noqa: BLE001 - keep build resilient
            last_error = error
            print(
                f"  audio fail ch{number:03d}/{voice['id']} attempt {attempt}: {error}",
                file=sys.stderr,
            )
            await asyncio.sleep(1.5 * attempt)

    print(f"  audio skip ch{number:03d}/{voice['id']}: {last_error}", file=sys.stderr)
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


def chapter_audio_map(chapter: dict[str, object]) -> dict[str, str]:
    audio = chapter.get("audio")
    if isinstance(audio, dict):
        return {str(key): str(value) for key, value in audio.items() if value}
    # Backward compatibility with older single-url builds.
    legacy = chapter.get("audioUrl")
    if isinstance(legacy, str) and legacy:
        return {"xiaoxiao": legacy}
    return {}


async def attach_audio(
    chapters: list[dict[str, object]],
    dist: Path,
    *,
    enabled: bool | None = None,
) -> list[dict[str, str]]:
    voices = enabled_voices()
    if not should_synthesize(enabled):
        print("Audio synthesis skipped (set USHEN_TTS=1 to enable locally).")
        return voices
    if not edge_tts_available():
        print("edge-tts not installed; skipping audio synthesis.", file=sys.stderr)
        return voices

    audio_dir = dist / "audio"
    published = [chapter for chapter in chapters if chapter.get("status") == "published"]
    hard_limit = os.environ.get("USHEN_TTS_LIMIT", "").strip()
    if hard_limit.isdigit():
        published = published[: int(hard_limit)]

    pending: list[tuple[dict[str, object], str]] = []
    cached_files = 0

    for chapter in published:
        number = int(chapter["number"])
        source = dist / str(chapter["url"])
        if not source.exists():
            continue
        text = source.read_text(encoding="utf-8")
        audio_map: dict[str, str] = {}
        missing = False
        for voice in voices:
            audio_url = copy_cached_audio(number, text, voice, audio_dir)
            if audio_url:
                audio_map[voice["id"]] = audio_url
                cached_files += 1
            else:
                missing = True
        if audio_map:
            chapter["audio"] = audio_map
            chapter["audioUrl"] = next(iter(audio_map.values()))
        if missing:
            pending.append((chapter, text))

    pending.sort(key=lambda item: int(item[0]["number"]))
    budget = batch_limit()
    to_synthesize = pending if budget <= 0 else pending[:budget]
    deferred = 0 if budget <= 0 else max(0, len(pending) - budget)
    labels = ", ".join(f"{voice['label']}({voice['id']})" for voice in voices)

    print(
        f"Audio plan [{labels}]: {cached_files} cached files, "
        f"{len(to_synthesize)} chapters to fill this run, {deferred} chapters deferred"
    )

    synthesized_files = 0
    for chapter, text in to_synthesize:
        number = int(chapter["number"])
        audio_map = chapter_audio_map(chapter)
        for voice in voices:
            if voice["id"] in audio_map:
                continue
            audio_url = await synthesize_chapter_voice(number, text, voice, audio_dir)
            if audio_url:
                audio_map[voice["id"]] = audio_url
                synthesized_files += 1
        if audio_map:
            chapter["audio"] = audio_map
            chapter["audioUrl"] = audio_map.get("xiaoxiao") or next(iter(audio_map.values()))

    ready = sum(1 for chapter in published if chapter_audio_map(chapter))
    print(
        f"Audio summary: {ready}/{len(published)} chapters have audio "
        f"({cached_files} from cache, {synthesized_files} newly synthesized, {deferred} chapters still pending)"
    )
    return voices


def synthesize_chapters(
    chapters: list[dict[str, object]],
    dist: Path,
    *,
    enabled: bool | None = None,
) -> list[dict[str, str]]:
    return asyncio.run(attach_audio(chapters, dist, enabled=enabled))
