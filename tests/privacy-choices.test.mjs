import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrivacyRecord,
  optionalMapsAllowed,
  parsePrivacyRecord,
  readPrivacyChoice,
  writePrivacyChoice,
} from "../weatherchart/assets/js/privacy-choices.js";

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-14T12:00:00.000Z");

test("privacy records contain only the versioned map choice and six-month timestamps", () => {
  const rejected = createPrivacyRecord(false, NOW);
  assert.deepEqual(Object.keys(rejected).sort(), ["decidedAt", "expiresAt", "optionalMaps", "version"]);
  assert.deepEqual(rejected, {
    version: 1,
    optionalMaps: false,
    decidedAt: "2026-07-14T12:00:00.000Z",
    expiresAt: "2027-01-10T12:00:00.000Z",
  });
  assert.equal(Date.parse(rejected.expiresAt) - Date.parse(rejected.decidedAt), SIX_MONTHS_MS);

  const allowed = createPrivacyRecord(true, NOW);
  assert.equal(allowed.optionalMaps, true);
  assert.deepEqual(parsePrivacyRecord(JSON.stringify(allowed), NOW), allowed);
});

test("privacy parsing fails closed for malformed, expired, future, overlong or expanded records", () => {
  const valid = createPrivacyRecord(true, NOW);
  const invalid = [
    null,
    "",
    "not-json",
    [],
    { ...valid, version: 2 },
    { ...valid, optionalMaps: "true" },
    { ...valid, advertising: false },
    { version: 1, optionalMaps: true, decidedAt: valid.decidedAt },
    { ...valid, decidedAt: new Date(NOW + 1).toISOString() },
    { ...valid, expiresAt: new Date(NOW).toISOString() },
    { ...valid, expiresAt: new Date(NOW + SIX_MONTHS_MS + 1).toISOString() },
    { ...valid, decidedAt: "not-a-date" },
    { ...valid, expiresAt: "not-a-date" },
  ];

  for (const value of invalid) {
    assert.equal(parsePrivacyRecord(value, NOW), null, `Unexpectedly accepted ${JSON.stringify(value)}`);
  }
  assert.equal(optionalMapsAllowed(), false, "maps must default off outside a valid browser decision");
});

test("invalid stored choices are removed and blocked storage remains fail-closed", () => {
  const removed = [];
  const invalidStorage = {
    getItem(key) {
      assert.equal(key, "weatherchart.privacy.v1");
      return JSON.stringify({ ...createPrivacyRecord(true, NOW), extra: "not permitted" });
    },
    removeItem(key) {
      removed.push(key);
    },
  };
  assert.equal(readPrivacyChoice(invalidStorage, "weatherchart.privacy.v1", NOW), null);
  assert.deepEqual(removed, ["weatherchart.privacy.v1"]);

  const blockedStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  };
  assert.equal(readPrivacyChoice(blockedStorage, "weatherchart.privacy.v1", NOW), null);
  assert.deepEqual(writePrivacyChoice(blockedStorage, "weatherchart.privacy.v1", false, NOW), createPrivacyRecord(false, NOW));
});

test("valid choices round-trip through the site-specific minimal storage key", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  const written = writePrivacyChoice(storage, "coolisle.privacy.v1", true, NOW);
  assert.deepEqual([...values.keys()], ["coolisle.privacy.v1"]);
  assert.deepEqual(Object.keys(JSON.parse(values.get("coolisle.privacy.v1"))).sort(), ["decidedAt", "expiresAt", "optionalMaps", "version"]);
  assert.deepEqual(readPrivacyChoice(storage, "coolisle.privacy.v1", NOW), written);
  assert.equal(readPrivacyChoice(storage, "coolisle.privacy.v1", Date.parse(written.expiresAt)), null);
  assert.equal(values.has("coolisle.privacy.v1"), false);
});

test("first-visit reject, settings reopen and allow actions update the real page state", async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalCustomEvent = globalThis.CustomEvent;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.listeners = new Map();
      this.isConnected = false;
      this.parentElement = null;
      this.textContent = "";
      this.className = "";
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    append(...children) {
      for (const child of children) {
        child.parentElement = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
      }
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type) {
      for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
    }

    matches(selector) {
      if (selector === "button") return this.tagName === "BUTTON";
      const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
      return attribute ? this.attributes.has(attribute) : false;
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }

    focus() {
      fakeDocument.activeElement = this;
    }

    remove() {
      const index = this.parentElement?.children.indexOf(this) ?? -1;
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.isConnected = false;
      this.parentElement = null;
    }
  }

  const values = new Map();
  const documentListeners = new Map();
  const heading = new FakeElement("h1");
  const status = new FakeElement("p");
  const body = new FakeElement("body");
  body.isConnected = true;
  const originalAppend = body.append.bind(body);
  body.append = (...children) => {
    originalAppend(...children);
    for (const child of children) child.isConnected = true;
  };
  const fakeDocument = {
    readyState: "complete",
    activeElement: null,
    documentElement: { dataset: {} },
    body,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector(selector) {
      if (selector === "h1") return heading;
      if (selector === "[data-privacy-choice-status]") return status;
      return null;
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
  };
  const events = [];
  globalThis.document = fakeDocument;
  globalThis.window = {
    location: { pathname: "/Cool-Isle/index.html" },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    dispatchEvent: (event) => events.push(event),
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.CustomEvent = originalCustomEvent;
  });

  await import(`../weatherchart/assets/js/privacy-choices.js?ui-test=${Date.now()}`);
  assert.equal(fakeDocument.documentElement.dataset.privacyChoice, "undecided");
  assert.equal(body.children.length, 1, "first visit must show the choice panel");
  const firstPanel = body.children[0];
  assert.equal(firstPanel.querySelector("[data-privacy-reject]").textContent, "Reject optional maps");
  assert.equal(firstPanel.querySelector("[data-privacy-allow]").textContent, "Allow optional maps");

  firstPanel.querySelector("[data-privacy-reject]").dispatch("click");
  assert.equal(fakeDocument.documentElement.dataset.privacyChoice, "optional-rejected");
  assert.equal(body.children.length, 0);
  assert.equal(JSON.parse(values.get("coolisle.privacy.v1")).optionalMaps, false);
  assert.equal(events.at(-1).detail.optionalMaps, false);

  const settings = new FakeElement("button");
  settings.setAttribute("data-privacy-settings", "");
  settings.isConnected = true;
  documentListeners.get("click")({ target: settings, preventDefault() {} });
  assert.equal(body.children.length, 1, "settings must reopen the same equal choice panel");
  body.children[0].querySelector("[data-privacy-allow]").dispatch("click");
  assert.equal(fakeDocument.documentElement.dataset.privacyChoice, "optional-allowed");
  assert.equal(JSON.parse(values.get("coolisle.privacy.v1")).optionalMaps, true);
  assert.equal(events.at(-1).detail.optionalMaps, true);
});
