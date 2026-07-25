// Captures the Qwen session token when a chat.qwen.ai tab finishes loading, so
// the side panel works without a manual "Refresh Auth" click in the common case.
//
// This script MUST stay scoped to https://chat.qwen.ai/* in manifest.json. It
// reads a generically-named localStorage key ("token") that many unrelated sites
// also use; on a broader match pattern it would capture other sites' session
// credentials and overwrite the Qwen token with them.
//
// Page-context extraction and the manual token refresh are deliberately NOT
// handled here. Both are injected on demand from background.js via
// chrome.scripting.executeScript, so they don't depend on this script having
// been loaded — it hasn't been, in any tab that was already open when the
// extension last reloaded.
async function extractAndSendToken() {
  const token =
    localStorage.getItem("token") || localStorage.getItem("access_token");

  if (!token || token.trim().length === 0) {
    return false;
  }

  try {
    // Await the round trip so the token is known to be stored, not just sent.
    await chrome.runtime.sendMessage({ type: "AUTH_TOKEN", token: token });
    return true;
  } catch (e) {
    // Background service worker suspended / extension context invalidated.
    console.warn("[Qwen Sidebar] Failed to send token to background:", e);
    return false;
  }
}

extractAndSendToken();
