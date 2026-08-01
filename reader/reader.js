const DEFAULT_VOICES = [
  { id: "xiaoxiao", label: "晓晓" },
  { id: "yunjian", label: "云健" },
];

const state = {
  chapters: [],
  voices: DEFAULT_VOICES,
  currentIndex: -1,
  generatedAt: null,
  prefetched: new Map(),
};

const isAppleSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const tts = {
  speechSupported: typeof window !== "undefined" && "speechSynthesis" in window,
  open: false,
  playing: false,
  paused: false,
  mode: "none", // audio | speech | none
  rate: Number(localStorage.getItem("ushen-tts-rate") || 1),
  autoNext: localStorage.getItem("ushen-tts-auto-next") !== "0",
  voiceId: localStorage.getItem("ushen-tts-voice") || "xiaoxiao",
  paragraphIndex: -1,
  resumeAfterChapter: false,
  voice: null,
  currentUtterance: null,
  watchdogId: null,
  chromeKeepAliveId: null,
  seeking: false,
  syncUnits: [],
  syncTotal: 0,
  syncIndex: -1,
};

const elements = {
  chapter: document.querySelector("#chapter"),
  chapterList: document.querySelector("#chapterList"),
  chapterCount: document.querySelector("#chapterCount"),
  syncTime: document.querySelector("#syncTime"),
  toolbarTitle: document.querySelector("#toolbarTitle"),
  previous: document.querySelector("#previousChapter"),
  next: document.querySelector("#nextChapter"),
  progressBar: document.querySelector("#progressBar"),
  ttsToggle: document.querySelector("#ttsToggle"),
  ttsBar: document.querySelector("#ttsBar"),
  ttsPlay: document.querySelector("#ttsPlay"),
  ttsVoices: document.querySelector("#ttsVoices"),
  ttsRate: document.querySelector(".tts-rate"),
  ttsRateToggle: document.querySelector("#ttsRateToggle"),
  ttsRateLabel: document.querySelector("#ttsRateLabel"),
  ttsRateMenu: document.querySelector("#ttsRateMenu"),
  ttsAutoNext: document.querySelector("#ttsAutoNext"),
  ttsStatus: document.querySelector("#ttsStatus"),
  ttsSeek: document.querySelector("#ttsSeek"),
  ttsCurrent: document.querySelector("#ttsCurrent"),
  ttsDuration: document.querySelector("#ttsDuration"),
  ttsRestart: document.querySelector("#ttsRestart"),
  audio: document.querySelector("#ttsAudio"),
};

const RATE_LABELS = {
  0.8: "0.8×",
  1: "1.0×",
  1.25: "1.25×",
  1.5: "1.5×",
};

function chapterLabel(chapter) {
  return chapter.title.replace(/^第\d+章\s*/, "");
}

function currentChapter() {
  return state.chapters[state.currentIndex] || null;
}

function chapterAudioMap(chapter = currentChapter()) {
  if (!chapter) return {};
  if (chapter.audio && typeof chapter.audio === "object") return chapter.audio;
  if (chapter.audioUrl) return { xiaoxiao: chapter.audioUrl };
  return {};
}

function chapterAudioUrl(chapter = currentChapter(), voiceId = tts.voiceId) {
  const audio = chapterAudioMap(chapter);
  return audio[voiceId] || audio.xiaoxiao || audio.yunjian || Object.values(audio)[0] || "";
}

function chapterHasAudio(chapter = currentChapter(), voiceId = tts.voiceId) {
  return Boolean(chapterAudioUrl(chapter, voiceId));
}

function chapterHasAnyAudio(chapter = currentChapter()) {
  return Object.keys(chapterAudioMap(chapter)).length > 0;
}

function voiceLabel(voiceId = tts.voiceId) {
  return state.voices.find((voice) => voice.id === voiceId)?.label || voiceId;
}

