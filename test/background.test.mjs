import test from "node:test";
import assert from "node:assert/strict";
import {
  loadBackground,
  runInPage,
  makeDocument,
  el,
  makeMutablePage,
  elementNode,
  textNode,
} from "./helpers.mjs";

const TOKEN_PLAN_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const PAYG_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const PLAN_KEY = "sk-sp-fake-token-plan-key";
const PAYG_KEY = "sk-fake-pay-as-you-go-key";

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const chat = (bg) =>
  bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });

// Builds an inject stub that runs the real injected function against a stubbed
// page, so tests exercise the shipped code rather than a paraphrase of it.
function pageInjector({
  document,
  selection = "",
  href = "https://example.com/",
  title = "Example",
}) {
  return ({ func }) => [
    {
      frameId: 0,
      result: runInPage(func, {
        document: Object.assign(Object.create(document || {}), { title }),
        location: { href },
        window: { getSelection: () => ({ toString: () => selection }) },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Configuration defaults and status
// ---------------------------------------------------------------------------

test("an unconfigured extension reports no key and sane defaults", async () => {
  const bg = loadBackground({});
  const status = await bg.send({ type: "GET_AUTH_STATUS" });

  assert.equal(status.isAuthenticated, false);
  assert.equal(status.baseUrl, TOKEN_PLAN_URL);
  assert.equal(status.model, "qwen3.6-flash");
  assert.ok(status.models.includes("qwen3.6-flash"));
  assert.equal(status.keyHint, "");
});

test("qwen3.5-flash is not offered — it is not on the Token Plan allowlist", async () => {
  const bg = loadBackground({});
  const status = await bg.send({ type: "GET_AUTH_STATUS" });
  assert.ok(!status.models.includes("qwen3.5-flash"), status.models.join(","));
});

test("status never returns the API key itself", async () => {
  const bg = loadBackground({ local: { apiKey: PLAN_KEY } });
  const status = await bg.send({ type: "GET_AUTH_STATUS" });

  assert.equal(status.isAuthenticated, true);
  assert.ok(!JSON.stringify(status).includes(PLAN_KEY), JSON.stringify(status));
  assert.match(status.keyHint, /…/);
});

// ---------------------------------------------------------------------------
// Key/host pairing — mixing billing modes silently bills pay-as-you-go, so the
// write is refused rather than stored.
// ---------------------------------------------------------------------------

test("a Token Plan key with the Token Plan URL is accepted", async () => {
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: { apiKey: PLAN_KEY, baseUrl: TOKEN_PLAN_URL, model: "qwen3.6-flash" },
  });

  assert.equal(res.status, "success");
  assert.equal(bg.local.apiKey, PLAN_KEY);
});

test("a Token Plan key with a pay-as-you-go URL is refused", async () => {
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: { apiKey: PLAN_KEY, baseUrl: PAYG_URL, model: "qwen3.6-flash" },
  });

  assert.match(res.error, /must be paired with the Token Plan endpoint/);
  assert.equal(bg.local.apiKey, undefined, "must not store a mispaired config");
});

test("a pay-as-you-go key with the Token Plan URL is refused", async () => {
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: { apiKey: PAYG_KEY, baseUrl: TOKEN_PLAN_URL, model: "qwen3.6-flash" },
  });

  assert.match(res.error, /requires a Token Plan key/);
  assert.equal(bg.local.apiKey, undefined);
});

// The previous origin check in this codebase was a string prefix, and it
// admitted lookalike hosts. The pairing guard must not repeat that: it is the
// only thing standing between an sk-sp- key and an arbitrary destination.
const HOST_BYPASS_VECTORS = [
  "https://token-plan.evil.com/compatible-mode/v1",
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com.evil.com/v1",
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com@evil.com/v1",
  "https://token-plan.ap-southeast-1.maas.aliyuncs.evil.com/v1",
  "http://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
];

