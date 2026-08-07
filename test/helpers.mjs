// Test harness for background.js.
//
// background.js is a classic (non-module) service worker script, so it is loaded
// into a vm context with a stubbed `chrome` global and its registered
// onMessage listener is captured for driving.
//
// Injected functions are deliberately re-created from their source text via
// vm.runInNewContext rather than called directly. That mirrors what
// chrome.scripting.executeScript actually does — it serializes the function —
// so these tests also fail if an injected function ever starts closing over
// module scope, which would break at runtime in a way unit-calling it would hide.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND = path.join(HERE, "..", "background.js");
const SIDEPANEL = path.join(HERE, "..", "sidepanel.js");

// --- DOM stubs ---------------------------------------------------------------

export function el(tag, text = "", children = []) {
  const node = { tag, _text: text, children, _parent: null };
  for (const child of children) child._parent = node;
  return node;
}

function innerTextOf(node) {
  if (!node.children.length) return node._text || "";
  const parts = node.children.map(innerTextOf).filter(Boolean);
  return node._text ? [node._text, ...parts].join("\n") : parts.join("\n");
}

function descendantsOf(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    descendantsOf(child, out);
  }
  return out;
}

function isAncestor(ancestor, node) {
  for (let cur = node; cur; cur = cur._parent) {
    if (cur === ancestor) return true;
  }
  return false;
}

const tagsOf = (selector) =>
  new Set(selector.split(",").map((part) => part.trim()));

export function makeDocument(bodyNode) {
  const wrappers = new Map();

  const wrap = (node) => {
    if (!node) return null;
    if (!wrappers.has(node)) {
      wrappers.set(node, {
        __node: node,
        get innerText() {
          return innerTextOf(node);
        },
        contains(other) {
          return !!other && isAncestor(node, other.__node);
        },
        querySelectorAll(selector) {
          const tags = tagsOf(selector);
          return descendantsOf(node)
            .filter((n) => tags.has(n.tag))
            .map(wrap);
        },
      });
    }
    return wrappers.get(node);
  };

  return {
    querySelector(selector) {
      if (!bodyNode) return null;
      const tags = tagsOf(selector);
      const found = descendantsOf(bodyNode).find((n) => tags.has(n.tag));
      return found ? wrap(found) : null;
    },
    querySelectorAll(selector) {
      if (!bodyNode) return [];
      const tags = tagsOf(selector);
      return descendantsOf(bodyNode)
        .filter((n) => tags.has(n.tag))
        .map(wrap);
    },
    get body() {
      return wrap(bodyNode);
    },
  };
}

// --- Injection ---------------------------------------------------------------

// Re-materializes `func` from its source in a fresh realm holding only the page
// globals, then calls it. A ReferenceError here means the function was not
// self-contained and would fail once serialized into a real page.
export function runInPage(func, pageGlobals, args = []) {
  const fn = vm.runInNewContext(`(${func.toString()})`, { ...pageGlobals });
  return fn(...args);
}

// --- Mutable DOM stub (highlight/clear injected functions) -------------------
//
// The read-only `el`/`makeDocument` stub above suffices for extraction, which
// only reads text. Highlighting mutates the tree (splits text nodes, inserts
// <mark> elements, unwraps them later), so it needs createElement/
// createTextNode/insertBefore/removeChild/replaceChild/normalize and a
// TreeWalker — a different, small stub rather than bolting mutation onto the
// read-only one.

function makeTextNode(value) {
  return {
    nodeType: 3,
    nodeValue: value,
    parentNode: null,
    get parentElement() {
      return this.parentNode;
    },
  };
}

function makeMutableElement(tag) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    style: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    get textContent() {
      return this.children
        .map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent))
        .join("");
    },
    set textContent(value) {
      const node = makeTextNode(value);
      node.parentNode = this;
      this.children = [node];
    },
    insertBefore(newNode, refNode) {
      const idx = refNode ? this.children.indexOf(refNode) : -1;
      this.children.splice(idx === -1 ? this.children.length : idx, 0, newNode);
      newNode.parentNode = this;
      return newNode;
    },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx !== -1) this.children.splice(idx, 1);
      node.parentNode = null;
      return node;
    },
    replaceChild(newNode, oldNode) {
      const idx = this.children.indexOf(oldNode);
      // Real DOM throws NotFoundError here rather than mutating anything.
      // Without this guard, idx === -1 makes `this.children[-1] = newNode`
      // set a non-integer property on the array instead of replacing
      // anything, while still linking newNode.parentNode to this element —
      // silent corruption instead of a loud failure.
      if (idx === -1) {
        throw new Error(
          "Failed to execute 'replaceChild': the node to be replaced is not a child of this node",
        );
      }
      this.children[idx] = newNode;
      newNode.parentNode = this;
      oldNode.parentNode = null;
      return oldNode;
    },
    normalize() {
      const merged = [];
      for (const c of this.children) {
        const prev = merged[merged.length - 1];
        if (c.nodeType === 3 && prev && prev.nodeType === 3) {
          prev.nodeValue += c.nodeValue;
        } else {
          merged.push(c);
        }
      }
      this.children = merged;
    },
    querySelectorAll(selector) {
      return mutableQueryAll(this, selector);
    },
  };
}

