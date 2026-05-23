// wolver002 secret extension — background service worker
//
// Flow on toolbar-button click:
//   1. Show a "thinking" pill in the top-right of the current tab
//   2. Capture a screenshot of the visible viewport
//   3. POST the image (data URL) to https://api.wolver002.com/vision
//   4. Replace the pill with the AI's reply (auto-dismiss after a bit, click to dismiss)

const API_URL = "https://api.wolver002.com/vision";
const DEFAULT_PROMPT =
  "Look at this screenshot. If a question is visible, answer it briefly. " +
  "Otherwise describe what's on screen in 1-2 short sentences. Be concise.";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  // Some pages (chrome://, the Web Store) can't be captured or scripted.
  const url = tab.url || "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome.google.com/webstore") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("chromewebstore.google.com") ||
    url.startsWith("https://chromewebstore.google.com")
  ) {
    return;
  }

  // 1. Show a thinking indicator on the page
  await safeInject(tab.id, showOverlay, ["thinking…", "loading"]);

  // 2. Capture the visible tab
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 70,
    });
  } catch (e) {
    await safeInject(tab.id, showOverlay, [
      "Couldn't capture this page: " + String(e.message || e),
      "error",
    ]);
    return;
  }

  // 3. Send to the AI
  try {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, prompt: DEFAULT_PROMPT }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = data.detail || data.error || `HTTP ${r.status}`;
      await safeInject(tab.id, showOverlay, ["Error: " + detail, "error"]);
      return;
    }
    const reply = (data.reply || "(no answer)").trim();
    await safeInject(tab.id, showOverlay, [reply, "answer"]);
  } catch (e) {
    await safeInject(tab.id, showOverlay, [
      "Network error: " + String(e.message || e),
      "error",
    ]);
  }
});

async function safeInject(tabId, func, args) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
  } catch (e) {
    // Page may be a special URL we can't script — silently ignore.
    console.warn("wolver002 secret: inject failed:", e?.message || e);
  }
}

// Runs in the page context. Creates / updates / removes the floating overlay.
function showOverlay(text, kind /* "loading" | "answer" | "error" */) {
  const ID = "__wv002_secret_overlay";
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement("div");
    el.id = ID;
    document.documentElement.appendChild(el);
  }

  const palette =
    kind === "error"
      ? { bg: "rgba(50, 12, 12, 0.55)", border: "rgba(255, 110, 110, 0.25)" }
      : kind === "loading"
        ? { bg: "rgba(20, 20, 25, 0.45)", border: "rgba(255, 255, 255, 0.10)" }
        : { bg: "rgba(15, 15, 18, 0.55)", border: "rgba(255, 255, 255, 0.10)" };

  el.textContent = text;
  el.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 2147483647;
    max-width: 340px;
    padding: 10px 12px;
    background: ${palette.bg};
    color: #f1f1f3;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    border-radius: 10px;
    border: 1px solid ${palette.border};
    backdrop-filter: blur(10px) saturate(120%);
    -webkit-backdrop-filter: blur(10px) saturate(120%);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    cursor: pointer;
    user-select: text;
    pointer-events: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 160ms ease, transform 160ms ease;
  `;
  requestAnimationFrame(() => {
    el.style.opacity = kind === "loading" ? "0.85" : "1";
    el.style.transform = "translateY(0)";
  });
  el.onclick = () => el.remove();

  // Auto-dismiss after a while (only for final states, not loading)
  if (window.__wv002_timer) clearTimeout(window.__wv002_timer);
  if (kind !== "loading") {
    window.__wv002_timer = setTimeout(() => {
      if (el && el.parentNode) {
        el.style.opacity = "0";
        el.style.transform = "translateY(-4px)";
        setTimeout(() => el && el.remove(), 200);
      }
    }, 30000);
  }
}
