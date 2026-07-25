// Origin that is allowed to supply the Qwen auth token. Compared against a
// parsed URL origin, never a string prefix: "https://chat.qwen.ai.evil.com" and
// "https://chat.qwen.ai@evil.com" both pass a startsWith() check.
const QWEN_ORIGIN = "https://chat.qwen.ai";

// Schemes we can inject into. host_permissions covers http/https only, so an
// allowlist rejects chrome://, edge://, about:, chrome-extension://,
// devtools://, view-source:, file:, data: and blob: in one check — a denylist of
// known-bad schemes kept missing cases.
const INJECTABLE_PROTOCOLS = new Set(["http:", "https:"]);

function parseUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

// A service worker has no window of its own, so `currentWindow` resolves to the
// last-focused one. The side panel is per-window, so it passes its own windowId
// and we only fall back when it's unavailable — otherwise, with two windows
// open, the panel can silently read the wrong window's page.
async function getActiveTab(windowId) {
  const query =
    typeof windowId === "number"
      ? { active: true, windowId: windowId }
      : { active: true, currentWindow: true };
  const tabs = await chrome.tabs.query(query);
  return (tabs && tabs[0]) || null;
}

// Runs chrome.scripting.executeScript against the tab's top frame and unwraps
// the single InjectionResult.
//
// Chrome rejects the executeScript promise when the injected function throws and
// does not populate InjectionResult.error (crbug.com/1271527). Firefox instead
// resolves with a per-frame `error`. The frame.error branch below is therefore
// inert on Chrome and load-bearing on Firefox; it is kept so a port doesn't
// silently swallow in-page exceptions.
async function injectAndRead(tabId, func) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: func,
  });

  const frame = frames && frames[0];
  if (!frame) {
    throw new Error("Script injection returned no result.");
  }
  if (frame.error) {
    throw new Error(frame.error.message || String(frame.error));
  }
  return frame.result;
}

// --- Injected page functions -------------------------------------------------
// These are serialized and run in the page, so they must be fully
// self-contained: no imports, no closure over anything above.

function extractPageContent() {
  const MAX_LENGTH = 4000;
  const MAX_ELEMENTS = 5000;
  const TRUNCATION_NOTE = "\n\n[Content truncated for length...]";

  const clean = (raw) => (raw || "").replace(/\n\s*\n/g, "\n").trim();
  const limit = (raw) =>
    raw.length > MAX_LENGTH
      ? raw.substring(0, MAX_LENGTH) + TRUNCATION_NOTE
      : raw;

  // 1. An explicit user selection is the strongest signal of intent.
  const selection = window.getSelection();
  const selected = clean(selection ? selection.toString() : "");
  if (selected) {
    return { type: "selection", text: limit(selected) };
  }

  // 2. Otherwise pull block elements from the main content region.
  //    <article>/<main> are containers, not peers of the blocks below — their
  //    innerText already contains every child paragraph, so matching both in one
  //    selector emits the whole page and then every paragraph again.
  //    <main> is unique per spec, so it is a safe root. <article> is not:
  //    listing pages carry one per card, and a promo or "related posts" widget
  //    can precede the real content — rooting at the first one silently drops
  //    everything else, which is worse than extracting too much. Accept it only
  //    when the document has exactly one. The nesting guard below, not the root,
  //    is what prevents duplication.
  const articles = document.querySelectorAll("article");
  const root =
    document.querySelector("main") ||
    (articles.length === 1 ? articles[0] : null) ||
    document.body;

  const parts = [];
  let collected = 0;
  let scanned = 0;
  let lastKept = null;

  if (root) {
    for (const el of root.querySelectorAll(
      "p, h1, h2, h3, h4, h5, h6, li, pre, code",
    )) {
      // innerText forces a layout flush per element, and elements with no text
      // never advance the character budget — so bound the scan by count too.
      if (++scanned > MAX_ELEMENTS) break;

      // Nested matches (pre > code, li > p) repeat their parent's text.
      // Document order puts descendants immediately after their ancestor, so
      // tracking the last kept element is enough to skip them.
      if (lastKept && lastKept.contains(el)) continue;

      const part = el.innerText.trim();
      if (!part) continue;

      lastKept = el;
      parts.push(part);
      collected += part.length + 1;

      // Stop once there is comfortably more than the budget: joining every
      // element on a large document materializes megabytes truncation discards.
      if (collected > MAX_LENGTH * 2) break;
    }
  }

  let text = clean(parts.join("\n"));

  // 3. Sparse semantic markup (or none at all) — fall back to the whole body.
  //    document.body is null on XML/SVG documents.
  if (text.length < 50) {
    const bodyText = clean(document.body ? document.body.innerText : "");
    if (bodyText.length > text.length) {
      text = bodyText;
    }
  }

  return { type: "page", text: limit(text) };
}

function readAuthToken() {
  // The origin is re-checked here, in the page, rather than relying solely on
  // the caller's check. That check runs against tab.url before injection, and a
  // tab.id survives navigation while its URL does not — so a tab that navigates
  // in between would have the *new* origin's localStorage read and stored as the
  // Qwen credential. In-page, the check and the read are atomic.
  //
  // The origin literal is duplicated from QWEN_ORIGIN deliberately: this
  // function is serialized into the page and cannot close over module scope.
  // Keep the two in sync.
  if (location.origin !== "https://chat.qwen.ai") {
    return null;
  }
  return localStorage.getItem("token") || localStorage.getItem("access_token");
}

// --- Message handlers --------------------------------------------------------

async function storeToken(token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { status: "error", error: "Empty token." };
  }
  await chrome.storage.session.set({ qwenToken: token });
  return { status: "success" };
}

