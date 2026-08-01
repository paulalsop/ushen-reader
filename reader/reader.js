const state = {
  chapters: [],
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
  paragraphIndex: -1,
  resumeAfterChapter: false,
  voice: null,
  currentUtterance: null,
  watchdogId: null,
  chromeKeepAliveId: null,
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
  ttsRate: document.querySelector("#ttsRate"),
  ttsAutoNext: document.querySelector("#ttsAutoNext"),
  ttsStatus: document.querySelector("#ttsStatus"),
  audio: document.querySelector("#ttsAudio"),
};

function chapterLabel(chapter) {
  return chapter.title.replace(/^第\d+章\s*/, "");
}

function currentChapter() {
  return state.chapters[state.currentIndex] || null;
}

function chapterHasAudio(chapter = currentChapter()) {
  return Boolean(chapter?.audioUrl);
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
    if (chapter.audioUrl) {
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
  const audioCount = state.chapters.filter((chapter) => chapter.audioUrl).length;
  const audioLabel = audioCount ? ` · ${audioCount} 章可听` : "";
  elements.chapterCount.textContent = `${state.chapters.length} 章${draftCount ? ` · ${draftCount} 章创作中` : ""}${audioLabel}`;
  const generated = new Date(state.generatedAt);
  elements.syncTime.textContent = Number.isNaN(generated.getTime())
    ? ""
    : `更新 ${generated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function renderChapter(text, chapter) {
  const blocks = text.trim().split(/\n\s*\n/);
  const titleText = blocks.shift() || chapter.title;
  const title = document.createElement("h2");
  title.textContent = titleText;
  elements.chapter.replaceChildren(title);

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
  });
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
  elements.chapter.querySelectorAll(".tts-active").forEach((node) => {
    node.classList.remove("tts-active");
  });
}

function setTtsStatus(text) {
  elements.ttsStatus.textContent = text;
}

function updateTtsPlayButton() {
  if (!tts.playing) {
    elements.ttsPlay.textContent = "播放";
    elements.ttsPlay.setAttribute("aria-label", "播放");
  } else if (tts.paused) {
    elements.ttsPlay.textContent = "继续";
    elements.ttsPlay.setAttribute("aria-label", "继续");
  } else {
    elements.ttsPlay.textContent = "暂停";
    elements.ttsPlay.setAttribute("aria-label", "暂停");
  }
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

function stopTts({ keepBar = true, status = "已停止" } = {}) {
  tts.playing = false;
  tts.paused = false;
  tts.mode = "none";
  tts.paragraphIndex = -1;
  tts.resumeAfterChapter = false;
  cancelSpeech();
  stopAudio();
  clearTtsHighlight();
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
  if (tts.mode !== "audio" || !tts.playing) return;
  if (tts.paused) {
    setTtsStatus("已暂停");
    return;
  }
  const current = formatClock(elements.audio.currentTime);
  const duration = formatClock(elements.audio.duration);
  setTtsStatus(`听书中 ${current} / ${duration}`);
}

function handleChapterEnded() {
  clearTtsHighlight();
  tts.playing = false;
  tts.paused = false;
  tts.mode = "none";
  tts.paragraphIndex = -1;
  updateTtsPlayButton();

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
  node.classList.add("tts-active");
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

async function startAudioPlayback(chapter) {
  tts.mode = "audio";
  elements.audio.src = chapter.audioUrl;
  elements.audio.playbackRate = tts.rate;
  try {
    await elements.audio.play();
  } catch (error) {
    stopTts({ status: "音频播放失败，请重试" });
    console.warn(error);
    return;
  }
  tts.playing = true;
  tts.paused = false;
  updateTtsPlayButton();
  updateAudioStatus();
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

function startTts() {
  const chapter = currentChapter();
  if (!chapter) {
    setTtsStatus("请先打开章节");
    return;
  }
  if (chapterHasAudio(chapter)) {
    startAudioPlayback(chapter);
    return;
  }
  startSpeechPlayback();
}

function pauseTts() {
  if (!tts.playing || tts.paused) return;

  if (tts.mode === "audio") {
    elements.audio.pause();
    tts.paused = true;
    updateTtsPlayButton();
    setTtsStatus("已暂停");
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
  if (chapterHasAudio(chapter)) return "可听 · 神经语音";
  return "待生成 · 可先浏览器朗读";
}

function setTtsBarOpen(open) {
  tts.open = open;
  elements.ttsBar.hidden = !open;
  elements.ttsToggle.setAttribute("aria-pressed", open ? "true" : "false");
  document.body.classList.toggle("tts-open", open);
  if (!open) stopTts({ keepBar: false });
  else if (!tts.playing) setTtsStatus(readyStatus());
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

function initializeTts() {
  const allowedRates = [0.8, 1, 1.25, 1.5];
  if (!allowedRates.includes(tts.rate)) tts.rate = 1;
  elements.ttsRate.value = String(tts.rate);
  elements.ttsAutoNext.checked = tts.autoNext;

  elements.ttsToggle.addEventListener("click", () => {
    setTtsBarOpen(!tts.open);
  });
  elements.ttsPlay.addEventListener("click", toggleTtsPlayback);
  elements.ttsRate.addEventListener("change", () => {
    tts.rate = Number(elements.ttsRate.value) || 1;
    localStorage.setItem("ushen-tts-rate", String(tts.rate));
    if (tts.mode === "audio") {
      elements.audio.playbackRate = tts.rate;
      return;
    }
    if (tts.playing && !tts.paused && tts.mode === "speech") {
      const index = Math.max(0, tts.paragraphIndex);
      cancelSpeech();
      speakFrom(index);
    }
  });
  elements.ttsAutoNext.addEventListener("change", () => {
    tts.autoNext = elements.ttsAutoNext.checked;
    localStorage.setItem("ushen-tts-auto-next", tts.autoNext ? "1" : "0");
  });

  elements.audio.addEventListener("timeupdate", updateAudioStatus);
  elements.audio.addEventListener("ended", () => {
    if (tts.mode !== "audio") return;
    handleChapterEnded();
  });
  elements.audio.addEventListener("error", () => {
    if (tts.mode !== "audio") return;
    stopTts({ status: "音频加载失败" });
  });

  if (tts.speechSupported) {
    refreshVoice();
    speechSynthesis.addEventListener("voiceschanged", refreshVoice);
  }

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
    updateCatalog();

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
