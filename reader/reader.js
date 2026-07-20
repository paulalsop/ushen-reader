const state = {
  chapters: [],
  currentIndex: -1,
  generatedAt: null,
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
};

function chapterLabel(chapter) {
  return chapter.title.replace(/^第\d+章\s*/, "");
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
  elements.chapterCount.textContent = `${state.chapters.length} 章${draftCount ? ` · ${draftCount} 章创作中` : ""}`;
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

async function openChapter(index, options = {}) {
  const chapter = state.chapters[index];
  if (!chapter) return;

  try {
    const response = await fetch(chapter.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderChapter(await response.text(), chapter);
  } catch (error) {
    elements.chapter.textContent = `本章加载失败，请刷新后重试。（${error.message}）`;
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
loadCatalog({ initial: true });
setInterval(() => loadCatalog(), 60_000);
