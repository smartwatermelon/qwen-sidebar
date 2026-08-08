// Schemes we can inject into. https only: the manifest no longer requests
// http://*/*, so an http page would fail injection with an opaque error rather
// than this clear message. An allowlist also rejects chrome://, edge://,
// about:, chrome-extension://, devtools://, view-source:, file:, data: and
// blob: in one check — a denylist of known-bad schemes kept missing cases.
const INJECTABLE_PROTOCOLS = new Set(["https:"]);

// Alibaba Model Studio billing modes are isolated: a credential and a base URL
// must be used as a matching pair. Their docs warn that mixing them either
// routes the request to the pay-as-you-go channel — billing real money against
// an account the user believes is on a flat subscription — or returns 401/403.
// checkKeyHostPairing() below refuses to send rather than risk the former.
const TOKEN_PLAN_KEY_PREFIX = "sk-sp-";
const TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

// Matched against a parsed hostname, never a string prefix. A prefix test on
// "https://token-plan." admits https://token-plan.evil.com — the same class of
// bug as the chat.qwen.ai origin check this migration replaced. Region varies
// (ap-southeast-1, cn-beijing, ...), so the label is a wildcard but the
// registrable domain is pinned.
const TOKEN_PLAN_HOST = /^token-plan\.[a-z0-9-]+\.maas\.aliyuncs\.com$/;

// The Token Plan model list is an exact-match allowlist — a version or variant
// mismatch is rejected upstream rather than silently downgraded. Note that
// qwen3.5-flash, used before this migration, is not on it.
const TOKEN_PLAN_MODELS = [
  "qwen3.8-max-preview",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "glm-5.2",
  "deepseek-v4-pro",
];

const CONFIG_DEFAULTS = {
  apiKey: "",
  baseUrl: TOKEN_PLAN_BASE_URL,
  model: "qwen3.6-flash",
};

const CHAT_TIMEOUT_MS = 60000;

// Highlight action: an exact-match allowlist, same posture as
// TOKEN_PLAN_MODELS — a model-supplied color name is untrusted input and
// must never reach a style attribute directly (CSS injection). An
// unrecognized name falls back to the default rather than erroring, since a
// hallucinated color shouldn't block an otherwise-valid highlight.
const HIGHLIGHT_COLORS = {
  yellow: "#fff59d",
  green: "#a5d6a7",
  pink: "#f8bbd0",
  blue: "#90caf9",
};
const DEFAULT_HIGHLIGHT_COLOR = "yellow";
const MAX_HIGHLIGHT_TEXT_LENGTH = 200;
const MAX_HIGHLIGHT_MATCHES = 50;

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
async function injectAndRead(tabId, func, args = []) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: func,
    args: args,
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

// --- Injected page function --------------------------------------------------
// Serialized and run in the page, so it must be fully self-contained: no
// imports, no closure over anything above.

function extractPageContent() {
  const MAX_LENGTH = 4000;
  const MAX_ELEMENTS = 5000;
  const TRUNCATION_NOTE = "\n\n[Content truncated for length...]";

  const clean = (raw) => (raw || "").replace(/\n\s*\n/g, "\n").trim();
  const limit = (raw) =>
    raw.length > MAX_LENGTH
      ? raw.substring(0, MAX_LENGTH) + TRUNCATION_NOTE
      : raw;

  // Provenance is read here, in the page, rather than from the caller's
  // pre-injection tabs.query snapshot. A tab that navigates between the
  // protocol check and the injection would otherwise label the new page's text
  // with the old page's URL and title — a trusted label on untrusted content.
  const provenance = { url: location.href, title: document.title || "" };

  // 1. An explicit user selection is the strongest signal of intent.
  const selection = window.getSelection();
  const selected = clean(selection ? selection.toString() : "");
  if (selected) {
    return { type: "selection", text: limit(selected), ...provenance };
  }

  // 2. Otherwise pull block elements from the main content region.
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

  return { type: "page", text: limit(text), ...provenance };
}