for (const baseUrl of HOST_BYPASS_VECTORS) {
  test(`SAVE_CONFIG refuses a Token Plan key bound to ${baseUrl}`, async () => {
    const bg = loadBackground({});
    const res = await bg.send({
      type: "SAVE_CONFIG",
      config: { apiKey: PLAN_KEY, baseUrl, model: "qwen3.6-flash" },
    });

    assert.ok(res.error, `must refuse ${baseUrl}`);
    assert.equal(bg.local.apiKey, undefined, `must not store ${baseUrl}`);
  });

  test(`SEND refuses to ship the key to ${baseUrl}`, async () => {
    let called = false;
    const bg = loadBackground({
      local: { apiKey: PLAN_KEY, baseUrl, model: "qwen3.6-flash" },
      fetch: async () => {
        called = true;
        return okResponse("should never happen");
      },
    });

    const res = await chat(bg);
    assert.equal(called, false, `must not send to ${baseUrl}`);
    assert.ok(res.error);
  });
}

test("a non-https base URL is refused even with a pay-as-you-go key", async () => {
  // The pairing check exempts pay-as-you-go, so the scheme check is what stops
  // a bearer token going out in cleartext.
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: {
      apiKey: PAYG_KEY,
      baseUrl: "http://attacker.example/v1",
      model: "qwen3.6-flash",
    },
  });

  assert.match(res.error, /https/i);
  assert.equal(bg.local.apiKey, undefined);
});

test("an unparseable base URL is refused", async () => {
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: { apiKey: PLAN_KEY, baseUrl: "not a url", model: "qwen3.6-flash" },
  });
  assert.match(res.error, /valid absolute URL/);
});

test("an unknown model is refused rather than stored", async () => {
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: {
      apiKey: PLAN_KEY,
      baseUrl: TOKEN_PLAN_URL,
      model: "qwen3.5-flash",
    },
  });

  assert.match(res.error, /Unknown model/);
  assert.equal(bg.local.model, undefined);
});

test("a null apiKey clears the stored key", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY, baseUrl: TOKEN_PLAN_URL, model: "qwen3.6-flash" },
  });

  const res = await bg.send({ type: "SAVE_CONFIG", config: { apiKey: null } });
  assert.equal(res.status, "success");
  assert.equal(bg.local.apiKey, "");

  const status = await bg.send({ type: "GET_AUTH_STATUS" });
  assert.equal(status.isAuthenticated, false);
});

test("clearing the key works even when stored config is stale or invalid", async () => {
  // saveConfig must judge the patch, not the merged result: a model or base URL
  // left behind by an older version must not be able to veto revoking a key.
  const bg = loadBackground({
    local: {
      apiKey: PLAN_KEY,
      baseUrl: "http://legacy.example/v1",
      model: "qwen3.5-flash",
    },
  });

  const res = await bg.send({ type: "SAVE_CONFIG", config: { apiKey: null } });

  assert.ok(!res.error, `clear must not be blocked: ${res.error}`);
  assert.equal(bg.local.apiKey, "", "the key must actually be removed");
});

test("the send path re-checks the base URL, not just the save path", async () => {
  // Storage could hold a value written by an older version of this extension,
  // so the guard has to exist on both sides — and be covered on both sides.
  let called = false;
  const bg = loadBackground({
    local: {
      apiKey: PAYG_KEY,
      baseUrl: "http://attacker.example/v1",
      model: "qwen3.6-flash",
    },
    fetch: async () => {
      called = true;
      return okResponse("should never happen");
    },
  });

  const res = await chat(bg);
  assert.equal(called, false, "must not send a bearer token over cleartext");
  assert.match(res.error, /https/i);
  assert.equal(res.needsConfig, true);
});

test("a non-string key in storage does not break the status call", async () => {
  // Anything able to write this extension's storage area could put a number
  // here; an uncoerced .slice() would reject and wedge the panel on "Checking".
  const bg = loadBackground({ local: { apiKey: 12345 } });
  const status = await bg.send({ type: "GET_AUTH_STATUS" });
  assert.equal(status.isAuthenticated, true);
  assert.equal(typeof status.keyHint, "string");
});

