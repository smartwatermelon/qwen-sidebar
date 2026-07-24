// Ask the tab's content script to re-extract and store the token. If the
// content script isn't there (common right after (re)loading the extension,
// since content scripts aren't injected into already-open tabs), inject it
// on demand and retry once. Resolves after the token has been stored.
async function requestTokenFromTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "REQUEST_TOKEN" });
  } catch (e) {
    // No receiver → inject content.js, then retry the same message. Injecting
    // the file (rather than a one-off function) keeps the token-extraction
    // logic in a single place and registers the listener for later clicks.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "REQUEST_TOKEN" });
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    // Exact host match — startsWith would also accept chat.qwen.ai.evil.com.
    let onQwen = false;
    if (tab && tab.url) {
      try {
        onQwen = new URL(tab.url).hostname === "chat.qwen.ai";
      } catch (e) {
        onQwen = false; // Non-parseable URL (e.g. chrome:// pages)
      }
    }

    if (onQwen) {
      // Refresh the display only after the token round trip completes.
      requestTokenFromTab(tab.id)
        .then(() => checkStatus())
        .catch((e) => {
          console.warn("[Qwen Sidebar] Refresh failed:", e);
          const debugEl = document.getElementById("debug");
          debugEl.textContent =
            "Couldn't reach the Qwen tab (" +
            (e && e.message ? e.message : "unknown error") +
            "). Try reloading https://chat.qwen.ai/ and click Refresh again.";
        });
    } else {
      // Not on a Qwen tab: just re-read whatever token is already stored.
      checkStatus();
    }
  });
});

function checkStatus() {
  chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" }, (response) => {
    const statusEl = document.getElementById("status");
    const debugEl = document.getElementById("debug");

    if (response && response.isAuthenticated) {
      statusEl.textContent = "Authenticated";
      statusEl.className = "status connected";
      debugEl.textContent = "Token loaded from active session.";
    } else {
      statusEl.textContent = "Not Authenticated";
      statusEl.className = "status disconnected";
      debugEl.textContent =
        "1. Open https://chat.qwen.ai/ in a tab.\n2. Ensure you are logged in.\n3. Click 'Refresh Auth Status'.";
    }
  });
}

// Initial check
checkStatus();