// Serialized and run in the page — same self-containment constraint as
// extractPageContent: no closures over outer scope. Args arrive through
// executeScript's `args`, not by capture.
//
// Matches within a single text node only — a phrase split across elements
// (e.g. "<b>quick</b> brown") won't match. Reconstructing text across node
// boundaries to support that adds real complexity (mapping a match back to
// multiple ranges to wrap) for a rare phrasing; out of scope for this slice.
function highlightTextOnPage(text, hex, maxMatches) {
  const needle = text.toLowerCase();
  // MARK is skipped too, so a second highlight request can't re-match text
  // already wrapped by a prior one and produce nested marks.
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "MARK"]);

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.parentElement && !skipTags.has(node.parentElement.tagName)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    },
  );

  // Collect nodes first: mutating the tree (splitting text nodes) while the
  // walker is mid-traversal would skip or revisit nodes.
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node);
  }

  let count = 0;
  for (const node of nodes) {
    if (count >= maxMatches) break;

    const value = node.nodeValue;
    const lower = value.toLowerCase();
    const parent = node.parentNode;

    // Walk every occurrence within this node's value, not just the first,
    // inserting a <mark> plus the untouched text around it for each hit and
    // finally dropping the original node once all its pieces are in place.
    let cursor = 0;
    let sawMatch = false;
    while (count < maxMatches) {
      const idx = lower.indexOf(needle, cursor);
      if (idx === -1) break;

      const before = value.slice(cursor, idx);
      // idx was located in `lower` via `needle` (both case-folded), so the
      // match slice and cursor advance must use needle.length, not
      // text.length: a lowercase form can have a different UTF-16 code-unit
      // count than the original (e.g. "İ" -> "i̇" in Turkish locale, or
      // ligatures), which would otherwise miss or double-highlight a
      // character at each match.
      const match = value.slice(idx, idx + needle.length);

      const mark = document.createElement("mark");
      mark.setAttribute("data-qwen-hl", "1");
      mark.style.backgroundColor = hex;
      mark.textContent = match;

      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(mark, node);

      sawMatch = true;
      count += 1;
      cursor = idx + needle.length;
    }

    if (!sawMatch) continue;

    const after = value.slice(cursor);
    if (after) parent.insertBefore(document.createTextNode(after), node);
    parent.removeChild(node);
  }

  return count;
}

// Unwraps every mark this extension created, merging its text back into the
// surrounding node. Self-contained for the same reason as above.
function clearHighlightsOnPage() {
  const marks = document.querySelectorAll("mark[data-qwen-hl]");
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  return marks.length;
}

// --- Configuration -----------------------------------------------------------

// chrome.storage.local, not session: an API key the user pasted should survive a
// browser restart. local is not synced, so the key never leaves this machine.
async function getConfig() {
  const stored =
    (await chrome.storage.local.get(Object.keys(CONFIG_DEFAULTS))) || {};
  // Coerce to string: storage is shared with anything that can write to this
  // extension's area, and a non-string apiKey would throw out of getStatus()
  // into an unhandled rejection, leaving the panel stuck on "Checking...".
  return {
    apiKey: String(stored.apiKey ?? CONFIG_DEFAULTS.apiKey),
    baseUrl: String(stored.baseUrl ?? CONFIG_DEFAULTS.baseUrl),
    model: String(stored.model ?? CONFIG_DEFAULTS.model),
  };
}

// Strips the credential from any text that crosses back to the panel. Applied
// at every exit that can carry an upstream response body, not just the !ok
// branch — a 200 with an unexpected shape reaches the transcript too.
function redactSecret(text, secret) {
  const out = String(text ?? "");
  const withoutValue = secret ? out.split(secret).join("[redacted]") : out;
  return withoutValue.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function isTokenPlanHost(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url || url.protocol !== "https:") return false;
  return TOKEN_PLAN_HOST.test(url.hostname);
}

// Rejects a base URL that is unparseable or not https. This is a security
// control, distinct from the billing-mode pairing check below: without it a
// pay-as-you-go key pairs happily with http://attacker.example/v1 and the
// bearer token goes out in cleartext.
function checkBaseUrl(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url) return "Base URL must be a valid absolute URL.";
  if (url.protocol !== "https:") return "Base URL must use https://.";
  return null;
}