test("a mispaired config already in storage is surfaced by status", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY, baseUrl: PAYG_URL, model: "qwen3.6-flash" },
  });
  const status = await bg.send({ type: "GET_AUTH_STATUS" });
  assert.match(status.pairingError, /Token Plan/);
});

test("a mispaired config refuses to send rather than billing the wrong channel", async () => {
  let called = false;
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY, baseUrl: PAYG_URL, model: "qwen3.6-flash" },
    fetch: async () => {
      called = true;
      return okResponse("should never happen");
    },
  });

  const res = await chat(bg);
  assert.equal(called, false, "must not issue the request");
  assert.equal(res.needsConfig, true);
  assert.match(res.error, /Token Plan/);
});

// ---------------------------------------------------------------------------
// Saving individual fields
// ---------------------------------------------------------------------------

test("saving the model alone does not clear a stored key", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY, baseUrl: TOKEN_PLAN_URL, model: "qwen3.6-flash" },
  });

  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: { model: "qwen3.7-plus", baseUrl: TOKEN_PLAN_URL },
  });

  assert.equal(res.status, "success");
  assert.equal(bg.local.apiKey, PLAN_KEY);
  assert.equal(bg.local.model, "qwen3.7-plus");
});

test("an empty model is refused", async () => {
  const bg = loadBackground({});
  const res = await bg.send({
    type: "SAVE_CONFIG",
    config: { model: "   ", baseUrl: TOKEN_PLAN_URL },
  });
  assert.match(res.error, /Model cannot be empty/);
});

test("a trailing slash on the base URL does not produce a double slash", async () => {
  let seenUrl = null;
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY, baseUrl: TOKEN_PLAN_URL + "///" },
    fetch: async (url) => {
      seenUrl = url;
      return okResponse("ok");
    },
  });

  await chat(bg);
  assert.equal(seenUrl, `${TOKEN_PLAN_URL}/chat/completions`);
});

// ---------------------------------------------------------------------------
// Chat request shape
// ---------------------------------------------------------------------------

test("the request carries the configured model, key and abort signal", async () => {
  let seen = null;
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY, baseUrl: TOKEN_PLAN_URL, model: "qwen3.7-max" },
    fetch: async (url, init) => {
      seen = { url, init };
      return okResponse("hello there");
    },
  });

  const res = await chat(bg);

  assert.equal(res.content, "hello there");
  assert.equal(seen.url, `${TOKEN_PLAN_URL}/chat/completions`);
  assert.equal(seen.init.headers.Authorization, `Bearer ${PLAN_KEY}`);
  assert.equal(JSON.parse(seen.init.body).model, "qwen3.7-max");
  // Without a timeout, a hung endpoint wedges the panel on "Thinking..."
  assert.ok(seen.init.signal, "chat fetch must pass an abort signal");
  assert.equal(typeof seen.init.signal.aborted, "boolean");
});

test("SEND_CHAT_MESSAGE without a key asks for configuration", async () => {
  const bg = loadBackground({ fetch: async () => okResponse("x") });
  const res = await chat(bg);

  assert.equal(res.needsConfig, true);
  assert.match(res.error, /No API key configured/);
});

test("SEND_CHAT_MESSAGE rejects an empty conversation", async () => {
  const bg = loadBackground({ local: { apiKey: PLAN_KEY } });
  assert.match(
    (await bg.send({ type: "SEND_CHAT_MESSAGE" })).error,
    /No messages/,
  );
  assert.match(
    (await bg.send({ type: "SEND_CHAT_MESSAGE", messages: [] })).error,
    /No messages/,
  );
});

for (const status of [401, 403]) {
  test(`a ${status} asks the user to fix their key`, async () => {
    const bg = loadBackground({
      local: { apiKey: PLAN_KEY },
      fetch: async () => ({ ok: false, status, text: async () => "denied" }),
    });

    const res = await chat(bg);
    assert.equal(res.needsConfig, true);
    assert.match(res.error, /API key rejected/);
  });
}