function updateCatalog() {
  elements.chapterList.replaceChildren();

  state.chapters.forEach((chapter, index) => {
    const button = document.createElement("button");
    button.className = "chapter-link";
    button.dataset.index = index;

    const number = document.createElement("span");
    number.className = "chapter-number";
    number.textContent = String(chapter.number).padStart(3, "0");

    const title = document.createElement("span");
    title.className = "chapter-name";
    title.textContent = chapterLabel(chapter);

    button.append(number, title);
    if (chapterHasAnyAudio(chapter)) {
      const audioBadge = document.createElement("span");
      audioBadge.className = "audio-badge";
      audioBadge.textContent = "听";
      audioBadge.title = "本章已生成听书音频";
      button.append(audioBadge);
    }
    if (chapter.status === "draft") {
      const badge = document.createElement("span");
      badge.className = "draft-badge";
      badge.textContent = "创作中";
      button.append(badge);
    }
    button.addEventListener("click", () => openChapter(index));
    elements.chapterList.append(button);
  });

  const draftCount = state.chapters.filter((chapter) => chapter.status === "draft").length;
  const audioCount = state.chapters.filter((chapter) => chapterHasAnyAudio(chapter)).length;
  const audioLabel = audioCount ? ` · ${audioCount} 章可听` : "";
  elements.chapterCount.textContent = `${state.chapters.length} 章${draftCount ? ` · ${draftCount} 章创作中` : ""}${audioLabel}`;
  const generated = new Date(state.generatedAt);
  elements.syncTime.textContent = Number.isNaN(generated.getTime())
    ? ""
    : `更新 ${generated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function splitReadableUnits(text) {
  const raw = text
    .split(/(?<=[。！？!?…]+[”"」』』]*)/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!raw.length) return text.trim() ? [text.trim()] : [];

  const units = [];
  raw.forEach((part) => {
    if (units.length && part.length < 8) {
      units[units.length - 1] += part;
      return;
    }
    units.push(part);
  });
  return units;
}

function wrapSyncUnits(node) {
  const text = node.textContent.replace(/\n+/g, "").trim();
  if (!text) return;
  const parts = splitReadableUnits(text);
  node.replaceChildren();
  parts.forEach((part) => {
    const span = document.createElement("span");
    span.className = "tts-unit";
    span.textContent = part;
    node.append(span);
    // Keep a thin space between units for wrapping without changing spoken text much.
    if (!/[。！？!?…’”"」』]$/.test(part)) node.append(document.createTextNode(""));
  });
}

function buildAudioSyncMap() {
  const units = [];
  let cursor = 0;
  elements.chapter.querySelectorAll(".tts-unit").forEach((span) => {
    const weight = Math.max(1, span.textContent.replace(/\s+/g, "").length);
    units.push({ el: span, start: cursor, end: cursor + weight, weight });
    cursor += weight;
  });
  tts.syncUnits = units;
  tts.syncTotal = cursor;
  tts.syncIndex = -1;
}

function renderChapter(text, chapter) {
  const blocks = text.trim().split(/\n\s*\n/);
  const titleText = blocks.shift() || chapter.title;
  const title = document.createElement("h2");
  title.textContent = titleText;
  elements.chapter.replaceChildren(title);
  wrapSyncUnits(title);

  if (chapter.status === "draft") {
    const status = document.createElement("span");
    status.className = "chapter-status";
    status.textContent = "创作中 · 内容可能随时修改";
    elements.chapter.append(status);
  }

  blocks.forEach((block) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = block.replace(/\n+/g, "");
    elements.chapter.append(paragraph);
    wrapSyncUnits(paragraph);
  });

  buildAudioSyncMap();
}

function getSpeakNodes() {
  const nodes = [];
  const title = elements.chapter.querySelector("h2");
  if (title?.textContent?.trim()) nodes.push(title);
  elements.chapter.querySelectorAll("p").forEach((paragraph) => {
    if (paragraph.textContent?.trim()) nodes.push(paragraph);
  });
  return nodes;
}

function clearTtsHighlight() {
  elements.chapter.querySelectorAll(".tts-active, .tts-active-block, .tts-read").forEach((node) => {
    node.classList.remove("tts-active", "tts-active-block", "tts-read");
  });
  tts.syncIndex = -1;
}

function highlightSyncIndex(index, { scroll = true } = {}) {
  if (index < 0 || index >= tts.syncUnits.length) return;
  if (index === tts.syncIndex) return;

  tts.syncUnits.forEach((unit, unitIndex) => {
    unit.el.classList.toggle("tts-active", unitIndex === index);
    unit.el.classList.toggle("tts-read", unitIndex < index);
    const block = unit.el.closest("p, h2");
    if (block) block.classList.toggle("tts-active-block", unitIndex === index);
  });

  tts.syncIndex = index;
  if (scroll) {
    tts.syncUnits[index].el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function syncHighlightFromAudio() {
  if (tts.mode !== "audio" || !tts.syncTotal) return;
  const duration = elements.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  const ratio = Math.min(1, Math.max(0, elements.audio.currentTime / duration));
  const position = ratio * tts.syncTotal;
  let index = tts.syncUnits.findIndex((unit) => position < unit.end);
  if (index < 0) index = tts.syncUnits.length - 1;
  highlightSyncIndex(index, { scroll: !tts.seeking });
}

function setTtsStatus(text) {
  elements.ttsStatus.textContent = text;
}

function updateTtsPlayButton() {
  const icon = elements.ttsPlay.querySelector(".tts-play-icon");
  if (!tts.playing || tts.paused) {
    if (icon) icon.textContent = "▶";
    elements.ttsPlay.dataset.state = "paused";
    elements.ttsPlay.setAttribute("aria-label", tts.playing ? "继续" : "播放");
  } else {
    if (icon) icon.textContent = "❚❚";
    elements.ttsPlay.dataset.state = "playing";
    elements.ttsPlay.setAttribute("aria-label", "暂停");
  }
  syncFabState();
}

function resetSeekUi() {
  elements.ttsSeek.value = "0";
  elements.ttsCurrent.textContent = "0:00";
  elements.ttsDuration.textContent = "0:00";
}

function updateSeekUi() {
  if (tts.seeking) return;
  const duration = elements.audio.duration;
  const current = elements.audio.currentTime;
  elements.ttsCurrent.textContent = formatClock(current);
  elements.ttsDuration.textContent = formatClock(duration);
  if (Number.isFinite(duration) && duration > 0) {
    elements.ttsSeek.value = String(Math.round((current / duration) * 1000));
  }
}

function renderVoiceButtons() {
  elements.ttsVoices.replaceChildren();
  const chapter = currentChapter();
  state.voices.forEach((voice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tts-voice";
    button.dataset.voice = voice.id;
    button.textContent = voice.label;
    button.setAttribute("aria-pressed", voice.id === tts.voiceId ? "true" : "false");
    button.disabled = Boolean(chapter) && !chapterHasAudio(chapter, voice.id) && chapterHasAnyAudio(chapter);
    if (chapter && !chapterHasAnyAudio(chapter)) button.disabled = false;
    button.title = chapterHasAudio(chapter, voice.id)
      ? `${voice.label}已可听`
      : `${voice.label}音频生成中`;
    button.addEventListener("click", () => selectVoice(voice.id));
    elements.ttsVoices.append(button);
  });
}

function clearSpeechWatchdog() {
  if (tts.watchdogId) {
    clearTimeout(tts.watchdogId);
    tts.watchdogId = null;
  }
}

function cancelSpeech() {
  clearSpeechWatchdog();
  tts.currentUtterance = null;
  if (!tts.speechSupported) return;
  speechSynthesis.cancel();
}

function stopAudio() {
  elements.audio.pause();
  elements.audio.removeAttribute("src");
  elements.audio.load();
}

function positionStorageKey(chapter = currentChapter(), voiceId = tts.voiceId) {
  if (!chapter) return "";
  return `ushen-tts-pos-${chapter.number}-${voiceId}`;
}

function savePlaybackPosition() {
  const chapter = currentChapter();
  const key = positionStorageKey(chapter);
  if (!key || tts.mode !== "audio") return;
  const current = elements.audio.currentTime;
  const duration = elements.audio.duration;
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return;
  if (current < 3 || current >= duration - 8) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, String(current));
}

function loadPlaybackPosition(chapter = currentChapter(), voiceId = tts.voiceId) {
  const key = positionStorageKey(chapter, voiceId);
  if (!key) return 0;
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 3 ? value : 0;
}

function clearPlaybackPosition(chapter = currentChapter(), voiceId = tts.voiceId) {
  const key = positionStorageKey(chapter, voiceId);
  if (key) localStorage.removeItem(key);
}

function stopTts({ keepBar = true, status = "已停止" } = {}) {
  savePlaybackPosition();
  tts.playing = false;
  tts.paused = false;
  tts.mode = "none";
  tts.paragraphIndex = -1;
  tts.resumeAfterChapter = false;
  cancelSpeech();
  stopAudio();
  clearTtsHighlight();
  resetSeekUi();
  updateTtsPlayButton();
  if (keepBar && tts.open) setTtsStatus(status);
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function updateAudioStatus() {
  updateSeekUi();
  syncHighlightFromAudio();
  if (tts.mode !== "audio" || !tts.playing) return;
  if (tts.paused) {
    setTtsStatus(`已暂停 · ${voiceLabel()}`);
    return;
  }
  setTtsStatus(`听书中 · ${voiceLabel()}`);
}

function handleChapterEnded() {
  clearPlaybackPosition();
  clearTtsHighlight();
  tts.playing = false;
  tts.paused = false;
  tts.mode = "none";
  tts.paragraphIndex = -1;
  updateTtsPlayButton();
  resetSeekUi();

  if (tts.autoNext && state.currentIndex < state.chapters.length - 1) {
    setTtsStatus("进入下一章…");
    tts.resumeAfterChapter = true;
    openChapter(state.currentIndex + 1);
    return;
  }

  setTtsStatus("本章已结束");
}

function pickChineseVoice() {
  if (!tts.speechSupported) return null;
  const voices = speechSynthesis.getVoices();
  const ranked = [
    (voice) => /enhanced|premium|neural/i.test(voice.name) && /zh|chinese|中文|国语|普通话/i.test(`${voice.lang} ${voice.name}`),
    (voice) => /tingting|meijia|sinji|ting-ting|mei-jia/i.test(voice.name),
    (voice) => /^zh(-|$)/i.test(voice.lang) && /CN|TW|HK|Hans|Hant/i.test(voice.lang),
    (voice) => /^zh/i.test(voice.lang),
    (voice) => /chinese|中文|普通话|国语/i.test(voice.name),
  ];
  for (const match of ranked) {
    const found = voices.find(match);
    if (found) return found;
  }
  return null;
}

function refreshVoice() {
  tts.voice = pickChineseVoice();
}

function speakFrom(index) {
  const nodes = getSpeakNodes();
  if (!nodes.length) {
    stopTts({ status: "本章没有可朗读内容" });
    return;
  }

  if (index >= nodes.length) {
    handleChapterEnded();
    return;
  }

  const node = nodes[index];
  const text = node.textContent.trim();
  if (!text) {
    speakFrom(index + 1);
    return;
  }

  clearTtsHighlight();
  node.classList.add("tts-active-block");
  node.querySelectorAll(".tts-unit").forEach((unit) => unit.classList.add("tts-active"));
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  tts.mode = "speech";
  tts.paragraphIndex = index;
  tts.playing = true;
  tts.paused = false;
  updateTtsPlayButton();
  setTtsStatus(`正在听第 ${index + 1} / ${nodes.length} 段`);

  const utterance = new SpeechSynthesisUtterance(text);
  tts.currentUtterance = utterance;
  utterance.lang = tts.voice?.lang || "zh-CN";
  utterance.rate = tts.rate;
  if (tts.voice) utterance.voice = tts.voice;

  const advance = () => {
    if (!tts.playing || tts.paused || tts.mode !== "speech") return;
    if (tts.currentUtterance !== utterance) return;
    speakFrom(index + 1);
  };

  utterance.onend = advance;
  utterance.onerror = (event) => {
    if (event.error === "interrupted" || event.error === "canceled") return;
    stopTts({ status: "朗读中断，请重试" });
  };

  clearSpeechWatchdog();
  const estimatedMs = Math.max(4000, (text.length / Math.max(tts.rate, 0.5)) * 220 + 2500);
  tts.watchdogId = setTimeout(() => {
    if (!tts.playing || tts.paused || tts.mode !== "speech") return;
    if (tts.currentUtterance !== utterance) return;
    if (speechSynthesis.speaking) return;
    advance();
  }, estimatedMs);

  speechSynthesis.speak(utterance);
}

async function startAudioPlayback(chapter, { resumeRatio = null, resumeTime = null, fromStart = false } = {}) {
  const audioUrl = chapterAudioUrl(chapter, tts.voiceId);
  if (!audioUrl) {
    startSpeechPlayback();
    return;
  }

  tts.mode = "audio";
  elements.audio.src = audioUrl;
  elements.audio.playbackRate = tts.rate;

  let targetTime = resumeTime;
  if (!fromStart && targetTime == null && resumeRatio == null) {
    targetTime = loadPlaybackPosition(chapter, tts.voiceId);
  }

  const seekWhenReady = () => {
    const duration = elements.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    let time = targetTime;
    if (resumeRatio != null) time = duration * resumeRatio;
    if (!Number.isFinite(time) || time <= 0) return;
    elements.audio.currentTime = Math.min(Math.max(0, time), Math.max(0, duration - 0.25));
    updateSeekUi();
    syncHighlightFromAudio();
  };
  elements.audio.addEventListener("loadedmetadata", seekWhenReady, { once: true });

  try {
    await elements.audio.play();
  } catch (error) {
    stopTts({ status: "音频播放失败，请重试" });
    console.warn(error);
    return;
  }
  tts.playing = true;
  tts.paused = false;
  if (!tts.syncUnits.length) buildAudioSyncMap();
  updateTtsPlayButton();
  updateAudioStatus();
  renderVoiceButtons();
  if (targetTime > 0 || resumeRatio) setTtsStatus(`继续收听 · ${voiceLabel()}`);
}

async function selectVoice(voiceId) {
  if (voiceId === tts.voiceId) return;
  const chapter = currentChapter();
  if (chapter && chapterHasAnyAudio(chapter) && !chapterHasAudio(chapter, voiceId)) {
    setTtsStatus(`${voiceLabel(voiceId)}音频生成中`);
    return;
  }

  const inAudio = tts.mode === "audio" && tts.playing;
  const shouldResume = inAudio && !tts.paused;
  const resumeRatio =
    inAudio && Number.isFinite(elements.audio.duration) && elements.audio.duration > 0
      ? elements.audio.currentTime / elements.audio.duration
      : 0;

  tts.voiceId = voiceId;
  localStorage.setItem("ushen-tts-voice", voiceId);
  renderVoiceButtons();

  if (!chapter) {
    setTtsStatus(readyStatus());
    return;
  }

  if (inAudio) {
    cancelSpeech();
    stopAudio();
    await startAudioPlayback(chapter, { resumeRatio });
    if (!shouldResume && tts.playing) pauseTts();
    return;
  }

  setTtsStatus(readyStatus(chapter));
}

function startSpeechPlayback() {
  if (!tts.speechSupported) {
    setTtsStatus("本章听书尚未生成");
    return;
  }
  if (!getSpeakNodes().length) {
    setTtsStatus("本章没有可朗读内容");
    return;
  }
  refreshVoice();
  setTtsStatus(tts.voice ? "浏览器朗读（神经语音生成中）" : "系统默认音（神经语音生成中）");
  cancelSpeech();
  speakFrom(0);
}

function startTts({ fromStart = false } = {}) {
  const chapter = currentChapter();
  if (!chapter) {
    setTtsStatus("请先打开章节");
    return;
  }
  if (chapterHasAudio(chapter)) {
    startAudioPlayback(chapter, { fromStart });
    return;
  }
  startSpeechPlayback();
}

function pauseTts() {
  if (!tts.playing || tts.paused) return;

  if (tts.mode === "audio") {
    elements.audio.pause();
    savePlaybackPosition();
    tts.paused = true;
    updateTtsPlayButton();
    setTtsStatus(`已暂停 · ${voiceLabel()}`);
    return;
  }

  // Safari/iOS: cancel + resume from paragraph instead of pause/resume
  cancelSpeech();
  tts.paused = true;
  updateTtsPlayButton();
  setTtsStatus("已暂停");
}

function resumeTts() {
  if (!tts.playing || !tts.paused) return;

  if (tts.mode === "audio") {
    elements.audio.playbackRate = tts.rate;
    elements.audio.play().catch(() => stopTts({ status: "音频播放失败，请重试" }));
    tts.paused = false;
    updateTtsPlayButton();
    updateAudioStatus();
    return;
  }

  tts.paused = false;
  speakFrom(Math.max(0, tts.paragraphIndex));
}

function toggleTtsPlayback() {
  if (!tts.playing) {
    startTts();
    return;
  }
  if (tts.paused) resumeTts();
  else pauseTts();
}

function readyStatus(chapter = currentChapter()) {
  if (chapterHasAudio(chapter)) {
    const saved = loadPlaybackPosition(chapter);
    if (saved > 0) return `可继续 · ${voiceLabel()} · ${formatClock(saved)}`;
    return `可听 · ${voiceLabel()}`;
  }
  if (chapterHasAnyAudio(chapter)) return `${voiceLabel()}生成中 · 可换音色或浏览器朗读`;
  return "待生成 · 可先浏览器朗读";
}

function syncFabState() {
  document.body.classList.toggle("tts-playing", tts.playing && !tts.paused);
  elements.ttsToggle.setAttribute("aria-pressed", tts.open ? "true" : "false");
  elements.ttsToggle.setAttribute("aria-label", tts.open ? "收起听书" : "打开听书");
  const label = elements.ttsToggle.querySelector(".tts-fab-label");
  if (label) label.textContent = tts.playing && !tts.paused ? "播放中" : "听书";
}

function setTtsBarOpen(open) {
  tts.open = open;
  elements.ttsBar.hidden = !open;
  document.body.classList.toggle("tts-open", open);
  syncFabState();
  if (!open) {
    stopTts({ keepBar: false });
    syncFabState();
    return;
  }
  renderVoiceButtons();
  if (!tts.playing) setTtsStatus(readyStatus());
}

function prefetchChapter(index) {
  const chapter = state.chapters[index];
  if (!chapter || state.prefetched.has(chapter.number)) return;
  const request = fetch(chapter.url, { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((text) => {
      state.prefetched.set(chapter.number, text);
      return text;
    })
    .catch(() => {
      state.prefetched.delete(chapter.number);
    });
  state.prefetched.set(chapter.number, request);
}

async function loadChapterText(chapter) {
  const cached = state.prefetched.get(chapter.number);
  if (typeof cached === "string") return cached;
  if (cached?.then) {
    const text = await cached;
    if (typeof text === "string") return text;
  }
  const response = await fetch(chapter.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  state.prefetched.set(chapter.number, text);
  return text;
}

function setRateMenuOpen(open) {
  elements.ttsRateMenu.hidden = !open;
  elements.ttsRateToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncRateUi() {
  elements.ttsRateLabel.textContent = RATE_LABELS[tts.rate] || "1.0×";
  elements.ttsRateMenu.querySelectorAll("[data-rate]").forEach((button) => {
    button.setAttribute("aria-selected", Number(button.dataset.rate) === tts.rate ? "true" : "false");
  });
}

function applyRate(rate) {
  tts.rate = rate;
  localStorage.setItem("ushen-tts-rate", String(tts.rate));
  syncRateUi();
  setRateMenuOpen(false);
  if (tts.mode === "audio") {
    elements.audio.playbackRate = tts.rate;
    return;
  }
  if (tts.playing && !tts.paused && tts.mode === "speech") {
    const index = Math.max(0, tts.paragraphIndex);
    cancelSpeech();
    speakFrom(index);
  }
}

function initializeTts() {
  const allowedRates = [0.8, 1, 1.25, 1.5];
  if (!allowedRates.includes(tts.rate)) tts.rate = 1;
  syncRateUi();
  elements.ttsAutoNext.checked = tts.autoNext;

  elements.ttsToggle.addEventListener("click", () => {
    setTtsBarOpen(!tts.open);
  });
  document.querySelector("#ttsClose")?.addEventListener("click", () => {
    setTtsBarOpen(false);
  });
  elements.ttsPlay.addEventListener("click", toggleTtsPlayback);
  elements.ttsRestart?.addEventListener("click", () => {
    const chapter = currentChapter();
    if (!chapter) return;
    clearPlaybackPosition(chapter);
    if (tts.mode === "audio" && tts.playing) {
      elements.audio.currentTime = 0;
      if (tts.paused) resumeTts();
      updateAudioStatus();
      setTtsStatus(`从头收听 · ${voiceLabel()}`);
      return;
    }
    startTts({ fromStart: true });
  });
  syncFabState();
  elements.ttsRateToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setRateMenuOpen(elements.ttsRateMenu.hidden);
  });
  elements.ttsRateMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-rate]");
    if (!button) return;
    applyRate(Number(button.dataset.rate) || 1);
  });
  document.addEventListener("click", (event) => {
    if (!elements.ttsRate.contains(event.target)) setRateMenuOpen(false);
  });
  elements.ttsAutoNext.addEventListener("change", () => {
    tts.autoNext = elements.ttsAutoNext.checked;
    localStorage.setItem("ushen-tts-auto-next", tts.autoNext ? "1" : "0");
  });

  elements.audio.addEventListener("timeupdate", () => {
    updateAudioStatus();
    if (tts.playing && !tts.paused && tts.mode === "audio") savePlaybackPosition();
  });
  elements.audio.addEventListener("loadedmetadata", updateSeekUi);
  elements.audio.addEventListener("ended", () => {
    if (tts.mode !== "audio") return;
    handleChapterEnded();
  });
  elements.audio.addEventListener("error", () => {
    if (tts.mode !== "audio") return;
    stopTts({ status: "音频加载失败" });
  });

  const previewSeek = () => {
    const duration = elements.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const ratio = Number(elements.ttsSeek.value) / 1000;
    const time = duration * ratio;
    elements.ttsCurrent.textContent = formatClock(time);
    return time;
  };

  const commitSeek = () => {
    const duration = elements.audio.duration;
    tts.seeking = false;
    if (!Number.isFinite(duration) || duration <= 0) {
      setTtsStatus("音频加载中，稍后再拖进度");
      return;
    }
    const time = previewSeek();
    try {
      elements.audio.currentTime = time;
    } catch (error) {
      console.warn(error);
    }
    savePlaybackPosition();
    syncHighlightFromAudio();
    updateAudioStatus();
    if (tts.playing && tts.paused) setTtsStatus(`已定位到 ${formatClock(time)}`);
  };

  elements.ttsSeek.addEventListener("pointerdown", () => {
    tts.seeking = true;
  });
  elements.ttsSeek.addEventListener("touchstart", () => {
    tts.seeking = true;
  }, { passive: true });
  elements.ttsSeek.addEventListener("input", () => {
    tts.seeking = true;
    const time = previewSeek();
    const duration = elements.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      // Live scrub so mobile users can drag to the exact spot.
      try {
        elements.audio.currentTime = time;
      } catch (_) {
        /* ignore transient seek errors while metadata settles */
      }
      syncHighlightFromAudio();
    }
  });
  elements.ttsSeek.addEventListener("pointerup", commitSeek);
  elements.ttsSeek.addEventListener("touchend", commitSeek, { passive: true });
  elements.ttsSeek.addEventListener("change", commitSeek);

  if (tts.speechSupported) {
    refreshVoice();
    speechSynthesis.addEventListener("voiceschanged", refreshVoice);
  }

  if (!state.voices.some((voice) => voice.id === tts.voiceId)) tts.voiceId = state.voices[0]?.id || "xiaoxiao";
  renderVoiceButtons();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && tts.playing && !tts.paused) pauseTts();
  });

  if (!isAppleSafari) {
    tts.chromeKeepAliveId = setInterval(() => {
      if (!tts.speechSupported || tts.mode !== "speech" || !tts.playing || tts.paused) return;
      if (speechSynthesis.speaking && speechSynthesis.paused) speechSynthesis.resume();
    }, 4000);
  }
}

async function openChapter(index, options = {}) {
  const chapter = state.chapters[index];
  if (!chapter) return;

  const keepPlaying = tts.resumeAfterChapter;
  if (!keepPlaying) stopTts({ status: tts.open ? readyStatus(chapter) : "已停止" });
  else {
    cancelSpeech();
    if (tts.mode === "audio") stopAudio();
    clearTtsHighlight();
    tts.resumeAfterChapter = false;
  }

  try {
    renderChapter(await loadChapterText(chapter), chapter);
  } catch (error) {
    elements.chapter.textContent = `本章加载失败，请刷新后重试。（${error.message}）`;
    stopTts({ status: "本章加载失败" });
    return;
  }

  state.currentIndex = index;
  elements.toolbarTitle.textContent = chapter.title;
  elements.previous.disabled = index === 0;
  elements.next.disabled = index === state.chapters.length - 1;
  document.title = `${chapter.title} · 有神`;
  history.replaceState(null, "", `#chapter-${chapter.number}`);
  localStorage.setItem("ushen-last-chapter", String(chapter.number));

  document.querySelectorAll(".chapter-link").forEach((link, linkIndex) => {
    link.classList.toggle("active", linkIndex === index);
  });

  document.body.classList.remove("sidebar-open");
  if (!options.keepScroll) window.scrollTo({ top: 0, behavior: "instant" });
  updateProgress();

  if (index + 1 < state.chapters.length) prefetchChapter(index + 1);
  renderVoiceButtons();
  if (tts.open && !tts.playing) setTtsStatus(readyStatus(chapter));

  if (keepPlaying) startTts();
}