// Returns an error string when the credential and endpoint belong to different
// billing modes, or null when the pairing is valid.
//
// Deliberately silent when neither side is Token Plan: this is an
// OpenAI-compatible client and a pay-as-you-go key is allowed to point at any
// https endpoint the user configures (a gateway, a proxy, a self-hosted
// compatible server). That is a user decision, not an attack surface — nothing
// untrusted can write baseUrl, and checkBaseUrl() still enforces https. The
// Token Plan asymmetry exists because mispairing *that* key silently spends
// money on the wrong channel.
function checkKeyHostPairing(apiKey, baseUrl) {
  const planKey = apiKey.startsWith(TOKEN_PLAN_KEY_PREFIX);
  const planHost = isTokenPlanHost(baseUrl);

  if (planKey && !planHost) {
    return (
      "A Token Plan key (sk-sp-) must be paired with the Token Plan endpoint. " +
      "Sending it elsewhere would bill against pay-as-you-go. Expected: " +
      TOKEN_PLAN_BASE_URL
    );
  }
  if (!planKey && planHost) {
    return (
      "The Token Plan endpoint requires a Token Plan key (sk-sp-). " +
      "A pay-as-you-go key will be rejected with 401."
    );
  }
  return null;
}

async function getStatus() {
  const config = await getConfig();
  return {
    isAuthenticated: !!config.apiKey,
    // Never returns the key itself — the panel only needs to know one is
    // present and which tail it ends with.
    keyHint: config.apiKey ? `…${config.apiKey.slice(-4)}` : "",
    baseUrl: config.baseUrl,
    model: config.model,
    models: TOKEN_PLAN_MODELS,
    pairingError: config.apiKey
      ? checkKeyHostPairing(config.apiKey, config.baseUrl)
      : null,
  };
}

async function saveConfig(patch) {
  const current = await getConfig();
  const next = {
    // null is the explicit "clear the key" sentinel; undefined means "leave it
    // alone", which is what the panel sends when editing only model or URL.
    apiKey:
      patch.apiKey === undefined
        ? current.apiKey
        : patch.apiKey === null
          ? ""
          : String(patch.apiKey).trim(),
    baseUrl:
      patch.baseUrl === undefined
        ? current.baseUrl
        : normalizeBaseUrl(patch.baseUrl) || CONFIG_DEFAULTS.baseUrl,
    model:
      patch.model === undefined ? current.model : String(patch.model).trim(),
  };

  // Validate what this patch actually writes, not the merged result. Judging
  // inherited values would let stale storage — a model later dropped from the
  // allowlist, a legacy base URL — reject an unrelated write, including
  // clearing the key, which is the one operation that must always succeed.
  if (patch.model !== undefined) {
    if (!next.model) {
      return { error: "Model cannot be empty." };
    }
    if (!TOKEN_PLAN_MODELS.includes(next.model)) {
      // The upstream list is an exact-match allowlist; a typo would otherwise
      // be stored and only surface as an opaque error at send time.
      return { error: `Unknown model "${next.model}".` };
    }
  }

  if (patch.baseUrl !== undefined) {
    const baseUrlError = checkBaseUrl(next.baseUrl);
    if (baseUrlError) {
      return { error: baseUrlError };
    }
  }

  // Endpoint checks guard a credential, so they apply exactly when one will be
  // stored. Clearing the key needs no endpoint at all.
  if (next.apiKey) {
    const baseUrlError = checkBaseUrl(next.baseUrl);
    if (baseUrlError) {
      return { error: baseUrlError };
    }

    const pairingError = checkKeyHostPairing(next.apiKey, next.baseUrl);
    if (pairingError) {
      // Refuse the write rather than storing a combination that spends money on
      // the wrong channel the next time the user hits Send.
      return { error: pairingError };
    }
  }

  await chrome.storage.local.set(next);
  return { status: "success" };
}

// --- Message handlers --------------------------------------------------------

// Shared by every action that injects into the active tab: resolves the tab
// and applies the same https-only gating getPageContext already enforced, so
// a highlight request against a chrome:// or plain-http page fails the same
// way page-context extraction does rather than a second, divergent check.
async function getInjectableTab(windowId) {
  const tab = await getActiveTab(windowId);
  if (!tab) {
    return { error: "No active tab found." };
  }

  const url = parseUrl(tab.url);
  if (url && url.protocol === "http:") {
    return {
      error:
        "This action requires an https page. This extension does not request access to plain HTTP pages.",
    };
  }
  if (!url || !INJECTABLE_PROTOCOLS.has(url.protocol)) {
    return {
      error: "Cannot act on browser internal or extension pages.",
    };
  }

  return { tab };
}

