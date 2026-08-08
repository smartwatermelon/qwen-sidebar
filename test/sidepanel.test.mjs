import test from "node:test";
import assert from "node:assert/strict";
import { loadSidepanel } from "./helpers.mjs";

// extractActionBlock() is a pure function pulled off the sidepanel.js sandbox
// (see loadSidepanel() in helpers.mjs for why it needs a vm context at all).

test("extracts a single action block and strips it from the reply text", () => {
  const { extractActionBlock } = loadSidepanel();
  const content =
    'Here you go.\n```json\n{"action":"highlight","text":"foo","color":"green"}\n```';

  const action = extractActionBlock(content);

  assert.ok(action);
  assert.equal(action.text, "foo");
  assert.equal(action.color, "green");
  assert.equal(action.remainingText, "Here you go.");
});

test("returns null when there is no fenced block", () => {
  const { extractActionBlock } = loadSidepanel();
  assert.equal(extractActionBlock("just a plain reply"), null);
});

// The regression this issue is about: a model reply that explains a JSON
// structure to the user (its own inline ```json fence) before appending the
// real action block per ACTION_SYSTEM_PROMPT. The first fence is not JSON the
// system prompt asked for, so picking it (the old behavior) would parse
// successfully but fail the `action !== "highlight"` check and drop the real
// action entirely.
test("with two json fences, the action block is the last one, not the first", () => {
  const { extractActionBlock } = loadSidepanel();
  const content =
    "Sure, here's an example of the shape I mean:\n" +
    '```json\n{"example":"structure","action":"not-a-real-action"}\n```\n' +
    "Anyway, applying it now:\n" +
    '```json\n{"action":"highlight","text":"bar","color":"blue"}\n```';

  const action = extractActionBlock(content);

  assert.ok(action, "expected the last fence to be recognized as the action block");
  assert.equal(action.text, "bar");
  assert.equal(action.color, "blue");
  assert.equal(
    action.remainingText,
    "Sure, here's an example of the shape I mean:\n" +
      '```json\n{"example":"structure","action":"not-a-real-action"}\n```\n' +
      "Anyway, applying it now:",
  );
});

test("three or more json fences still resolve to the last one", () => {
  const { extractActionBlock } = loadSidepanel();
  const content =
    '```json\n{"noop":1}\n```\n' +
    '```json\n{"noop":2}\n```\n' +
    '```json\n{"action":"highlight","text":"baz"}\n```';

  const action = extractActionBlock(content);

  assert.ok(action);
  assert.equal(action.text, "baz");
  assert.equal(action.color, "yellow"); // default when omitted
});

test("a malformed trailing fence returns null even if an earlier fence is valid JSON", () => {
  const { extractActionBlock } = loadSidepanel();
  const content =
    '```json\n{"action":"highlight","text":"should not be picked"}\n```\n' +
    "```json\nnot valid json\n```";

  // The last fence wins even when it fails to parse — extractActionBlock does
  // not fall back to an earlier fence, matching the single-fence behavior
  // (a malformed block means "no action", not "try the next one").
  assert.equal(extractActionBlock(content), null);
});

// Regression test for the sandbox missing the Event constructor: sendMessage()
// calls restoreDraft() on a failed send, which does
// userInput.dispatchEvent(new Event("input")) when the draft is restored.
// Before the fix, `Event` wasn't in the vm sandbox, so restoreDraft() threw
// "ReferenceError: Event is not defined" right after re-populating
// userInput.value — so asserting on the restored value alone doesn't catch
// the regression (it's set before the throw). The throw is caught by
// sendMessage()'s own try/catch, which calls restoreDraft() a second time —
// by then userInput.value is non-empty, so the guard skips the dispatchEvent
// line and the second call doesn't throw either, and the promise resolves
// either way. What differs is *which* error message ends up on screen: with
// the bug, the real "upstream failure" message is silently replaced by
// "Failed to communicate with background script: Event is not defined".
test("a failed send surfaces the upstream error, not an Event ReferenceError", async () => {
  const sandbox = loadSidepanel({
    sendMessage: async (msg) =>
      msg.type === "SEND_CHAT_MESSAGE"
        ? { error: "upstream failure" }
        : { isAuthenticated: false },
  });

  const userInput = sandbox.__elements.get("user-input");
  const chatContainer = sandbox.__elements.get("chat-container");
  userInput.value = "hello there";

  await sandbox.sendMessage();

  const messages = chatContainer.appended.map((div) => div.textContent);
  assert.ok(
    messages.some((text) => text.includes("upstream failure")),
    `expected an "upstream failure" message, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    !messages.some((text) => text.includes("Event is not defined")),
    `restoreDraft's dispatchEvent threw instead of completing: ${JSON.stringify(messages)}`,
  );
  assert.equal(userInput.value, "hello there");
});

// Regression test for the Apply/Cancel race: clicking Apply starts an async
// APPLY_HIGHLIGHT round trip; clicking Cancel before it resolves must leave
// the "Cancelled" label in place. Before the fix, renderActionResult()
// unconditionally overwrote label.textContent once the in-flight response
// arrived, clobbering "Cancelled" with a success/error message.
test("Cancel wins a race against an Apply response that resolves after it", async () => {
  // A deferred APPLY_HIGHLIGHT response the test can resolve on demand, so
  // Cancel can be clicked while it's still pending.
  let resolveApply;
  const applyResponse = new Promise((resolve) => {
    resolveApply = resolve;
  });

  const sandbox = loadSidepanel({
    sendMessage: async (msg) => {
      if (msg.type === "APPLY_HIGHLIGHT") return applyResponse;
      return { isAuthenticated: false };
    },
  });

  const chatContainer = sandbox.__elements.get("chat-container");
  sandbox.appendActionCard({ text: "foo", color: "yellow" });

  const card = chatContainer.appended[0];
  const label = card.appended[0];
  const buttons = card.appended[1];
  const applyBtn = buttons.appended[0];
  const cancelBtn = buttons.appended[1];

  // Click Apply: kicks off the (still-pending) sendMessage call.
  const applyClick = applyBtn.listeners.click();
  // Click Cancel before the response arrives.
  cancelBtn.listeners.click();
  assert.equal(label.textContent, 'Cancelled: "foo"');

  // Now let the in-flight Apply response resolve.
  resolveApply({ count: 3 });
  await applyClick;

  assert.equal(
    label.textContent,
    'Cancelled: "foo"',
    "the in-flight Apply response must not overwrite the Cancelled label",
  );
});