function requestedChapter() {
  const hashMatch = location.hash.match(/^#chapter-(\d+)$/);
  const saved = localStorage.getItem("ushen-last-chapter");
  const number = Number(hashMatch?.[1] || saved);
  const index = state.chapters.findIndex((chapter) => chapter.number === number);
  return index >= 0 ? index : 0;
}

async function loadCatalog({ initial = false } = {}) {
  try {
    const response = await fetch(`chapters.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!initial && state.generatedAt === payload.generatedAt) return;

    const currentNumber = state.chapters[state.currentIndex]?.number;
    state.chapters = payload.chapters;
    state.generatedAt = payload.generatedAt;
    if (Array.isArray(payload.voices) && payload.voices.length) {
      state.voices = payload.voices.map((voice) => ({
        id: voice.id,
        label: voice.label || voice.id,
      }));
      if (!state.voices.some((voice) => voice.id === tts.voiceId)) {
        tts.voiceId = state.voices[0].id;
        localStorage.setItem("ushen-tts-voice", tts.voiceId);
      }
    }
    updateCatalog();
    renderVoiceButtons();

    if (initial) {
      await openChapter(requestedChapter());
    } else if (currentNumber) {
      const newIndex = state.chapters.findIndex((chapter) => chapter.number === currentNumber);
      state.currentIndex = newIndex;
      document.querySelectorAll(".chapter-link").forEach((link, index) => {
        link.classList.toggle("active", index === newIndex);
      });
    }
  } catch (error) {
    if (initial) {
      elements.chapter.textContent = `目录加载失败，请刷新后重试。（${error.message}）`;
    }
  }
}

function updateProgress() {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0;
  elements.progressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
}

function setFontSize(delta) {
  const current = Number(localStorage.getItem("ushen-font-size") || 19);
  const next = Math.min(26, Math.max(15, current + delta));
  document.documentElement.style.setProperty("--font-size", `${next}px`);
  localStorage.setItem("ushen-font-size", String(next));
}

function initializePreferences() {
  const fontSize = localStorage.getItem("ushen-font-size");
  if (fontSize) document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  if (localStorage.getItem("ushen-theme") === "dark") document.body.classList.add("dark");
}

elements.previous.addEventListener("click", () => openChapter(state.currentIndex - 1));
elements.next.addEventListener("click", () => openChapter(state.currentIndex + 1));
document.querySelector("#fontDown").addEventListener("click", () => setFontSize(-1));
document.querySelector("#fontUp").addEventListener("click", () => setFontSize(1));
document.querySelector("#themeToggle").addEventListener("click", () => {
  const dark = document.body.classList.toggle("dark");
  localStorage.setItem("ushen-theme", dark ? "dark" : "light");
});
document.querySelector("#openSidebar").addEventListener("click", () => {
  document.body.classList.add("sidebar-open");
});
document.querySelector("#closeSidebar").addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});
document.querySelector("#scrim").addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});
window.addEventListener("scroll", updateProgress, { passive: true });
window.addEventListener("hashchange", () => {
  const index = requestedChapter();
  if (index !== state.currentIndex) openChapter(index);
});

initializePreferences();
initializeTts();
loadCatalog({ initial: true });
setInterval(() => loadCatalog(), 60_000);
