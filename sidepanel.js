const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");
const contextBtn = document.getElementById("context-btn");
const refreshAuthBtn = document.getElementById("refresh-auth-btn");

let messageHistory = [];
let isWaiting = false;

// Check auth status on load
checkStatus();

function checkStatus() {
  chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" }, (response) => {
    if (response && response.isAuthenticated) {
      statusEl.textContent = "Authenticated";
      statusEl.className = "status connected";
    } else {
      statusEl.textContent = "Not Authenticated";
      statusEl.className = "status disconnected";
      appendMessage(
        "error",
        "Please open https://chat.qwen.ai/ in a tab, ensure you are logged in, and click the 'Refresh Auth' button in the header.",
      );
    }
  });
}

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || isWaiting) return;

  isWaiting = true;
  sendBtn.disabled = true;
  userInput.value = "";
  userInput.style.height = "40px"; // Reset height

  appendMessage("user", text);
  messageHistory.push({ role: "user", content: text });

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
      // Remove the failed user message from history to allow retry
      messageHistory.pop();
    } else if (response && response.content) {
      appendMessage("assistant", response.content);
      messageHistory.push({ role: "assistant", content: response.content });
    } else {
      appendMessage("error", "Empty or malformed response from API.");
      messageHistory.pop();
    }
  } catch (err) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    appendMessage("error", "Failed to communicate with background script.");
    messageHistory.pop();
  } finally {
    isWaiting = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
}

// Handle "Refresh Auth" button
refreshAuthBtn.addEventListener("click", () => {
  refreshAuthBtn.disabled = true;
  refreshAuthBtn.textContent = "Checking...";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (
      tabs[0] &&
      tabs[0].url &&
      tabs[0].url.startsWith("https://chat.qwen.ai")
    ) {
      chrome.tabs
        .sendMessage(tabs[0].id, { type: "REQUEST_TOKEN" })
        .then(() => {
          // Wait a brief moment for the background script to store the token
          setTimeout(() => {
            checkStatus();
            refreshAuthBtn.disabled = false;
            refreshAuthBtn.textContent = "Refresh Auth";
          }, 300);
        })
        .catch(() => {
          appendMessage(
            "error",
            "Could not connect to the chat.qwen.ai tab. Ensure it is open and loaded.",
          );
          refreshAuthBtn.disabled = false;
          refreshAuthBtn.textContent = "Refresh Auth";
        });
    } else {
      appendMessage(
        "error",
        "Please switch to the https://chat.qwen.ai/ tab and try again.",
      );
      refreshAuthBtn.disabled = false;
      refreshAuthBtn.textContent = "Refresh Auth";
    }
  });
});

// Handle "Add Page Context" button
contextBtn.addEventListener("click", async () => {
  contextBtn.disabled = true;
  const originalText = contextBtn.innerHTML;
  contextBtn.innerHTML = "<span>⏳</span> Loading...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PAGE_CONTEXT",
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
