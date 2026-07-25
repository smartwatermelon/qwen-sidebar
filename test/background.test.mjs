import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, runInPage, makeDocument, el } from "./helpers.mjs";

const QWEN = "https://chat.qwen.ai";

// Builds an inject stub that runs the real injected function against a stubbed
// page, so tests exercise the shipped code rather than a paraphrase of it.
function pageInjector({ origin, storage = {}, document, selection = "" }) {
  return ({ func }) => [
    {
      frameId: 0,
      result: runInPage(func, {
        location: { origin },
        localStorage: { getItem: (k) => storage[k] ?? null },
        document,
        window: { getSelection: () => ({ toString: () => selection }) },
      }),
    },
  ];
}

const qwenTab = { id: 1, windowId: 10, url: `${QWEN}/c/abc`, title: "Qwen" };

// ---------------------------------------------------------------------------
// Origin gate — this table is the reason this file exists. The check was once
// `startsWith("https://chat.qwen.ai")`, which admitted every "reject" row below.
// ---------------------------------------------------------------------------

const ORIGIN_VECTORS = [
  { url: `${QWEN}/`, accept: true },
  { url: `${QWEN}/c/abc?x=1#y`, accept: true },
  { url: "https://CHAT.QWEN.AI/", accept: true }, // DNS is case-insensitive
  { url: "https://chat.qwen.ai.evil.com/", accept: false },
  { url: "https://chat.qwen.aiXYZ.com/", accept: false },
  { url: "https://chat.qwen.ai@evil.com/", accept: false }, // userinfo, origin is evil.com
  { url: "https://evil.com/#https://chat.qwen.ai", accept: false },
  { url: "https://chat.qwen.ai:8443/", accept: false }, // port is part of origin
  { url: "http://chat.qwen.ai/", accept: false }, // scheme is part of origin
  { url: "https://chat.qwen.ai.", accept: false }, // trailing-dot FQDN
  { url: "not a url", accept: false },
  { url: undefined, accept: false }, // no host permission for this tab
];

