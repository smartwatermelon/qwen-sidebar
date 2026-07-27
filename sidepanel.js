const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const statusEl = document.getElementById("status");
const contextBtn = document.getElementById("context-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings");
const apiKeyInput = document.getElementById("api-key-input");
const modelInput = document.getElementById("model-input");
const baseUrlInput = document.getElementById("base-url-input");
const saveSettingsBtn = document.getElementById("save-settings-btn");
const clearKeyBtn = document.getElementById("clear-key-btn");
const settingsFeedback = document.getElementById("settings-feedback");

const MAX_HISTORY_MESSAGES = 20;

let messageHistory = [];
let isWaiting = false;
let authHintShown = false;

// Check auth status on load
checkStatus();

async function checkStatus() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" });
  } catch {
    status = null;
  }

  if (status) {
    populateSettings(status);
  }

  if (status && status.pairingError) {
    // A stored key/URL combination that would bill the wrong channel. Surface
    // it rather than waiting for the user to hit Send.
    statusEl.textContent = "Misconfigured";
    statusEl.className = "status disconnected";
    settingsFeedback.textContent = status.pairingError;
    settingsFeedback.className = "settings-error";
    settingsPanel.classList.add("open");
    return;
  }

  if (status && status.isAuthenticated) {
    statusEl.textContent = `Ready · ${status.model}`;
    statusEl.className = "status connected";
    // Re-arm the hint so it reappears if the key is later removed.
    authHintShown = false;
    return;
  }

  statusEl.textContent = "No API key";
  statusEl.className = "status disconnected";

  // Show the guidance once per unconfigured stretch. checkStatus() runs on load
  // and after every save, so repeated failures would otherwise stack identical
  // messages in the transcript.
  if (!authHintShown) {
    authHintShown = true;
    settingsPanel.classList.add("open");
    appendMessage(
      "error",
      "Paste your Alibaba Model Studio API key in Settings to get started.",
    );
  }
}

// Renders current config into the settings panel. The API key is never returned
// by the background script, so the field shows a masked hint as a placeholder
// and stays empty unless the user is entering a new key.
function populateSettings(status) {
  if (Array.isArray(status.models) && modelInput.options.length === 0) {
    for (const name of status.models) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      modelInput.appendChild(option);
    }
  }

  // Compare option values directly rather than building a CSS selector from
  // stored data — a quote in the value would throw SyntaxError out of here and
  // abort checkStatus() before the status pill is set.
  const known = Array.from(modelInput.options).some(
    (option) => option.value === status.model,
  );
  if (status.model && !known) {
    const option = document.createElement("option");
    option.value = status.model;
    option.textContent = `${status.model} (custom)`;
    modelInput.appendChild(option);
  }

  if (status.model) modelInput.value = status.model;
  if (status.baseUrl) baseUrlInput.value = status.baseUrl;
  apiKeyInput.placeholder = status.keyHint
    ? `saved ${status.keyHint}`
    : "sk-sp-...";
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
          (response.details
            ? // Already a redacted string from the background script;
              // re-stringifying would render it as an escaped-quote blob.
              `: ${typeof response.details === "string" ? response.details : JSON.stringify(response.details)}`
            : ""),
      );
      restoreDraft("Not sent: " + response.error);
      if (response.needsConfig) {
        // Missing, rejected, or mispaired credentials — resync the status pill
        // and put the settings panel in front of the user rather than making
        // them hunt for it.
        settingsPanel.classList.add("open");
        await checkStatus();
      }
    } else if (response && response.content) {
      appendMessage("assistant", response.content);
      messageHistory.push({ role: "assistant", content: response.content });
      // Every send posts the whole history, and a page-context block is up to
      // 4000 characters. Unbounded, that spends quota quadratically against a
      // capped plan. Older turns stay visible in the transcript.
      if (messageHistory.length > MAX_HISTORY_MESSAGES) {
        messageHistory = messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }
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

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("open");
  if (settingsPanel.classList.contains("open")) apiKeyInput.focus();
});

saveSettingsBtn.addEventListener("click", async () => {
  saveSettingsBtn.disabled = true;
  settingsFeedback.textContent = "Saving...";
  settingsFeedback.className = "hint";

  // Only send apiKey when the user actually typed one, so leaving the field
  // blank edits the model or base URL without clearing a stored key.
  const config = {
    model: modelInput.value,
    baseUrl: baseUrlInput.value,
  };
  if (apiKeyInput.value.trim()) {
    config.apiKey = apiKeyInput.value.trim();
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_CONFIG",
      config: config,
    });

    if (response && response.error) {
      settingsFeedback.textContent = response.error;
      settingsFeedback.className = "settings-error";
      return;
    }

    settingsFeedback.textContent = "Saved.";
    settingsFeedback.className = "hint";
    await checkStatus();
  } catch (err) {
    settingsFeedback.textContent = "Save failed: " + err.message;
    settingsFeedback.className = "settings-error";
  } finally {
    // Clear on every outcome, not just success, so a pasted key is never left
    // sitting in the DOM after a rejected save.
    apiKeyInput.value = "";
    saveSettingsBtn.disabled = false;
  }
});

clearKeyBtn.addEventListener("click", async () => {
  clearKeyBtn.disabled = true;
  try {
    // null is the explicit "remove it" sentinel; a blank field means "unchanged"
    // so that editing the model doesn't silently wipe the key.
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_CONFIG",
      config: { apiKey: null },
    });

    settingsFeedback.textContent =
      response && response.error ? response.error : "Key cleared.";
    settingsFeedback.className =
      response && response.error ? "settings-error" : "hint";
    await checkStatus();
  } catch (err) {
    settingsFeedback.textContent = "Clear failed: " + err.message;
    settingsFeedback.className = "settings-error";
  } finally {
    apiKeyInput.value = "";
    clearKeyBtn.disabled = false;
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
