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

  if (message.type === "GET_PAGE_CONTEXT") {
    // 1. Check for user selection first
    const selection = window.getSelection().toString().trim();
    if (selection) {
      sendResponse({
        type: "selection",
        text: selection,
      });
      return true;
    }

    // 2. Fallback: Extract main content heuristically
    // Grab text from semantic elements to avoid navbars, footers, and ads
    const elements = document.querySelectorAll(
      "p, h1, h2, h3, h4, h5, h6, li, pre, code, article, main",
    );
    let text = Array.from(elements)
      .map((el) => el.innerText.trim())
      .filter((t) => t.length > 0)
      .join("\n");

    // 3. Ultimate fallback
    if (!text || text.length < 50) {
      text = document.body.innerText;
    }

    // 4. Clean and limit to avoid token overflow
    text = text.replace(/\n\s*\n/g, "\n").trim();
    const maxLength = 4000;
    const truncatedText =
      text.length > maxLength
        ? text.substring(0, maxLength) + "\n\n[Content truncated for length...]"
        : text;

    sendResponse({
      type: "page",
      text: truncatedText,
    });
    return true;
  }
});