for (const { url, accept } of ORIGIN_VECTORS) {
  test(`REFRESH_AUTH ${accept ? "accepts" : "rejects"} ${String(url)}`, async () => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = "null";
    }

    const bg = loadBackground({
      tabs: [{ ...qwenTab, url }],
      inject: pageInjector({ origin, storage: { token: "tok-abc" } }),
    });

    const res = await bg.send({ type: "REFRESH_AUTH", windowId: 10 });

    if (accept) {
      assert.equal(res.status, "success", `expected accept for ${url}`);
      assert.equal(bg.session.qwenToken, "tok-abc");
    } else {
      // Assert the specific outer-gate message, not merely that *some* error
      // came back. The in-page origin re-check would otherwise absorb every
      // vector and report "No auth token found", leaving this table unable to
      // observe the layer it exists to pin.
      assert.match(
        res.error,
        /Please switch to the/,
        `outer origin gate must reject ${url}`,
      );
      assert.equal(
        bg.session.qwenToken,
        undefined,
        `token must not be stored for ${url}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// TOCTOU: tab.url passes the pre-injection check, but the tab navigated before
// the script ran. The in-page origin re-check is the only thing that catches it.
// ---------------------------------------------------------------------------

test("REFRESH_AUTH does not store a token if the tab navigates after the check", async () => {
  const bg = loadBackground({
    tabs: [qwenTab], // URL still reads as chat.qwen.ai at query time
    inject: pageInjector({
      origin: "https://evil.com", // ...but the page is now something else
      storage: { token: "attacker-planted-token" },
    }),
  });

  const res = await bg.send({ type: "REFRESH_AUTH", windowId: 10 });

  assert.ok(res.error);
  assert.equal(bg.session.qwenToken, undefined);
});

test("REFRESH_AUTH reports a missing token distinctly from a bad origin", async () => {
  const bg = loadBackground({
    tabs: [qwenTab],
    inject: pageInjector({ origin: QWEN, storage: {} }),
  });

  const res = await bg.send({ type: "REFRESH_AUTH", windowId: 10 });
  assert.match(res.error, /No auth token found/);
});

test("REFRESH_AUTH falls back to access_token", async () => {
  const bg = loadBackground({
    tabs: [qwenTab],
    inject: pageInjector({ origin: QWEN, storage: { access_token: "alt" } }),
  });

  await bg.send({ type: "REFRESH_AUTH", windowId: 10 });
  assert.equal(bg.session.qwenToken, "alt");
});

test("REFRESH_AUTH targets the panel's own window", async () => {
  const bg = loadBackground({
    tabs: [
      { id: 1, windowId: 10, url: `${QWEN}/`, title: "Qwen" },
      { id: 2, windowId: 20, url: "https://evil.com/", title: "Other window" },
    ],
    inject: pageInjector({ origin: QWEN, storage: { token: "tok" } }),
  });

  await bg.send({ type: "REFRESH_AUTH", windowId: 10 });
  // Compared field-by-field rather than with deepStrictEqual: objects created
  // inside the vm context have that realm's Object.prototype, so a strict deep
  // comparison against a host-realm literal fails on the prototype alone.
  assert.equal(bg.queries[0].active, true);
  assert.equal(bg.queries[0].windowId, 10);
  assert.equal(bg.queries[0].currentWindow, undefined);
});

// ---------------------------------------------------------------------------
// Scheme allowlist
// ---------------------------------------------------------------------------

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

test("GET_PAGE_CONTEXT allows http and https", async () => {
  for (const url of ["https://example.com/a", "http://example.com/a"]) {
    const bg = loadBackground({
      tabs: [{ id: 1, windowId: 10, url, title: "Example" }],
      inject: pageInjector({
        origin: new URL(url).origin,
        document: makeDocument(el("body", "", [el("p", "x".repeat(80))])),
      }),
    });

    const res = await bg.send({ type: "GET_PAGE_CONTEXT", windowId: 10 });
    assert.equal(res.type, "page", url);
    assert.equal(res.url, url);
  }
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extract({ document, selection = "" }) {
  const bg = loadBackground({
    tabs: [{ id: 1, windowId: 10, url: "https://example.com/", title: "T" }],
    inject: pageInjector({
      origin: "https://example.com",
      document,
      selection,
    }),
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
  // <main> wrapping paragraphs is the common case that previously produced the
  // whole page followed by each paragraph again.
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
  // One <article> per card is the normal shape for a blog index, forum, or
  // search results page. Rooting at the first one would drop the rest.
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
  // A "related posts" or promo widget preceding <main> must not become the root
  // and swallow the real content.
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
// Chat + response plumbing
// ---------------------------------------------------------------------------

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

test("SEND_CHAT_MESSAGE returns assistant content", async () => {
  const bg = loadBackground({
    session: { qwenToken: "tok" },
    fetch: async () => okResponse("hello there"),
  });

  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.content, "hello there");
});

test("the chat request carries an abort signal", async () => {
  // Without a timeout, a proxy that accepts the connection and then hangs
  // leaves the panel stuck on "Thinking..." forever.
  let seen = null;
  const bg = loadBackground({
    session: { qwenToken: "tok" },
    fetch: async (_url, init) => {
      seen = init;
      return okResponse("ok");
    },
  });

  await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.ok(seen, "fetch was not called");
  assert.ok(seen.signal, "chat fetch must pass an abort signal");
  assert.equal(typeof seen.signal.aborted, "boolean");
});

test("SEND_CHAT_MESSAGE requires a stored token", async () => {
  const bg = loadBackground({ fetch: async () => okResponse("x") });
  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(res.error, /Not authenticated/);
});

test("a 401 clears the stored token and flags expiry", async () => {
  const bg = loadBackground({
    session: { qwenToken: "stale" },
    fetch: async () => ({ ok: false, status: 401, text: async () => "nope" }),
  });

  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(res.authExpired, true);
  assert.equal(bg.session.qwenToken, undefined);
});

test("an echoed bearer token is redacted from error text", async () => {
  const bg = loadBackground({
    session: { qwenToken: "super-secret-token" },
    fetch: async () => ({
      ok: false,
      status: 400,
      text: async () => "rejected header Bearer super-secret-token in request",
    }),
  });

  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.ok(!res.error.includes("super-secret-token"), res.error);
  assert.match(res.error, /Bearer \[redacted\]/);
});

test("a bare echoed token is redacted even without a Bearer prefix", async () => {
  // The prefix pattern alone misses a body that echoes the credential on its
  // own, which is the more likely shape for a JSON error payload.
  const bg = loadBackground({
    session: { qwenToken: "fake-token-value-for-test" },
    fetch: async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad token","token":"fake-token-value-for-test"}',
    }),
  });

  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.ok(!res.error.includes("fake-token-value-for-test"), res.error);
  assert.match(res.error, /\[redacted\]/);
});

test("SEND_CHAT_MESSAGE rejects an empty conversation", async () => {
  const bg = loadBackground({ session: { qwenToken: "tok" } });
  assert.match((await bg.send({ type: "SEND_CHAT_MESSAGE" })).error, /No messages/);
  assert.match(
    (await bg.send({ type: "SEND_CHAT_MESSAGE", messages: [] })).error,
    /No messages/,
  );
});

test("a rejected handler still produces exactly one response", async () => {
  const bg = loadBackground({
    session: { qwenToken: "tok" },
    fetch: async () => {
      throw new Error("socket hang up");
    },
  });

  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(res.error, /API error: socket hang up/);
});

test("a non-Error rejection does not render as undefined", async () => {
  const bg = loadBackground({
    session: { qwenToken: "tok" },
    fetch: async () => {
      throw "plain string failure"; // eslint-disable-line no-throw-literal
    },
  });

  const res = await bg.send({
    type: "SEND_CHAT_MESSAGE",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(!res.error.includes("undefined"), res.error);
  assert.match(res.error, /plain string failure/);
});

test("a closed port does not trigger a second response", async (t) => {
  // Chrome's sendResponse throws once the side panel is gone. If that throw
  // escapes the resolve arm it lands in .catch, which replies again — so the
  // failure mode this guards is a double send, not a crash.
  const bg = loadBackground({
    session: { qwenToken: "tok" },
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
  assert.deepEqual(rejections, [], "the throw must not become an unhandled rejection");
});

test("unknown message types are not answered", async () => {
  const bg = loadBackground({});
  assert.equal(await bg.send({ type: "NOT_A_REAL_TYPE" }), undefined);
});

test("messages from other extensions are ignored", async () => {
  const bg = loadBackground({ session: { qwenToken: "tok" } });
  const res = await bg.send({ type: "GET_AUTH_STATUS" }, { id: "some-other-ext" });
  assert.equal(res, undefined);
});

test("GET_AUTH_STATUS reflects stored state", async () => {
  const withToken = loadBackground({ session: { qwenToken: "tok" } });
  const yes = await withToken.send({ type: "GET_AUTH_STATUS" });
  assert.equal(yes.isAuthenticated, true);

  const without = loadBackground({});
  const no = await without.send({ type: "GET_AUTH_STATUS" });
  assert.equal(no.isAuthenticated, false);
});


test("AUTH_TOKEN refuses blank tokens", async () => {
  const bg = loadBackground({});
  assert.equal((await bg.send({ type: "AUTH_TOKEN", token: "   " })).status, "error");
  assert.equal(bg.session.qwenToken, undefined);

  assert.equal(
    (await bg.send({ type: "AUTH_TOKEN", token: "real" })).status,
    "success",
  );
  assert.equal(bg.session.qwenToken, "real");
});
