/* Batch detail — subjects, announcements, about */

import {
  mountChrome,
  esc,
  money,
  qs,
  toast,
  fmtDate,
  fmtRelative,
  rememberBatch,
  emptyState,
} from "./app.js";
import { trackBatch } from "./library.js";
import { loadBatch as fetchBatchData, loadAnnouncements } from "./data.js";

mountChrome("batches");

const batchId = qs("id");
const detailGrid = document.getElementById("detailGrid");
const detailBg = document.getElementById("detailBg");
const crumbName = document.getElementById("crumbName");
const tabBody = document.getElementById("tabBody");

let batch = null;
let tab = "subjects";

if (!batchId) {
  detailGrid.innerHTML = emptyState("No batch selected", "Open a batch from the catalogue.", `<a class="btn btn-primary" href="/batches.html">Browse batches</a>`);
} else {
  loadBatch();
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function renderDetail() {
  document.title = `${batch.name} — EduVibe PW`;
  crumbName.textContent = batch.name;
  if (batch.image) detailBg.style.backgroundImage = `url("${batch.image}")`;

  const cover = batch.image
    ? `<img src="${esc(batch.image)}" alt="" onerror="this.remove()" />`
    : `<div style="display:grid;place-items:center;height:100%;font-size:2.4rem;font-weight:900;color:rgba(255,255,255,.25)">${esc(initials(batch.name))}</div>`;

  detailGrid.innerHTML = `
    <div class="detail-cover">${cover}</div>
    <div class="detail-head">
      <div class="row" style="gap:.4rem">
        ${batch.exam && batch.exam.length ? `<span class="pill pill-brand">${esc(batch.exam.join(" · "))}</span>` : ""}
        ${batch.className ? `<span class="pill">Class ${esc(batch.className)}</span>` : ""}
        ${batch.language ? `<span class="pill">${esc(batch.language)}</span>` : ""}
        ${batch.isFree ? `<span class="pill pill-accent">Free</span>` : ""}
      </div>
      <h1>${esc(batch.name)}</h1>
      <p class="muted">${esc(batch.byName || "Physics Wallah")}</p>
      <div class="detail-meta">
        ${batch.startDate ? `<span class="pill">Starts ${esc(fmtDate(batch.startDate))}</span>` : ""}
        ${batch.endDate ? `<span class="pill">Ends ${esc(fmtDate(batch.endDate))}</span>` : ""}
        ${batch.price ? `<span class="pill pill-brand">${esc(money(batch.price))}</span>` : ""}
        <span class="pill">${batch.subjects.length} subjects</span>
      </div>
      <div class="row" style="margin-top:.5rem">
        ${batch.subjects.length ? `<button class="btn btn-primary" id="startBtn">Start learning</button>` : ""}
        <a class="btn btn-ghost" href="https://pw.eduvibe.cc.cd/" target="_blank" rel="noopener">Open on source site</a>
      </div>
    </div>`;

  document.getElementById("startBtn")?.addEventListener("click", () => {
    const first = batch.subjects[0];
    location.href = `/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(first.slug)}&name=${encodeURIComponent(first.name)}`;
  });
}

function renderSubjects() {
  if (!batch.subjects.length) {
    tabBody.innerHTML = emptyState(
      "No subjects published yet",
      "This batch has no subject content on the source site right now."
    );
    return;
  }
  tabBody.innerHTML = `<div class="grid grid-subjects">${batch.subjects
    .map(
      (s) => `
      <a class="subject-card fade-up" href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(s.slug)}&name=${encodeURIComponent(s.name)}">
        ${s.image ? `<img class="icon" src="${esc(s.image)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'icon',textContent:'${esc(initials(s.name))}'}))" />` : `<div class="icon">${esc(initials(s.name))}</div>`}
        <div class="grow">
          <div class="name">${esc(s.name)}</div>
          <div class="sub">${s.lectureCount ? `${s.lectureCount} lectures` : "Open chapter list"}${s.tagCount ? ` · ${s.tagCount} chapters` : ""}</div>
        </div>
        <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
      </a>`
    )
    .join("")}</div>`;
}

function renderAbout() {
  const parts = [];
  if (batch.shortDescription) parts.push(`<div class="detail-about" style="max-height:none">${esc(batch.shortDescription)}</div>`);
  if (batch.description) parts.push(`<div class="detail-about" style="max-height:none;margin-top:.8rem">${esc(batch.description)}</div>`);
  if (batch.banners && batch.banners.length) {
    parts.push(
      `<div class="grid grid-cards" style="margin-top:1rem">${batch.banners
        .slice(0, 6)
        .map((b) => `<img src="${esc(b)}" alt="" style="border-radius:14px;border:1px solid var(--line)" loading="lazy" />`)
        .join("")}</div>`
    );
  }
  tabBody.innerHTML = parts.join("") || emptyState("No description", "The source batch carries no description text.");
}

async function renderAnnouncements() {
  tabBody.innerHTML = `<div class="list">${Array.from({ length: 4 })
    .map(() => `<div class="skeleton" style="height:74px;border-radius:14px"></div>`)
    .join("")}</div>`;
  try {
    const out = await loadAnnouncements(batchId);
    const items = out.items || [];
    if (!items.length) {
      tabBody.innerHTML = emptyState("No announcements", "This batch has no updates published right now.");
      return;
    }
    tabBody.innerHTML = `<div class="list">${items
      .map(
        (a) => `
        <article class="card" style="padding:.9rem 1rem">
          <div class="row between" style="align-items:flex-start">
            <div>
              <div class="row" style="gap:.4rem">
                <span class="pill pill-brand">${esc(a.useCase || a.type || "Update")}</span>
                <span class="tiny dim">${esc(fmtRelative(a.createdAt))}</span>
              </div>
              <h3 style="font-size:.95rem;margin-top:.45rem">${esc(a.heading)}</h3>
              <p class="tiny muted" style="margin-top:.25rem">${esc(a.message)}</p>
              <p class="tiny dim" style="margin-top:.4rem">by ${esc(a.author)}</p>
            </div>
            ${a.attachment ? `<a class="btn btn-ghost btn-sm" href="${esc(a.attachment.url)}" target="_blank" rel="noopener">Attachment</a>` : ""}
          </div>
        </article>`
      )
      .join("")}</div>`;
  } catch (err) {
    tabBody.innerHTML = emptyState("Announcements unavailable", err.message);
  }
}

function setTab(next) {
  tab = next;
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  if (tab === "subjects") renderSubjects();
  if (tab === "about") renderAbout();
  if (tab === "announcements") renderAnnouncements();
}

document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => setTab(btn.dataset.tab))
);

async function loadBatch() {
  try {
    const out = await fetchBatchData(batchId);
    batch = out.batch;
    batch.subjects = out.subjects || [];
    renderDetail();
    renderSubjects();
    rememberBatch({ id: batch.id, name: batch.name, image: batch.image });
    trackBatch({ id: batch.id, name: batch.name, image: batch.image });
    document.getElementById("detailGrid").classList.add("fade-up");
  } catch (err) {
    detailGrid.innerHTML = emptyState("Batch unavailable", err.message, `<a class="btn btn-primary" href="/batches.html">Back to batches</a>`);
    tabBody.innerHTML = "";
    toast(err.message, "error");
  }
}