function mutableQueryAll(root, selector) {
  const match = /^(\w+)\[([\w-]+)\]$/.exec(selector);
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.nodeType === 1) {
        if (match && child.tagName === match[1].toUpperCase() && match[2] in child.attributes) {
          out.push(child);
        }
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** Page globals for running highlightTextOnPage/clearHighlightsOnPage. */
export function makeMutablePage(bodyChildren) {
  const body = makeMutableElement("body");
  for (const child of bodyChildren) {
    child.parentNode = body;
    body.children.push(child);
  }

  const document = {
    body,
    createElement: (tag) => makeMutableElement(tag),
    createTextNode: (value) => makeTextNode(value),
    createTreeWalker(root, _whatToShow, filter) {
      const nodes = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.nodeType === 3) {
            if (!filter || filter.acceptNode(child) === 1) nodes.push(child);
          } else if (child.nodeType === 1) {
            walk(child);
          }
        }
      };
      walk(root);
      let i = -1;
      return { nextNode: () => (++i < nodes.length ? nodes[i] : null) };
    },
    querySelectorAll: (selector) => mutableQueryAll(body, selector),
  };

  return {
    document,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  };
}

export function textNode(value) {
  return makeTextNode(value);
}

export function elementNode(tag, textContent) {
  const node = makeMutableElement(tag);
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

// --- Background loader -------------------------------------------------------

/**
 * @param {object} opts
 * @param {Array}  opts.tabs      tabs visible to chrome.tabs.query
 * @param {object} opts.local     initial chrome.storage.local contents (config)
 * @param {Function} opts.inject  ({tabId, func}) => InjectionResult[] | throws
 * @param {Function} opts.fetch   stub for the chat completions call
 */
export function loadBackground(opts = {}) {
  const local = { ...(opts.local || {}) };
  const tabs = opts.tabs || [];
  const queries = [];
  let listener = null;

  const chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
    action: { onClicked: { addListener: () => {} } },
    storage: {
      local: {
        // chrome.storage.local.get accepts a string, an array of keys, or null
        // for everything. background.js uses the array form.
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const key of keys) if (key in local) out[key] = local[key];
            return out;
          }
          if (typeof keys === "string") {
            return keys in local ? { [keys]: local[keys] } : {};
          }
          return { ...local };
        },
        set: async (obj) => {
          Object.assign(local, obj);
        },
        remove: async (key) => {
          delete local[key];
        },
      },
    },
    tabs: {
      query: async (query) => {
        queries.push(query);
        return tabs.filter(
          (tab) =>
            typeof query.windowId !== "number" || tab.windowId === query.windowId,
        );
      },
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        if (!opts.inject) throw new Error("no inject stub configured");
        return opts.inject({ tabId: target.tabId, func, args });
      },
    },
  };

  const sandbox = {
    chrome,
    console,
    URL,
    AbortSignal,
    fetch: opts.fetch || (() => Promise.reject(new Error("no fetch stub"))),
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BACKGROUND, "utf8"), sandbox);

  if (!listener) throw new Error("background.js registered no message listener");

  // Cumulative across every send() on this instance. A promise cannot be
  // rejected after it settles, so a second sendResponse can't be surfaced by
  // send() itself — assert on this counter instead.
  let replyCount = 0;

  /** Sends a message and resolves with the first sendResponse payload. */
  const send = (message, sender = { id: "test-extension-id" }) =>
    new Promise((resolve) => {
      // Per-call, so a second send() on the same instance still resolves; the
      // cumulative counter above is only for asserting on double-replies.
      let repliesHere = 0;
      const sendResponse = (payload) => {
        repliesHere += 1;
        replyCount += 1;
        if (repliesHere === 1) resolve(payload);
      };
      const kept = listener(message, sender, sendResponse);
      if (kept !== true) resolve(undefined); // handler declined the message
    });

  // `listener` is exposed so tests can supply a hostile sendResponse (one that
  // throws, as Chrome's does after the port closes) rather than only the
  // well-behaved one `send` provides.
  return {
    send,
    listener,
    local,
    queries,
    sandbox,
    get replyCount() {
      return replyCount;
    },
  };
}

// --- Sidepanel loader ---------------------------------------------------------

// sidepanel.js is a classic script, not a module: it wires up DOM elements and
// registers event listeners at top level, and calls checkStatus() immediately.
// Loading it into a vm context needs a minimal `document`/`chrome` stub good
// enough to satisfy that top-level code without throwing — the tests below only
// exercise extractActionBlock(), a pure function pulled off the resulting
// sandbox, so the stub does not need to support real DOM mutation.
function stubElement() {
  const listeners = {};
  return {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    options: [],
    appendChild() {},
    dispatchEvent() {},
    focus() {},
    get value() {
      return this._value || "";
    },
    set value(v) {
      this._value = v;
    },
  };
}

/** Loads sidepanel.js into a vm context and returns its top-level bindings. */
export function loadSidepanel() {
  const document = {
    getElementById: () => stubElement(),
    createElement: () => stubElement(),
  };

  const chrome = {
    runtime: {
      sendMessage: async () => ({ isAuthenticated: false }),
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
    },
  };

  const sandbox = { document, chrome, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SIDEPANEL, "utf8"), sandbox);
  return sandbox;
}
