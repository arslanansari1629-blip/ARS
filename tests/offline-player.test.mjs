/**
 * The saved-lecture player.
 *
 * The behaviour under test is the one that was wrong in the wild: a saved
 * lecture was only reachable as a file in Chrome's Downloads folder or as a
 * blob in a blank tab, so it never looked like the site had kept it. This drives
 * the real module against a jsdom document and a stand-in IndexedDB, and checks
 * the thing a person would notice — the sheet opens, with their lecture in it,
 * playing from bytes that are already on the device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const TS = Buffer.alloc(188 * 4, 0x47);

/** Enough of IndexedDB for `savedLecture()`: one record, by key. */
function fakeIndexedDb(record) {
  return {
    open() {
      const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        close() {},
        transaction() {
          return {
            objectStore() {
              return {
                get() {
                  const get = { result: null, onsuccess: null, onerror: null };
                  setTimeout(() => {
                    get.result = record;
                    if (get.onsuccess) get.onsuccess();
                  }, 0);
                  return get;
                },
              };
            },
          };
        },
      };
      setTimeout(() => {
        request.result = db;
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
}

/** A fresh document per test: the module mounts its sheet once, by design. */
function boot(record) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://site.test/downloads" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Blob = dom.window.Blob;

  const blobs = [];
  const revoked = [];
  const url = {
    createObjectURL(blob) {
      blobs.push(blob);
      return `blob:test/${blobs.length}`;
    },
    revokeObjectURL(u) {
      revoked.push(u);
    },
  };
  globalThis.URL.createObjectURL = url.createObjectURL;
  globalThis.URL.revokeObjectURL = url.revokeObjectURL;
  dom.window.URL.createObjectURL = url.createObjectURL;
  dom.window.URL.revokeObjectURL = url.revokeObjectURL;

  // jsdom has no media pipeline; the contract under test is what gets attached.
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  dom.window.HTMLMediaElement.prototype.load = function () {};

  globalThis.indexedDB = fakeIndexedDb(record);
  // A fresh module instance per test, so each mounts onto its own document.
  const stamp = Math.random().toString(36).slice(2);
  return import(`../public/assets/offline-player.js?t=${stamp}`).then((mod) => ({
    mod,
    doc: dom.window.document,
    blobs,
    revoked,
  }));
}

test("a saved lecture plays here, from the device, in the site's own sheet", async () => {
  const record = {
    id: "lec1",
    title: "Units and Dimension 10",
    format: "plain",
    done: true,
    quality: "240",
    label: "240p",
    seconds: 600,
    total: 100,
    parts: [{ index: 0, data: TS.toString("base64"), seconds: 600, size: TS.length }],
  };
  const { mod, doc, blobs } = await boot(record);

  const ok = await mod.playSaved("lec1");
  assert.equal(ok, true);

  const sheet = doc.querySelector(".offline-player");
  assert.ok(sheet, "no player sheet was mounted");
  assert.equal(sheet.hidden, false, "the sheet stayed hidden");

  // The lecture is identified as the thing that was saved, not "Lecture".
  assert.equal(doc.getElementById("opTitle").textContent, "Units and Dimension 10");
  assert.match(doc.getElementById("opMeta").textContent, /240p/);

  // Media comes from a blob of the saved bytes: no URL to expire, no request.
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, "video/mp2t");
  assert.equal(blobs[0].size, TS.length);
  assert.match(doc.getElementById("opVideo").getAttribute("src"), /^blob:/);
});

test("closing the player releases the media instead of leaking it", async () => {
  const record = {
    id: "lec2",
    title: "Rotational Motion",
    format: "plain",
    done: true,
    parts: [{ index: 0, data: TS.toString("base64"), seconds: 60, size: TS.length }],
  };
  const { mod, doc, revoked } = await boot(record);
  await mod.playSaved("lec2");

  const sheet = doc.querySelector(".offline-player");
  sheet.querySelector("[data-close]").click();

  assert.equal(sheet.hidden, true, "the sheet stayed open");
  assert.equal(revoked.length, 1, "the blob URL was not revoked");
  assert.equal(doc.getElementById("opVideo").getAttribute("src"), null);
});

test("a lecture that is not saved is refused rather than shown empty", async () => {
  const { mod, doc } = await boot(null);
  const ok = await mod.playSaved("missing");
  assert.equal(ok, false);
  assert.equal(doc.querySelector(".offline-player").hidden, true);
});

test("an unfinished download still opens, and says it is partial", async () => {
  const record = {
    id: "lec3",
    title: "Kinematics",
    format: "plain",
    done: false,
    parts: [{ index: 0, data: TS.toString("base64"), seconds: 60, size: TS.length }],
  };
  const { mod, doc } = await boot(record);
  const ok = await mod.playSaved("lec3");
  assert.equal(ok, true);
  assert.match(doc.getElementById("opMeta").textContent, /Partially saved/);
});
