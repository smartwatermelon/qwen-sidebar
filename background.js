chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages from this extension's own contexts (content script on
  // chat.qwen.ai, side panel). Web pages can't reach onMessage without
  // externally_connectable (not declared), but validate defensively anyway.
  if (sender.id !== chrome.runtime.id) {
    return;
  }

  if (message.type === "AUTH_TOKEN") {
    // Store in session storage (clears on browser close, matching session
    // semantics). Respond only after the write settles — including on failure —
    // so an awaiting caller never hangs waiting for a response that never comes.
    chrome.storage.session
      .set({ qwenToken: message.token })
      .then(() => sendResponse({ status: "success" }))
      .catch((error) =>
        sendResponse({ status: "error", error: error.message }),
      );
    return true; // Keep channel open for async response
  } else if (message.type === "GET_AUTH_STATUS") {
    chrome.storage.session
      .get("qwenToken")
      .then((result) =>
        sendResponse({ isAuthenticated: !!(result && result.qwenToken) }),
      )
      .catch(() => sendResponse({ isAuthenticated: false }));
    return true; // Keep channel open for async response
  }
});

// Click toolbar icon to open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