async function getPageContext(windowId) {
  const gated = await getInjectableTab(windowId);
  if (gated.error) {
    return { error: gated.error };
  }
  const tab = gated.tab;

  const extracted = await injectAndRead(tab.id, extractPageContent);
  if (!extracted || !extracted.text) {
    return { error: "No text found on this page." };
  }

  // url/title come from inside the page, not from the tab snapshot taken before
  // injection, so the provenance label always describes the text that was
  // actually read. Fall back to the tab only if the page withheld them.
  return {
    ...extracted,
    url: extracted.url || tab.url,
    title: extracted.title || tab.title || "",
  };
}

async function applyHighlight(windowId, text, color) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { error: "No text to highlight." };
  }
  if (trimmed.length > MAX_HIGHLIGHT_TEXT_LENGTH) {
    return { error: "Highlight text is too long." };
  }

  // Tab is resolved once here and reused below; if the user switches the
  // active tab in the (single-digit ms) gap before injection, the highlight
  // lands on the tab they had selected when they clicked Apply, not
  // whatever is active by the time it runs. Low-stakes and not worth an
  // extra re-validation round-trip for this slice.
  const gated = await getInjectableTab(windowId);
  if (gated.error) {
    return { error: gated.error };
  }

  // An unrecognized color name falls back to the default rather than
  // rejecting the request — see the comment on HIGHLIGHT_COLORS.
  const hex =
    HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS[DEFAULT_HIGHLIGHT_COLOR];

  const count = await injectAndRead(gated.tab.id, highlightTextOnPage, [
    trimmed,
    hex,
    MAX_HIGHLIGHT_MATCHES,
  ]);

  if (!count) {
    return { error: `No match found for "${trimmed}" on this page.` };
  }
  return { count };
}

async function clearHighlights(windowId) {
  const gated = await getInjectableTab(windowId);
  if (gated.error) {
    return { error: gated.error };
  }

  const count = await injectAndRead(gated.tab.id, clearHighlightsOnPage);
  return { count };
}

async function sendChatMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "No messages to send." };
  }

  const config = await getConfig();
  if (!config.apiKey) {
    return {
      error: "No API key configured. Open Settings and paste your key.",
      needsConfig: true,
    };
  }

  // Re-validated at send time, not only at save: storage could have been
  // written by an earlier version of this extension, or by anything else with
  // access to its storage area.
  const baseUrlError = checkBaseUrl(config.baseUrl);
  if (baseUrlError) {
    return { error: baseUrlError, needsConfig: true };
  }

  const pairingError = checkKeyHostPairing(config.apiKey, config.baseUrl);
  if (pairingError) {
    return { error: pairingError, needsConfig: true };
  }

  const res = await fetch(
    `${normalizeBaseUrl(config.baseUrl)}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: messages,
        stream: false,
      }),
      // Without this, an endpoint that accepts the connection and then hangs
      // leaves the panel stuck on "Thinking..." with the send button disabled.
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    },
  );

  if (res.status === 401 || res.status === 403) {
    return {
      error:
        "API key rejected. Check that the key is current and matches the base URL's billing mode.",
      needsConfig: true,
    };
  }

  if (res.status === 429) {
    // Token Plan Lite caps at 700 credits per 5 hours and 2,500 per 7 days;
    // hitting either pauses service until that window rolls over.
    return {
      error:
        "Rate limited or quota exhausted. Token Plan quota resets on a rolling window — try again later.",
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const safeBody = redactSecret(body, config.apiKey);
    throw new Error(
      `HTTP ${res.status}${safeBody ? `: ${safeBody.slice(0, 200)}` : ""}`,
    );
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  if (!choice || !choice.message) {
    // A 200 with an unexpected shape still carries an upstream body, and the
    // panel renders details into the transcript — redact it the same way.
    return {
      error: "Unexpected API response",
      details: redactSecret(JSON.stringify(data), config.apiKey).slice(0, 500),
    };
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
    case "GET_AUTH_STATUS":
      respondAsync(getStatus(), sendResponse, "Failed to read status");
      return true;

    case "SAVE_CONFIG":
      respondAsync(
        saveConfig(message.config || {}),
        sendResponse,
        "Failed to save settings",
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

    case "APPLY_HIGHLIGHT":
      respondAsync(
        applyHighlight(message.windowId, message.text, message.color),
        sendResponse,
        "Failed to apply highlight",
      );
      return true;

    case "CLEAR_HIGHLIGHTS":
      respondAsync(
        clearHighlights(message.windowId),
        sendResponse,
        "Failed to clear highlights",
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