test("a 429 explains the Token Plan quota window", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY },
    fetch: async () => ({ ok: false, status: 429, text: async () => "slow down" }),
  });

  const res = await chat(bg);
  assert.match(res.error, /quota/i);
  assert.ok(!res.needsConfig, "a quota pause is not a configuration problem");
});

test("an echoed key is redacted from error text, prefixed or bare", async () => {
  for (const body of [
    `rejected header Bearer ${PLAN_KEY} in request`,
    `{"error":"bad token","token":"${PLAN_KEY}"}`,
  ]) {
    const bg = loadBackground({
      local: { apiKey: PLAN_KEY },
      fetch: async () => ({ ok: false, status: 400, text: async () => body }),
    });

    const res = await chat(bg);
    assert.ok(!res.error.includes(PLAN_KEY), res.error);
    assert.match(res.error, /\[redacted\]/);
  }
});

test("a malformed API response is reported rather than rendered", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });

  const res = await chat(bg);
  assert.match(res.error, /Unexpected API response/);
});

test("a key echoed in a 200-OK body is redacted before reaching the transcript", async () => {
  // The !ok branch redacts, but a 200 with an unexpected shape takes a
  // different exit and the panel renders `details` into the chat.
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: `bad key ${PLAN_KEY}` } }),
    }),
  });

  const res = await chat(bg);
  const rendered = JSON.stringify(res);
  assert.ok(!rendered.includes(PLAN_KEY), rendered);
  assert.match(String(res.details), /\[redacted\]/);
});

// ---------------------------------------------------------------------------
// Page context — scheme allowlist
// ---------------------------------------------------------------------------

test("an http page is refused with a message that names the real reason", async () => {
  // Not "internal or extension page" — an intranet host over plain HTTP is
  // neither, and that wording sends the user after the wrong problem.
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "http://intranet.corp/wiki", title: "x" }],
    inject: () => {
      throw new Error("must not inject");
    },
  });

  const res = await bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
  assert.match(res.error, /https/);
  assert.ok(
    !/internal or extension/.test(res.error),
    `misleading message: ${res.error}`,
  );
});

const NON_INJECTABLE = [
  "chrome://settings",
  "edge://flags",
  "about:blank",
  "chrome-extension://abcdef/page.html",
  "devtools://devtools/bundled/panel.html",
  "view-source:https://example.com",
  "file:///etc/passwd",
  "data:text/html,<h1>hi</h1>",
  "blob:https://example.com/uuid",
  undefined,
];

for (const url of NON_INJECTABLE) {
  test(`GET_PAGE_CONTEXT refuses ${String(url)}`, async () => {
    const bg = loadBackground({
      tabs: [{ id: 1, windowId: 10, url, title: "t" }],
      inject: () => {
        throw new Error("must not inject");
      },
    });

    const res = await bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
    assert.match(res.error, /browser internal or extension pages/);
  });
}

test("GET_PAGE_CONTEXT allows https", async () => {
  const url = "https://example.com/a";
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url, title: "Example" }],
    inject: pageInjector({
      document: makeDocument(el("body", "", [el("p", "x".repeat(80))])),
      href: url,
      title: "Example",
    }),
  });

  const res = await bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
  assert.equal(res.type, "page");
  assert.equal(res.url, url);
});

test("provenance comes from the page, not the pre-injection tab snapshot", async () => {
  // The tab reports the URL it had when queried; the page reports where it
  // actually is now. A tab that navigated in between must not get the old
  // page's label attached to the new page's text.
  const bg = loadBackground({
    tabs: [
      { id: 1, windowId: 10, url: "https://trusted.example/", title: "Trusted" },
    ],
    inject: pageInjector({
      document: makeDocument(el("body", "", [el("p", "n".repeat(80))])),
      href: "https://actually-here.example/page",
      title: "Actually Here",
    }),
  });

  const res = await bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
  assert.equal(res.url, "https://actually-here.example/page");
  assert.equal(res.title, "Actually Here");
});