async function getAuthStatus() {
  try {
    const result = await chrome.storage.session.get("qwenToken");
    return { isAuthenticated: !!(result && result.qwenToken) };
  } catch {
    return { isAuthenticated: false };
  }
}

// Reads the token from an active chat.qwen.ai tab and stores it. Lives here
// rather than in the side panel so that every privileged injection sits in the
// service worker, and so the bearer credential never passes through the UI
// context that also renders untrusted page text.
async function refreshAuth(windowId) {
  const tab = await getActiveTab(windowId);
  const url = parseUrl(tab && tab.url);

  if (!url || url.origin !== QWEN_ORIGIN) {
    return {
      error: "Please switch to the https://chat.qwen.ai/ tab and try again.",
    };
  }

  const token = await injectAndRead(tab.id, readAuthToken);
  if (!token) {
    // Also the path taken when the tab navigated away between the check above
    // and the injection, since readAuthToken re-checks the origin in-page.
    return {
      error: "No auth token found on chat.qwen.ai. Ensure you are logged in.",
    };
  }

  return storeToken(token);
}

async function getPageContext(windowId) {
  const tab = await getActiveTab(windowId);
  if (!tab) {
    return { error: "No active tab found." };
  }

  const url = parseUrl(tab.url);
  if (!url || !INJECTABLE_PROTOCOLS.has(url.protocol)) {
    return {
      error: "Cannot read context from browser internal or extension pages.",
    };
  }

  const extracted = await injectAndRead(tab.id, extractPageContent);
  if (!extracted || !extracted.text) {
    return { error: "No text found on this page." };
  }

  return { ...extracted, url: tab.url, title: tab.title };
}

async function sendChatMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "No messages to send." };
  }

  const stored = await chrome.storage.session.get("qwenToken");
  if (!stored || !stored.qwenToken) {
    return {
      error: "Not authenticated. Please log in at chat.qwen.ai and refresh.",
    };
  }

  // Third-party community proxy that accepts chat.qwen.ai web tokens. Note that
  // this means the user's Qwen bearer token is transmitted to an operator
  // unaffiliated with Alibaba.
  // Future API key upgrade: switch to
  // "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions".
  const res = await fetch("https://qwen.aikit.club/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${stored.qwenToken}`,
    },
    body: JSON.stringify({
      model: "qwen3.5-flash", // Fast, responsive model ideal for sidebar use
      messages: messages,
      stream: false, // Phase 2: simple request/response. Streaming can come later.
    }),
    // Without this, a proxy that accepts the connection and then hangs leaves
    // the panel stuck on "Thinking..." with the send button disabled, since
    // nothing else ever settles this promise.
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 401) {
    // The stored token is no longer usable — drop it so the status pill stops
    // claiming "Authenticated" and the user is pointed at Refresh Auth.
    await chrome.storage.session.remove("qwenToken");
    return {
      error:
        "Authentication expired or rejected. Open a chat.qwen.ai tab and click 'Refresh Auth'.",
      authExpired: true,
    };
  }

  if (!res.ok) {
    // Include the body: a bare "HTTP 4xx" can't distinguish an expired token
    // from a malformed request. Redact any echoed credential first — this
    // string is rendered into the chat transcript.
    const body = await res.text().catch(() => "");
    // Redact by value as well as by "Bearer " prefix — a body echoing the bare
    // credential (e.g. {"token":"eyJ..."}) would slip past the prefix pattern.
    const safeBody = body
      .split(stored.qwenToken)
      .join("[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    throw new Error(
      `HTTP ${res.status}${safeBody ? `: ${safeBody.slice(0, 200)}` : ""}`,
    );
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  if (!choice || !choice.message) {
    return { error: "Unexpected API response", details: data };
  }

  return { content: choice.message.content };
}

// Ensures sendResponse fires exactly once, including when the handler rejects.
// Without it, a rejection leaves the port open until it closes with no reply and
// the caller's await hangs on an opaque "message port closed".
//
// The reply itself is wrapped because sendResponse throws once the port is gone
// — e.g. the user closed the side panel mid-request. Letting that throw escape
// the resolve arm would route it into .catch and send a second response.
function respondAsync(promise, sendResponse, failureMessage) {
  const reply = (payload) => {
    try {
      sendResponse(payload);
    } catch {
      // Port already closed; there is no longer anyone to tell.
    }
  };

  promise.then(reply).catch((err) => {
    // err need not be an Error: a rejected non-Error value would otherwise
    // render as "...: undefined".
    const detail = (err && err.message) || String(err);
    reply({ error: `${failureMessage}: ${detail}` });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages from this extension's own contexts.
  if (sender.id !== chrome.runtime.id) {
    return;
  }

  switch (message.type) {
    case "AUTH_TOKEN":
      respondAsync(
        storeToken(message.token),
        sendResponse,
        "Failed to store token",
      );
      return true;

    case "GET_AUTH_STATUS":
      respondAsync(getAuthStatus(), sendResponse, "Failed to read auth status");
      return true;

    case "REFRESH_AUTH":
      respondAsync(
        refreshAuth(message.windowId),
        sendResponse,
        "Refresh auth failed",
      );
      return true;

    case "GET_PAGE_CONTEXT":
      respondAsync(
        getPageContext(message.windowId),
        sendResponse,
        "Failed to get page context",
      );
      return true;

    case "SEND_CHAT_MESSAGE":
      respondAsync(
        sendChatMessage(message.messages),
        sendResponse,
        "API error",
      );
      return true;

    default:
      return;
  }
});

// Click toolbar icon to open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
