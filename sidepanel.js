const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");
const contextBtn = document.getElementById("context-btn");
const refreshAuthBtn = document.getElementById("refresh-auth-btn");

let messageHistory = [];
let isWaiting = false;
let authHintShown = false;

// Check auth status on load
checkStatus();

async function checkStatus() {
  let isAuthenticated = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_AUTH_STATUS",
    });
    isAuthenticated = !!(response && response.isAuthenticated);
  } catch {
    isAuthenticated = false;
  }

  if (isAuthenticated) {
    statusEl.textContent = "Authenticated";
    statusEl.className = "status connected";
    // Re-arm the hint so it reappears if authentication is later lost.
    authHintShown = false;
    return;
  }

  statusEl.textContent = "Not Authenticated";
  statusEl.className = "status disconnected";

  // Show the guidance once per unauthenticated stretch. checkStatus() runs on
  // load and after every Refresh Auth attempt, so repeated failures would
  // otherwise stack identical messages in the transcript.
  if (!authHintShown) {
    authHintShown = true;
    appendMessage(
      "error",
      "Please open https://chat.qwen.ai/ in a tab, ensure you are logged in, and click the 'Refresh Auth' button in the header.",
    );
  }
}

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

// The side panel is per-window, but the service worker has no window of its own
// and would resolve `currentWindow` to whichever was last focused. Pass ours
// explicitly so a second browser window can't have its page read instead.
async function getHostWindowId() {
  try {
    const win = await chrome.windows.getCurrent();
    return win && typeof win.id === "number" ? win.id : undefined;
  } catch {
    return undefined;
  }
}

// A turn that never reached the model is dropped from messageHistory, so the
// bubble left on screen would otherwise look like part of the conversation.
function markUnsent(bubble, reason) {
  if (!bubble) return;
  bubble.style.opacity = "0.55";
  bubble.title = reason;
}

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || isWaiting) return;

  isWaiting = true;
  sendBtn.disabled = true;
  userInput.value = "";
  userInput.style.height = "40px"; // Reset height

  const userBubble = appendMessage("user", text);
  messageHistory.push({ role: "user", content: text });

  // Restores the text to the composer when a turn fails, so "removed from
  // history to allow retry" actually leaves something to retry with.
  const restoreDraft = (reason) => {
    messageHistory.pop();
    markUnsent(userBubble, reason);
    if (!userInput.value.trim()) {
      userInput.value = text;
      userInput.dispatchEvent(new Event("input"));
    }
  };

  // Show temporary loading state
  const loadingId = "loading-" + Date.now();
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "message assistant";
  loadingDiv.id = loadingId;
  loadingDiv.textContent = "Thinking...";
  chatContainer.appendChild(loadingDiv);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SEND_CHAT_MESSAGE",
      messages: messageHistory,
    });

    // Remove loading indicator
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (response && response.error) {
      appendMessage(
        "error",
        response.error +
          (response.details ? `: ${JSON.stringify(response.details)}` : ""),
      );
      restoreDraft("Not sent: " + response.error);
      if (response.authExpired) {
        // The token was rejected and has been cleared; resync the status pill
        // so it stops reading "Authenticated".
        await checkStatus();
      }
    } else if (response && response.content) {
      appendMessage("assistant", response.content);
      messageHistory.push({ role: "assistant", content: response.content });
    } else {
      appendMessage("error", "Empty or malformed response from API.");
      restoreDraft("Not sent: empty or malformed response");
    }
  } catch (err) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    appendMessage(
      "error",
      "Failed to communicate with background script: " + err.message,
    );
    restoreDraft("Not sent: " + err.message);
  } finally {
    isWaiting = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
}

// Handle "Refresh Auth" button
refreshAuthBtn.addEventListener("click", async () => {
  refreshAuthBtn.disabled = true;
  refreshAuthBtn.textContent = "Checking...";

  try {
    // background.js performs the tab lookup, the origin check and the injection,
    // so the bearer token never passes through this context.
    const response = await chrome.runtime.sendMessage({
      type: "REFRESH_AUTH",
      windowId: await getHostWindowId(),
    });

    if (response && response.error) {
      appendMessage("error", response.error);
    } else {
      await checkStatus();
    }
  } catch (err) {
    // Surface the real cause: this path covers a suspended service worker and a
    // failed storage write, not just tab connectivity.
    appendMessage("error", "Refresh Auth failed: " + err.message);
  } finally {
    refreshAuthBtn.disabled = false;
    refreshAuthBtn.textContent = "Refresh Auth";
  }
});

// Handle "Add Page Context" button
contextBtn.addEventListener("click", async () => {
  contextBtn.disabled = true;
  const originalText = contextBtn.innerHTML;
  contextBtn.innerHTML = "<span>⏳</span> Loading...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PAGE_CONTEXT",
      windowId: await getHostWindowId(),
    });

    if (response && response.error) {
      appendMessage("error", response.error);
    } else if (response && response.text) {
      const contextPrefix =
        response.type === "selection"
          ? `--- Selected Text from: ${response.title} ---\n`
          : `--- Page Context from: ${response.title} (${response.url}) ---\n`;

      const contextBlock = `${contextPrefix}${response.text}\n-------------------\n\n`;

      // Insert at cursor position or at the end
      const startPos = userInput.selectionStart;
      const endPos = userInput.selectionEnd;
      const currentText = userInput.value;

      userInput.value =
        currentText.substring(0, startPos) +
        contextBlock +
        currentText.substring(endPos);

      // Move cursor to the end of the inserted text
      const newCursorPos = startPos + contextBlock.length;
      userInput.setSelectionRange(newCursorPos, newCursorPos);
      userInput.focus();

      // Trigger input event to auto-resize textarea
      userInput.dispatchEvent(new Event("input"));
    } else {
      appendMessage("error", "No text found on this page.");
    }
  } catch (err) {
    appendMessage("error", "Failed to get page context: " + err.message);
  } finally {
    contextBtn.disabled = false;
    contextBtn.innerHTML = originalText;
  }
});

sendBtn.addEventListener("click", sendMessage);

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea up to a max height
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});