test("GET_PAGE_CONTEXT targets the panel's own window", async () => {
  const bg = loadBackground({
    tabs: [
      { id: 1, windowId: 10, url: "https://example.com/", title: "Right" },
      { id: 2, windowId: 20, url: "https://other.com/", title: "Wrong window" },
    ],
    inject: pageInjector({
      document: makeDocument(el("body", "", [el("p", "y".repeat(80))])),
    }),
  });

  await bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
  assert.equal(bg.queries[0].active, true);
  assert.equal(bg.queries[0].windowId, 10);
  assert.equal(bg.queries[0].currentWindow, undefined);
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extract({ document, selection = "" }) {
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com/", title: "T" }],
    inject: pageInjector({ document, selection }),
  });
  return bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
}

test("a user selection wins over page content", async () => {
  const res = await extract({
    selection: "  the chosen sentence  ",
    document: makeDocument(el("body", "", [el("p", "ignored")])),
  });
  assert.equal(res.type, "selection");
  assert.equal(res.text, "the chosen sentence");
});

test("nested elements are not emitted twice", async () => {
  const document = makeDocument(
    el("body", "", [
      el("main", "", [
        el("p", "Alpha"),
        el("p", "Beta"),
        el("pre", "", [el("code", "gamma()")]),
      ]),
    ]),
  );

  const res = await extract({ document });
  const occurrences = (needle) => res.text.split(needle).length - 1;

  assert.equal(occurrences("Alpha"), 1, res.text);
  assert.equal(occurrences("Beta"), 1, res.text);
  assert.equal(occurrences("gamma()"), 1, res.text);
});

test("a listing page with many <article> cards keeps every card", async () => {
  // Each card's text must comfortably exceed the 50-char fallback threshold,
  // or the body fallback rescues a wrong root and hides the bug.
  const card = (n) =>
    el("article", "", [
      el("h2", `${n} post headline`),
      el(
        "p",
        `Body of the ${n} post, long enough that this card alone clears the ` +
          "fifty character fallback threshold on its own.",
      ),
    ]);

  const document = makeDocument(
    el("body", "", [card("First"), card("Second"), card("Third")]),
  );

  const res = await extract({ document });
  for (const needle of ["First post", "Second post", "Third post"]) {
    assert.ok(res.text.includes(needle), `${needle} missing from: ${res.text}`);
  }
});

test("a stray <article> widget does not hijack the root from <main>", async () => {
  const document = makeDocument(
    el("body", "", [
      el("article", "", [
        el(
          "p",
          "Promoted sidebar widget with enough filler text to clear the " +
            "fifty character fallback threshold by itself.",
        ),
      ]),
      el("main", "", [
        el("h1", "The actual headline"),
        el(
          "p",
          "The actual article body goes here and is also comfortably longer " +
            "than the fallback threshold.",
        ),
      ]),
    ]),
  );

  const res = await extract({ document });
  assert.ok(res.text.includes("The actual headline"), res.text);
  assert.ok(res.text.includes("The actual article body"), res.text);
});

test("a single <article> with no <main> is still used as the root", async () => {
  const document = makeDocument(
    el("body", "", [
      el("nav", "Home About Contact"),
      el("article", "", [el("p", "x".repeat(120))]),
    ]),
  );

  const res = await extract({ document });
  assert.ok(res.text.includes("x".repeat(120)));
});

test("falls back to body text when semantic markup is sparse", async () => {
  const body = el("body", "y".repeat(300), [el("p", "tiny")]);
  const res = await extract({ document: makeDocument(body) });
  assert.ok(res.text.includes("y".repeat(300)));
});

test("survives a document with no body (SVG/XML)", async () => {
  const res = await extract({ document: makeDocument(null) });
  assert.match(res.error, /No text found/);
});

test("truncates long content and long selections", async () => {
  const long = await extract({
    document: makeDocument(el("body", "", [el("p", "z".repeat(20000))])),
  });
  assert.ok(long.text.length < 4100, long.text.length);
  assert.match(long.text, /\[Content truncated for length\.\.\.\]$/);

  const sel = await extract({ selection: "s".repeat(20000) });
  assert.ok(sel.text.length < 4100);
  assert.match(sel.text, /\[Content truncated for length\.\.\.\]$/);
});

