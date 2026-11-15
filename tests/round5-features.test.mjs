/**
 * Round 5: AI removed; live classes page; per-lecture discussion; smoothness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the AI doubt feature is gone", async () => {
  const html = await read("public/watch.html");
  assert.doesNotMatch(html, /ai-doubt|aiCard|aiLog/);
  assert.equal(existsSync(new URL("public/assets/ai-doubt.js", root)), false);
});

test("lecture comments post, list and like", async () => {
  const { postComment, listComments, likeComment, cleanCommentText } = await import("../lib/comments.mjs");
  assert.equal(cleanCommentText("  hello   world  "), "hello world");
  const posted = await postComment("Lec_1-x", { name: "Aarav", text: "Why does the graph curve?" });
  assert.equal(posted.success, true);
  assert.equal(posted.comments[0].name, "Aarav");
  assert.equal((await listComments("Lec_1-x")).comments.length, 1);
  const liked = await likeComment("Lec_1-x", posted.comments[0].id);
  assert.equal(liked.comments[0].likes, 1);
  assert.equal((await postComment("bad id!", { name: "x", text: "y" })).success, false);
  assert.equal((await postComment("Lec_1-x", { name: "x", text: "   " })).success, false);
});

test("comments route rides the utility function", async () => {
  const token = await read("api/token.mjs");
  assert.match(token, /route === "comments"/);
  assert.match(token, /commentsRoute/);
  const comments = await read("public/assets/comments.js");
  assert.match(comments, /route=comments/);
});

test("live classes have a page, a feed and a ticking refresh", async () => {
  const html = await read("public/live.html");
  assert.match(html, /id="liveNow"/);
  assert.match(html, /id="liveSoon"/);
  assert.match(html, /id="liveDone"/);
  const js = await read("public/assets/live.js");
  assert.match(js, /today=1/);
  assert.match(js, /today\.classes/);
  assert.match(js, /Join live/);
  assert.match(js, /60000/);
  const shell = await read("public/assets/shell.mjs");
  assert.match(shell, /"Live classes"/);
});

test("the player grows a live-edge button", async () => {
  const plus = await read("public/assets/player-plus.js");
  assert.match(plus, /liveEdgeBtn/);
  assert.match(plus, /seekable/);
});

test("smoothness: view transitions and content-visibility ship", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /@view-transition/);
  assert.match(css, /content-visibility/);
  const watch = await read("public/watch.html");
  assert.match(watch, /id="commentsCard"/);
  assert.match(watch, /comments\.js/);
});
