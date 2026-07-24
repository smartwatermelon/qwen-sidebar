async function extractAndSendToken() {
  // Primary method: localStorage (documented for chat.qwen.ai)
  const token =
    localStorage.getItem("token") || localStorage.getItem("access_token");

  if (!token || token.trim().length === 0) {
    return false;
  }

  try {
    // Await the round trip so callers know the token is stored, not just sent.
    await chrome.runtime.sendMessage({ type: "AUTH_TOKEN", token: token });
    return true;
  } catch (e) {
    // Background script temporarily suspended / context invalidated.
    console.warn("[Qwen Sidebar] Failed to send token to background:", e);
    return false;
  }
}

// Run on initial page load
extractAndSendToken();

// Allow manual trigger from side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages here originate only from this extension (side panel / background);
  // a web page can't message a content script's onMessage. Validate defensively.
  if (sender.id !== chrome.runtime.id) {
    return;
  }

  if (message.type === "REQUEST_TOKEN") {
    // Respond only after the token has been extracted and stored, so the
    // side panel's follow-up status check reads the fresh value.
    extractAndSendToken().then((stored) => {
      sendResponse({ status: stored ? "found" : "no_token" });
    });
    return true; // Keep channel open for async response
  }
});
