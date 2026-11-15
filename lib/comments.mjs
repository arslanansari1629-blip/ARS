/**
 * Class comments — one discussion thread per lecture.
 *
 * Server-side for the same reason the leaderboard is: two phones in one
 * classroom should see the same thread. Rows live in the shared document
 * store (`lib/store.mjs`) under one key per lecture, capped and cleaned on
 * every write because this route is reachable by anyone. With no store
 * attached the store itself says "memory" and so does this module — the
 * thread then lives on one instance, which the UI states plainly instead
 * of pretending otherwise.
 */

import { readDoc, writeDoc, storeName } from "./store.mjs";

const MAX_COMMENTS = 150;
const MAX_TEXT = 300;
const MAX_NAME = 40;

const keyFor = (lectureId) => `arsvibe:comments:${lectureId}`;

export function cleanCommentText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

export function cleanCommentName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || "Student";
}

function validLecture(lectureId) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(lectureId || ""));
}

export async function listComments(lectureId) {
  if (!validLecture(lectureId)) {
    return { success: false, error: "A lecture id is required.", comments: [], store: storeName() };
  }
  const doc = await readDoc(keyFor(lectureId)).catch(() => null);
  const comments = Array.isArray(doc?.comments) ? doc.comments : [];
  return { success: true, lecture: lectureId, comments, total: comments.length, store: storeName() };
}

export async function postComment(lectureId, { name, text } = {}) {
  if (!validLecture(lectureId)) return { success: false, error: "A lecture id is required." };
  const clean = cleanCommentText(text);
  if (!clean) return { success: false, error: "Write something first." };
  const doc = await readDoc(keyFor(lectureId)).catch(() => null);
  const comments = Array.isArray(doc?.comments) ? doc.comments : [];
  const comment = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: cleanCommentName(name),
    text: clean,
    at: new Date().toISOString(),
    likes: 0,
  };
  const next = [comment, ...comments].slice(0, MAX_COMMENTS);
  const store = await writeDoc(keyFor(lectureId), { comments: next }).catch(() => "memory");
  return { success: true, comment, comments: next, total: next.length, store };
}

export async function likeComment(lectureId, commentId) {
  if (!validLecture(lectureId)) return { success: false, error: "A lecture id is required." };
  const doc = await readDoc(keyFor(lectureId)).catch(() => null);
  const comments = Array.isArray(doc?.comments) ? doc.comments : [];
  const target = comments.find((c) => c.id === commentId);
  if (!target) return { success: false, error: "That comment is gone." };
  target.likes = Math.min(9999, (Number(target.likes) || 0) + 1);
  const store = await writeDoc(keyFor(lectureId), { comments }).catch(() => "memory");
  return { success: true, comments, total: comments.length, store };
}