test("bounds work on a pathological document", async () => {
  const many = Array.from({ length: 40000 }, (_, i) => el("p", `para ${i}`));
  const started = process.hrtime.bigint();
  const res = await extract({ document: makeDocument(el("body", "", many)) });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(res.text.length < 4100);
  assert.ok(ms < 2000, `extraction took ${ms}ms`);
});

// ---------------------------------------------------------------------------
// Highlight action
// ---------------------------------------------------------------------------

// Builds an inject stub that runs the real highlight/clear functions against a
// mutable page stub, same "exercise the shipped code" posture as pageInjector.
function highlightInjector(bodyChildren) {
  const page = makeMutablePage(bodyChildren);
  return {
    inject: ({ func, args }) => [
      { frameId: 0, result: runInPage(func, page, args) },
    ],
    body: page.document.body,
  };
}

const NON_INJECTABLE_HIGHLIGHT_CASES = [
  ["APPLY_HIGHLIGHT", { text: "x", color: "yellow" }],
  ["CLEAR_HIGHLIGHTS", {}],
];

for (const [type, extra] of NON_INJECTABLE_HIGHLIGHT_CASES) {
  test(`${type} refuses a chrome:// tab`, async () => {
    const bg = loadBackground({
      tabs: [{ id: 1, windowId: 10, url: "chrome://settings" }],
      inject: () => {
        throw new Error("must not inject");
      },
    });

    const res = await bg.send({ type, windowId: 10, ...extra });
    assert.match(res.error, /browser internal or extension pages/);
  });

  test(`${type} refuses a plain-http tab`, async () => {
    const bg = loadBackground({
      tabs: [{ id: 1, windowId: 10, url: "http://example.com" }],
      inject: () => {
        throw new Error("must not inject");
      },
    });

    const res = await bg.send({ type, windowId: 10, ...extra });
    assert.match(res.error, /https/);
  });
}

test("an empty highlight text is rejected before injecting", async () => {
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject: () => {
      throw new Error("must not inject");
    },
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "   ",
    color: "yellow",
  });
  assert.match(res.error, /No text/);
});

test("an overlong highlight text is rejected before injecting", async () => {
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject: () => {
      throw new Error("must not inject");
    },
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "x".repeat(500),
    color: "yellow",
  });
  assert.match(res.error, /too long/);
});

test("a matching phrase is wrapped and the match count is returned", async () => {
  const { inject, body } = highlightInjector([
    elementNode("p", "the quick brown fox"),
  ]);
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject,
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "quick brown",
    color: "green",
  });
  assert.equal(res.count, 1);

  const marks = body.querySelectorAll("mark[data-qwen-hl]");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].textContent, "quick brown");
});

test("every occurrence within a single text node is highlighted, not just the first", async () => {
  const { inject, body } = highlightInjector([
    elementNode("p", "the quick fox and the quick hare raced the quick tortoise"),
  ]);
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject,
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "quick",
    color: "green",
  });
  assert.equal(res.count, 3);

  const marks = body.querySelectorAll("mark[data-qwen-hl]");
  assert.equal(marks.length, 3);
  for (const mark of marks) {
    assert.equal(mark.textContent, "quick");
  }
  // The non-matching text around each hit must survive intact and in order.
  assert.equal(
    body.textContent,
    "the quick fox and the quick hare raced the quick tortoise",
  );
});

test("within-node matches still respect the global maxMatches cap", async () => {
  const { inject, body } = highlightInjector([
    elementNode("p", "aa aa aa aa"),
  ]);
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject: ({ func, args }) => inject({ func, args: [args[0], args[1], 2] }),
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "aa",
    color: "green",
  });
  assert.equal(res.count, 2);
  assert.equal(body.querySelectorAll("mark[data-qwen-hl]").length, 2);
});

