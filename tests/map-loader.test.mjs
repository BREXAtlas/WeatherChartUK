import assert from "node:assert/strict";
import test from "node:test";

test("the map loader appends integrity-pinned Leaflet assets only when requested", async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const appended = [];
  const nodes = new Map();
  const leaflet = { version: "test-leaflet" };
  const now = Date.now();
  const acceptedChoice = JSON.stringify({
    version: 1,
    optionalMaps: true,
    decidedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  });

  const createNode = (tagName) => {
    const listeners = new Map();
    return {
      tagName: tagName.toUpperCase(),
      dataset: {},
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      dispatch(type) {
        listeners.get(type)?.();
      },
    };
  };

  globalThis.window = {
    L: null,
    location: { pathname: "/WeatherChartUK/index.html" },
    localStorage: {
      getItem(key) {
        return key === "weatherchart.privacy.v1" ? acceptedChoice : null;
      },
      removeItem() {},
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    readyState: "loading",
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
    createElement: createNode,
    head: {
      append(node) {
        appended.push(node);
        if (node.tagName === "LINK") {
          node.sheet = {};
          nodes.set("link[data-leaflet-styles]", node);
        } else {
          globalThis.window.L = leaflet;
          nodes.set("script[data-leaflet-script]", node);
        }
        queueMicrotask(() => node.dispatch("load"));
      },
    },
  };
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  const { loadLeaflet } = await import(`../weatherchart/assets/js/map.js?loader-test=${Date.now()}`);
  assert.equal(appended.length, 0, "importing the module must not request map assets");

  const loaded = await loadLeaflet(250);
  assert.equal(loaded, leaflet);
  assert.equal(appended.length, 2);

  const stylesheet = appended.find(({ tagName }) => tagName === "LINK");
  assert.equal(stylesheet.rel, "stylesheet");
  assert.equal(stylesheet.href, "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
  assert.equal(stylesheet.integrity, "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=");
  assert.equal(stylesheet.crossOrigin, "anonymous");

  const script = appended.find(({ tagName }) => tagName === "SCRIPT");
  assert.equal(script.src, "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
  assert.equal(script.integrity, "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=");
  assert.equal(script.crossOrigin, "anonymous");
});
