chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages from this extension's own contexts
  if (sender.id !== chrome.runtime.id) {
    return;
  }

  if (message.type === "AUTH_TOKEN") {
    chrome.storage.session
      .set({ qwenToken: message.token })
      .then(() => sendResponse({ status: "success" }))
      .catch((error) =>
        sendResponse({ status: "error", error: error.message }),
      );
    return true;
  }

  if (message.type === "GET_AUTH_STATUS") {
    chrome.storage.session
      .get("qwenToken")
      .then((result) =>
        sendResponse({ isAuthenticated: !!(result && result.qwenToken) }),
      )
      .catch(() => sendResponse({ isAuthenticated: false }));
    return true;
  }

  if (message.type === "GET_PAGE_CONTEXT") {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ error: "No active tab found." });
        return;
      }
      const tab = tabs[0];

      // Prevent injection into restricted browser pages
      if (
        tab.url.startsWith("chrome://") ||
        tab.url.startsWith("edge://") ||
        tab.url.startsWith("about:") ||
        tab.url.startsWith("chrome-extension://")
      ) {
        sendResponse({
          error:
            "Cannot read context from browser internal or extension pages.",
        });
        return;
      }

      chrome.tabs
        .sendMessage(tab.id, { type: "GET_PAGE_CONTEXT" })
        .then((response) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              error:
                "Could not connect to the page. It might be a restricted page, or the extension needs to be reloaded.",
            });
          } else {
            sendResponse({
              ...response,
              url: tab.url,
              title: tab.title,
            });
          }
        })
        .catch((err) => {
          sendResponse({ error: "Failed to get page context: " + err.message });
        });
    });
    return true; // Keep channel open for async tab query
  }

  if (message.type === "SEND_CHAT_MESSAGE") {
    chrome.storage.session.get("qwenToken").then((result) => {
      if (!result || !result.qwenToken) {
        sendResponse({
          error:
            "Not authenticated. Please log in at chat.qwen.ai and refresh.",
        });
        return;
      }

      // Community proxy accepting chat.qwen.ai web tokens.
      // Future API Key Upgrade: Change URL to "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
      fetch("https://qwen.aikit.club/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${result.qwenToken}`,
        },
        body: JSON.stringify({
          model: "qwen3.5-flash", // Fast, responsive model ideal for sidebar use
          messages: message.messages,
          stream: false, // Phase 2: Simple request/response. Streaming can be added later.
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (data.choices && data.choices[0] && data.choices[0].message) {
            sendResponse({ content: data.choices[0].message.content });
          } else {
            sendResponse({ error: "Unexpected API response", details: data });
          }
        })
        .catch((err) => {
          sendResponse({ error: "Network or API error", details: err.message });
        });

      return true; // Keep message channel open for async fetch
    });
    return true;
  }
});

// Click toolbar icon to open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