test("an unrecognized color name falls back to the default rather than erroring", async () => {
  const { inject, body } = highlightInjector([elementNode("p", "hello world")]);
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject,
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "hello",
    color: "not-a-real-color",
  });
  assert.equal(res.count, 1);

  const marks = body.querySelectorAll("mark[data-qwen-hl]");
  assert.equal(marks[0].style.backgroundColor, "#fff59d");
});

test("no match on the page is reported as an error, not a silent no-op", async () => {
  const { inject } = highlightInjector([elementNode("p", "hello world")]);
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject,
  });

  const res = await bg.send({
    type: "APPLY_HIGHLIGHT",
    windowId: 10,
    text: "not on the page",
    color: "yellow",
  });
  assert.match(res.error, /No match found/);
});

test("CLEAR_HIGHLIGHTS unwraps every mark this extension created", async () => {
  const mark = elementNode("mark", "quick brown");
  mark.setAttribute("data-qwen-hl", "1");
  const { inject, body } = highlightInjector([
    elementNode("p", "the "),
    mark,
    elementNode("p", " fox"),
  ]);
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com" }],
    inject,
  });

  const res = await bg.send({ type: "CLEAR_HIGHLIGHTS", windowId: 10 });
  assert.equal(res.count, 1);
  assert.equal(body.querySelectorAll("mark[data-qwen-hl]").length, 0);
});

// replaceChild on the mutable DOM stub itself (not routed through
// background.js): real DOM throws NotFoundError when oldNode isn't a child,
// rather than mutating anything. The stub must match that instead of
// silently corrupting `children` via a -1 index write.
test("replaceChild on the mutable DOM stub throws when oldNode is not a child", () => {
  const { document } = makeMutablePage([elementNode("p", "hello")]);
  const detached = elementNode("mark", "quick brown");
  const replacement = textNode("quick brown");

  const before = [...document.body.children];
  assert.throws(() => document.body.replaceChild(replacement, detached), {
    message: /not a child/,
  });

  // No corruption: children array unchanged, and neither node was linked in.
  assert.deepEqual(document.body.children, before);
  assert.equal(replacement.parentNode, null);
  assert.equal(detached.parentNode, null);
});

// ---------------------------------------------------------------------------
// Response plumbing
// ---------------------------------------------------------------------------

test("a rejected handler still produces exactly one response", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY },
    fetch: async () => {
      throw new Error("socket hang up");
    },
  });

  const res = await chat(bg);
  assert.match(res.error, /API error: socket hang up/);
  assert.equal(bg.replyCount, 1);
});

test("a non-Error rejection does not render as undefined", async () => {
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY },
    fetch: async () => {
      throw "plain string failure"; // eslint-disable-line no-throw-literal
    },
  });

  const res = await chat(bg);
  assert.ok(!res.error.includes("undefined"), res.error);
  assert.match(res.error, /plain string failure/);
});

test("a closed port does not trigger a second response", async (t) => {
  // Chrome's sendResponse throws once the side panel is gone. If that throw
  // escapes the resolve arm it lands in .catch, which replies again — so the
  // failure mode this guards is a double send, not a crash.
  const bg = loadBackground({
    local: { apiKey: PLAN_KEY },
    fetch: async () => okResponse("hi"),
  });

  let calls = 0;
  const throwingResponse = () => {
    calls += 1;
    throw new Error("Attempting to use a disconnected port object");
  };

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  bg.listener(
    { type: "SEND_CHAT_MESSAGE", messages: [{ role: "user", content: "hi" }] },
    { id: "test-extension-id" },
    throwingResponse,
  );

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1, "sendResponse must be attempted exactly once");
  assert.deepEqual(
    rejections,
    [],
    "the throw must not become an unhandled rejection",
  );
});

test("unknown message types are not answered", async () => {
  const bg = loadBackground({});
  assert.equal(await bg.send({ type: "NOT_A_REAL_TYPE" }), undefined);
});

test("messages from other extensions are ignored", async () => {
  const bg = loadBackground({ local: { apiKey: PLAN_KEY } });
  const res = await bg.send(
    { type: "GET_AUTH_STATUS" },
    { id: "some-other-ext" },
  );
  assert.equal(res, undefined);
});
