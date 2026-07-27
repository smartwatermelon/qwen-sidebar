# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Run all tests: `npm test` (runs `node --test "test/*.test.mjs"`)
- Run a single test file: `node --test test/background.test.mjs`
- Run a single test case: `node --test --test-name-pattern="a Token Plan key" test/background.test.mjs`

There is no build step, bundler, or linter configured — this is plain MV3 JavaScript loaded directly by Chrome.

To manually load the extension: `chrome://extensions` → enable Developer Mode → "Load unpacked" → select this directory.

## Architecture

This is a Chrome MV3 side-panel extension with exactly three source files:

- `manifest.json` — MV3 manifest. `sidePanel`, `storage`, `scripting` permissions; `host_permissions: https://*/*` for content-script injection only (no network calls are made cross-origin outside the configured API base URL).
- `background.js` — the service worker. Owns all state and all external I/O: config storage, page-content extraction, and the chat API call. The side panel never touches `chrome.storage` or `fetch` directly — everything goes through `chrome.runtime.sendMessage` to this file's `onMessage` listener (message types: `GET_AUTH_STATUS`, `SAVE_CONFIG`, `GET_PAGE_CONTEXT`, `SEND_CHAT_MESSAGE`).
- `sidepanel.html` / `sidepanel.js` — the UI. No framework, no build step; vanilla DOM manipulation.

### background.js internals

- **Config model**: `apiKey`, `baseUrl`, `model`, stored in `chrome.storage.local` (never `.sync` — the key must not leave the machine). The panel is never given the raw key back; `getStatus()` only returns a `keyHint` (last 4 chars).
- **Token Plan vs. pay-as-you-go billing modes**: Alibaba Model Studio has two incompatible billing channels. A Token Plan key (prefix `sk-sp-`) must be paired with the Token Plan base URL (`token-plan.<region>.maas.aliyuncs.com`); mixing them either silently bills the wrong channel or 401s. `checkKeyHostPairing()` enforces this pairing on **both** the save path (`saveConfig`) and the send path (`sendChatMessage`) — storage can hold a stale/legacy value from before this check existed, so the send path re-validates independently rather than trusting what was validated at save time.
- **Host matching is exact-domain regex, not string prefix** — `TOKEN_PLAN_HOST` guards against lookalike hosts (`token-plan.evil.com`, `token-plan.<real-host>.evil.com`, userinfo tricks). See the bypass-vector test list in `test/background.test.mjs` before touching this.
- **`saveConfig` validates only the fields present in the patch**, not the merged/inherited result — this is why clearing the key (`apiKey: null`) always succeeds even if `baseUrl`/`model` already in storage are stale or invalid. Don't "fix" this by validating the merged config.
- **Secret redaction**: `redactSecret()` is applied to *every* exit path that can carry an upstream response body (error bodies, and also a 200 OK with an unexpected JSON shape) — not just the `!res.ok` branch.
- **Page context extraction** (`extractPageContent`, injected via `chrome.scripting.executeScript`): must stay fully self-contained (no closures over outer scope) since it's serialized into the page. Precedence: user selection → `<main>` (or a single `<article>`, but never one of several) → whole-page block elements → `document.body.innerText` fallback if semantic markup is too sparse (<50 chars). Only `https:` pages are injectable (`INJECTABLE_PROTOCOLS`); `http:` gets a distinct error message from `chrome://`/`file://`/etc. so users aren't misdirected.
- **Provenance** (`url`/`title` of extracted content) is read from *inside* the injected page function, not from the pre-injection `chrome.tabs.query` snapshot — a tab that navigates in between must not mislabel new content with the old page's URL.
- **Multi-window correctness**: the service worker has no window of its own, so `chrome.tabs.query({currentWindow: true})` resolves to whichever window was last focused. The side panel always passes its own `windowId` explicitly (via `chrome.windows.getCurrent()`) to avoid reading the wrong window's active tab.
- **`respondAsync`** ensures every `onMessage` handler calls `sendResponse` exactly once, including on rejection, and swallows the case where the port is already closed (side panel closed mid-request) without generating a second response attempt.

### Testing approach (`test/helpers.mjs`)

`background.js` is a classic (non-module) script, so tests load it into a `vm` context with a stubbed `chrome` global and capture the registered `onMessage` listener to drive it directly — there's no framework/DOM available. Injected page functions (like `extractPageContent`) are re-materialized from their *source text* via `vm.runInNewContext` rather than called in-process, which mirrors what `chrome.scripting.executeScript` actually does (serialize-and-run) and would catch a function that accidentally started closing over module scope.

When adding background.js behavior that touches config validation, billing-mode pairing, or page-injection scheme checks, add corresponding cases to the bypass-vector / non-injectable-protocol tables in `test/background.test.mjs` rather than one-off tests — those are deliberately data-driven.
