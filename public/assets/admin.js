/* Admin panel — sign in, then poll live health and traffic.
 *
 * The operator's credentials are never stored here and never sent anywhere but
 * the same-origin sign-in route; what this page keeps is the session token the
 * server hands back, in sessionStorage so closing the tab ends the session.
 */

const TOKEN_KEY = "arsvibe.admin.token";
const POLL_MS = 20000;

const $ = (sel) => document.querySelector(sel);
const gate = $("#gate");
const panel = $("#panel");

let token = sessionStorage.getItem(TOKEN_KEY) || "";
let logTab = "slow";
let poller = null;
let lastData = null;

/* ---------------------------------------------------------------- helpers */

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function ago(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/* ------------------------------------------------------------------ gate */

function showGate(message = "") {
  panel.hidden = true;
  gate.hidden = false;
  const err = $("#loginError");
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  $("#adminUser").focus();
}

function showPanel() {
  gate.hidden = true;
  panel.hidden = false;
}

$("#passEye")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const field = $("#adminPass");
  const shown = field.type === "text";
  field.type = shown ? "password" : "text";
  btn.setAttribute("aria-pressed", String(!shown));
  btn.setAttribute("aria-label", shown ? "Show password" : "Hide password");
  field.focus();
});

$("#loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginBtn");
  const username = $("#adminUser").value.trim();
  const password = $("#adminPass").value;
  const err = $("#loginError");

  if (!username || !password) {
    err.textContent = "Enter your username and password.";
    err.hidden = false;
    return;
  }

  btn.disabled = true;
  btn.textContent = "Signing in…";
  err.hidden = true;

  try {
    const res = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      // The server sends one message for a wrong username and a wrong password.
      showGate(data.error || "Sign-in failed. Check your details.");
      $("#adminPass").value = "";
      return;
    }
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    $("#adminPass").value = "";
    showPanel();
    await load();
    loadAudit();
    startPolling();
  } catch (error) {
    showGate(`Could not reach the server: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("#signOutBtn")?.addEventListener("click", async () => {
  try {
    await fetch("/api/admin?action=logout", {
      method: "POST",
      headers: { "x-admin-token": token },
    });
  } catch {
    /* the local token is dropped either way */
  }
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  showGate();
});

$("#refreshBtn")?.addEventListener("click", () => load());

/* --------------------------------------------------------------- polling */

function startPolling() {
  if (poller) clearInterval(poller);
  poller = setInterval(() => {
    // No point polling a tab nobody is looking at.
    if (!document.hidden) load();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token && !panel.hidden) load();
});

async function load() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch("/api/admin?action=stats", {
      headers: { "x-admin-token": token },
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      token = "";
      sessionStorage.removeItem(TOKEN_KEY);
      showGate("Your session ended. Sign in again.");
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    render(data);
    $("#liveDot").classList.add("on");
  } catch (error) {
    $("#liveDot").classList.remove("on");
    $("#liveDot").lastChild.textContent = ` offline (${error.message})`;
    $("#refreshedAt").textContent = "last refresh failed";
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- render */

function render(data) {
  lastData = data;
  $("#envChip").textContent = data.release.env || "development";
  $("#refreshedAt").textContent = `updated ${new Date().toLocaleTimeString()}`;
  $("#liveDot").classList.add("on");
  $("#liveDot").lastChild.textContent = " live";

  renderHero(data);
  renderHealth(data);
  renderTraffic(data);
  renderRoutes(data);
  renderLogs(data);
  renderKv("#releaseKv", [
    ["Commit", data.release.commit ? `${data.release.commitShort} (${data.release.ref || "—"})` : "local"],
    ["Environment", data.release.env],
    ["Region", data.release.region || "—"],
    ["Node", data.release.node],
    ["Deployment", data.release.deployment || "—"],
  ]);
  renderHealing(data.selfHeal);
  renderKv("#runtimeKv", [
    ["Uptime", duration(data.uptimeSeconds)],
    ["Resident memory", `${data.runtime.memoryMb} MB`],
    ["Heap used", `${data.runtime.heapMb} MB`],
    ["Catalogue", `${Number(data.catalogue.batches).toLocaleString()} batches`],
    ["Data source", data.catalogue.source],
    ["Admin sessions", String(data.traffic.liveSessions)],
  ]);
  $("#adminNote").textContent = data.trafficNote || "";
}

function renderHero(data) {
  // Soft checks (the site's own URL, probed from the function) inform but never
  // turn the panel red: they can be blocked while the site is perfectly fine.
  const failing = data.health.filter((h) => !h.ok && !h.skipped && !h.soft);
  const slowest = [...data.health].filter((h) => !h.skipped).sort((a, b) => b.ms - a.ms)[0];
  const line = $("#statusLine");
  line.textContent = failing.length ? `${failing.length} check${failing.length > 1 ? "s" : ""} failing` : "All systems operational";
  line.className = failing.length ? "admin-bad" : "admin-good";
  $("#statusHint").textContent = failing.length
    ? `Failing: ${failing.map((h) => h.name).join(", ")}. ${failing[0].detail || ""}`
    : `Every probe answered. Slowest: ${slowest ? `${slowest.name} at ${slowest.ms} ms` : "n/a"}.`;

  const t = data.traffic;
  $("#heroStats").innerHTML = [
    ["Requests", Number(t.requests).toLocaleString(), "since this instance started"],
    ["Errors", Number(t.errors).toLocaleString(), `${t.errorRate}% of requests`],
    ["Page views", Number(t.pages).toLocaleString(), "public HTML pages served"],
    ["Live sessions", String(t.liveSessions), "signed-in admins"],
  ]
    .map(
      ([label, value, hint]) => `
      <div class="hero-stat">
        <strong>${esc(value)}</strong>
        <span>${esc(label)}</span>
        <em>${esc(hint)}</em>
      </div>`
    )
    .join("");
}

function renderHealth(data) {
  const rows = data.health
    .map((h) => {
      const dot = h.skipped ? "skip" : h.ok ? "good" : h.soft ? "warn" : "bad";
      return `
      <div class="health-row">
        <span class="health-dot ${dot}"></span>
        <span class="grow">
          <span class="health-name">${esc(h.name)}</span>
          <span class="tiny dim">${esc(h.detail || (h.kind === "index" ? `${h.count} batches indexed` : "responded"))}</span>
        </span>
        <span class="health-ms ${h.ms > 2500 ? "warn" : ""}">${h.skipped ? "skipped" : `${h.ms} ms`}</span>
      </div>`;
    })
    .join("");
  $("#healthList").innerHTML = rows;

  const passing = data.health.filter((h) => (h.ok || h.soft) && !h.skipped).length;
  const total = data.health.filter((h) => !h.skipped).length;
  $("#healthSum").textContent = `${passing}/${total} passing`;

  const t = data.token;
  $("#tokenBox").innerHTML = `
    <div class="token-line">
      <span class="tiny dim">Upstream token</span>
      <strong>${esc(t.source)}</strong>
      <span class="token-pill ${t.usable ? "ok" : "bad"}">${t.usable ? "usable" : "missing"}</span>
    </div>
    <div class="tiny dim">
      ${t.expiresAt ? `expires ${esc(new Date(t.expiresAt).toLocaleTimeString())} (in ${Math.round((t.expiresIn || 0) / 60)} min, from ${esc(t.expiryFrom)})` : "no expiry claim"}
      · ${esc(t.prefix)}
      · ${data.credentials.length} credential${data.credentials.length === 1 ? "" : "s"} in the ladder
    </div>`;
}

function renderTraffic(data) {
  const series = data.traffic.series || [];
  const max = Math.max(1, ...series);
  const step = 300 / Math.max(1, series.length - 1);
  const points = series.map((v, i) => [i * step, 62 - (v / max) * 58]);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L300 64 L0 64 Z`;
  $("#sparkLine").setAttribute("d", line);
  $("#sparkFill").setAttribute("d", area);
  $("#rpm").textContent = `${series[series.length - 1] || 0} req in the last minute`;

  const statuses = data.traffic.byStatus || {};
  // Only 2xx is a success. Status 0 is a request that never got an answer
  // (a probe that could not reach its host); counting that as a success is how
  // a "108% success rate" appears on a panel.
  const ok = Object.entries(statuses)
    .filter(([code]) => +code >= 200 && +code < 400)
    .reduce((sum, [, n]) => sum + n, 0);
  const answered = Object.entries(statuses)
    .filter(([code]) => +code > 0)
    .reduce((sum, [, n]) => sum + n, 0);
  const unreachable = Number(statuses["0"] || 0);
  const serverErrors = Object.entries(statuses)
    .filter(([code]) => +code >= 500)
    .map(([code, n]) => `${code}×${n}`)
    .join(" ") || "none";

  renderKv("#trafficKv", [
    ["Success rate", `${answered ? Math.round((ok / answered) * 100) : 100}%`],
    ["Data requests", Number(data.traffic.apiRequests).toLocaleString()],
    ["Bytes served", bytes(data.traffic.bytesOut)],
    ["Server errors", serverErrors],
    ...(unreachable ? [["No answer", `${unreachable} (host unreachable)`]] : []),
    ...cacheRows(data.traffic.byCache || {}),
  ]);
}

/** How often Vercel's CDN answered a request this function also saw. */
function cacheRows(byCache) {
  const entries = Object.entries(byCache).filter(([, n]) => n > 0);
  if (!entries.length) return [];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return entries.map(([state, n]) => [
    `CDN ${state.toLowerCase()}`,
    `${Math.round((n / total) * 100)}% of ${total}`,
  ]);
}

function renderRoutes(data) {
  const entries = Object.entries(data.traffic.byRoute || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  $("#routeBars").innerHTML = entries.length
    ? entries
        .map(
          ([route, n]) => `
        <div class="route-bar">
          <span class="route-name">${esc(route)}</span>
          <span class="route-track"><span style="width:${Math.max(2, (n / max) * 100)}%"></span></span>
          <span class="route-n">${n}</span>
        </div>`
        )
        .join("")
    : `<p class="tiny dim">No requests recorded on this instance yet.</p>`;
}

/**
 * What the site repaired on its own.
 *
 * The student-facing pages show none of this: a repair is supposed to be
 * invisible, and a badge saying "we fixed 3 things" is a badge saying "this site
 * breaks". The operator, though, has to be able to tell "quiet because healthy"
 * from "quiet because the repair budget ran out" — so the ledger, the signer
 * ladder and the budget all land here, and nowhere else.
 */
function relayLine(r) {
  // Built by concatenation rather than a nested template: the shipped page-module
  // check parses these files with a simple scanner that cannot follow `${}` inside
  // a backtick string, and a false positive there fails the build.
  const total = String((r && r.failures10m) || 0);
  if (!r || !r.worst) return total;
  return total + " · mostly " + String(r.worst[0]);
}

function renderHealing(h) {
  const kv = $("#healKv");
  const log = $("#healLog");
  if (!kv || !log) return;

  if (!h) {
    kv.innerHTML = "";
    log.innerHTML = `<p class="tiny dim">This build does not report self-healing.</p>`;
    return;
  }

  const quarantined = (h.signers || []).filter((s) => s.quarantined);
  // Concatenated rather than nested templates: the shipped page-module check
  // parses these files with a simple scanner and misreads a backtick inside a
  // `${}` expression, which fails the build for no real reason. The same scanner
  // reads a plural noun followed by a bracket in a plain string as a function
  // call, so the label below is worded around it.
  const ladder = (h.signers || [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((s) => s.host + " " + (s.weight === 0 ? "(paused)" : Math.round(s.weight * 100) + "%"))
    .join(" · ");

  renderKv("#healKv", [
    ["Repairs this hour", `${h.budget.usedLastHour} of ${h.budget.cap}`],
    ["Signers quarantined", quarantined.length ? String(quarantined.length) : "none"],
    ["Signer ladder", ladder || "no signer has answered yet"],
    ["Relay faults, last 10 min", relayLine(h.relay)],
  ]);

  $("#healNote").textContent = h.budget.usedLastHour >= h.budget.cap
    ? "The repair budget for this hour is spent — new faults are being logged and left alone until the window rolls over."
    : "Repairs the site made without asking anyone. Visitors never see this list.";

  log.innerHTML = (h.repairs || []).length
    ? h.repairs
        .map(
          (r) => `
      <div class="log-row">
        <span class="log-title">${esc(r.action)}</span>
        <span class="tiny dim">${esc(r.summary)}</span>
        <span class="tiny dim log-when">${esc(ago(Date.parse(r.at)))}</span>
      </div>`
        )
        .join("")
    : `<p class="tiny dim">Nothing has needed repair since this instance started.</p>`;
}

function renderLogs(data) {
  const list = $("#logList");
  const items =
    logTab === "slow"
      ? (data.traffic.slowest || []).map((s) => ({
          title: `${s.route}`,
          meta: `${s.ms} ms · ${s.status ? `HTTP ${s.status}` : "no answer"}`,
          when: ago(s.at),
          bad: s.ms > 2500 || !s.status,
        }))
      : (data.traffic.lastErrors || []).map((e) => ({
          title: `${e.route} → HTTP ${e.status}`,
          meta: `${e.ms} ms`,
          when: ago(e.at),
          bad: true,
        }));

  list.innerHTML = items.length
    ? items
        .map(
          (i) => `
      <div class="log-row ${i.bad ? "bad" : ""}">
        <span class="log-title">${esc(i.title)}</span>
        <span class="tiny dim">${esc(i.meta)}</span>
        <span class="tiny dim log-when">${esc(i.when)}</span>
      </div>`
        )
        .join("")
    : `<p class="tiny dim">Nothing here yet — this list fills as traffic arrives.</p>`;
}

function renderKv(sel, rows) {
  $(sel).innerHTML = rows
    .map(
      ([k, v]) => `
      <div class="kv-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`
    )
    .join("");
}

$("#logTabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-log]");
  if (!btn) return;
  logTab = btn.dataset.log;
  for (const tab of document.querySelectorAll("#logTabs .tab")) {
    tab.classList.toggle("active", tab === btn);
  }
  if (lastData) renderLogs(lastData);
});

/* ----------------------------------------------------------------- audit */

/**
 * The content audit.
 *
 * Every other block on this panel describes the server. This one describes the
 * *content*, which is the only thing a student actually notices: of the lectures
 * in a batch, which ones do not play, and why.
 *
 * An audit is minutes of upstream work, so the panel does not wait for it in a
 * single request: it starts one, then polls the same route for progress. That
 * also means the answer survives a page reload — the server keeps the last
 * report — and the panel can say how old it is.
 */

const AUDIT_STATE_LABELS = {
  plays: "plays",
  pending: "pending",
  "no-stream": "no stream",
  broken: "broken",
  unknown: "unknown",
};

/** Order the rows worst-first: what needs work should not be below the fold. */
const AUDIT_ORDER = { broken: 0, "no-stream": 0, unknown: 1, pending: 2, plays: 3 };

/** Attribute-safe text. `esc` handles text nodes; this handles `title="…"`. */
const escAttr = (value) => String(value ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;");

let auditState = null;
let auditPoll = null;

function auditFmt(ms) {
  if (!Number.isFinite(ms)) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function renderAudit(audit, meta = {}) {
  auditState = audit;
  const totalsBox = $("#auditTotals");
  const rowsBox = $("#auditRows");
  const notesBox = $("#auditNotes");
  const stamp = $("#auditStamp");

  if (!audit) {
    stamp.textContent = "never run";
    totalsBox.innerHTML = "";
    rowsBox.innerHTML = `<p class="audit-empty">No audit has run on this server instance yet. Paste a batch id and run one.</p>`;
    notesBox.innerHTML = "";
    return;
  }

  if (!audit.ok) {
    stamp.textContent = "last run failed";
    totalsBox.innerHTML = "";
    rowsBox.innerHTML = `<p class="audit-empty">${esc(audit.error || "The audit failed.")}</p>`;
    notesBox.innerHTML = "";
    return;
  }

  const t = audit.totals || {};
  const when = audit.checkedAt ? ago(audit.checkedAt) : "";
  stamp.textContent = `${audit.name || audit.batch} · ${when}${audit.ms ? ` · ${auditFmt(audit.ms)}` : ""}`;

  // Six tiles, in the order they matter. `pending` is deliberately not red: it
  // is the expected state for a live class, and colouring it red would train an
  // operator to ignore red.
  const tiles = [
    ["plays", t.plays, "playing"],
    ["pending", t.pending, "not published"],
    ["no-stream", t["no-stream"], "refused"],
    ["broken", t.broken, "no video"],
    ["unknown", t.unknown, "unreadable"],
  ].filter(([, n]) => n !== undefined);

  totalsBox.innerHTML = tiles
    .map(
      ([state, n, label]) => `
      <div class="audit-total is-${state}">
        <strong>${Number(n || 0).toLocaleString()}</strong>
        <span>${esc(label)}</span>
      </div>`
    )
    .join("");

  // Worst-first, and *stable*: a re-render every 1.5 s must not shuffle rows
  // under the operator's cursor, so ties keep their original order.
  const rows = (audit.lectures || [])
    .map((lecture, index) => ({ lecture, index }))
    .sort(
      (a, b) =>
        (AUDIT_ORDER[a.lecture.state] ?? 9) - (AUDIT_ORDER[b.lecture.state] ?? 9) ||
        a.index - b.index
    )
    .map((row) => row.lecture);

  rowsBox.innerHTML = rows.length
    ? rows
        .map(
          (l) => `
      <div class="audit-row" data-id="${esc(l.id)}">
        <span class="audit-state ${esc(l.state)}">${esc(AUDIT_STATE_LABELS[l.state] || l.state)}</span>
        <span class="audit-title" title="${escAttr(l.title || l.id)}">${esc(l.title || l.id)}</span>
        <span class="audit-detail" title="${escAttr(l.detail || l.chapterName || "")}">${esc(
          l.detail || l.chapterName || ""
        )}</span>
        <button class="audit-rescan" type="button"
          data-batch="${escAttr(l.batch || audit.batch)}"
          data-subject="${escAttr(l.subject || "")}"
          data-id="${escAttr(l.id)}"
          data-title="${escAttr(l.title || "")}"
          aria-label="Re-check ${escAttr(l.title || l.id)}">re-check</button>
      </div>`
        )
        .join("")
    : `<p class="audit-empty">No lectures came back for this batch.</p>`;

  notesBox.innerHTML = (audit.notes || [])
    .map((n) => `<li>${esc(n)}</li>`)
    .join("");
}

/** Re-check one row without re-running the whole batch. */
async function rescan(row, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "…";
  try {
    const res = await fetch("/api/admin?action=rescan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": token },
      body: JSON.stringify({
        batch: row.dataset.batch,
        subject: row.dataset.subject,
        id: row.dataset.id,
        title: row.dataset.title,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      token = "";
      sessionStorage.removeItem(TOKEN_KEY);
      showGate("Your session ended. Sign in again.");
      return;
    }
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

    // Patch the row in place rather than re-rendering: a re-render would lose
    // the operator's scroll position halfway down a long list.
    const lecture = data.lecture || {};
    if (auditState && Array.isArray(auditState.lectures)) {
      const at = auditState.lectures.findIndex((l) => l.id === lecture.id);
      if (at >= 0) auditState.lectures[at] = { ...auditState.lectures[at], ...lecture };
    }
    renderAudit(auditState, { keepScroll: true });
  } catch (error) {
    btn.textContent = "failed";
    btn.title = error.message;
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  } finally {
    btn.disabled = false;
  }
}

$("#auditRows")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".audit-rescan");
  if (!btn) return;
  rescan(btn.closest(".audit-row"), btn);
});

/** Poll the audit route while a sweep is running on the server. */
function startAuditPolling() {
  stopAuditPolling();
  auditPoll = setInterval(async () => {
    try {
      const res = await fetch("/api/admin?action=audit", { headers: { "x-admin-token": token } });
      if (res.status === 401) return stopAuditPolling();
      const data = await res.json();
      if (!data.success) return;
      const bar = $("#auditProgress");
      if (data.running && data.progress) {
        const { done, total, last } = data.progress;
        bar.hidden = false;
        $("#auditBarFill").style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
        $("#auditProgressText").textContent =
          `Checked ${done} of ${total}` + (last ? ` — ${last}` : "");
      } else {
        bar.hidden = true;
        stopAuditPolling();
        if (data.audit) renderAudit(data.audit);
      }
    } catch {
      /* a poll failing is not worth a message; the next one may succeed */
    }
  }, 1500);
}

function stopAuditPolling() {
  if (auditPoll) clearInterval(auditPoll);
  auditPoll = null;
}

$("#auditForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const batch = $("#auditBatch").value.trim();
  const limit = Number($("#auditLimit").value) || 40;
  const err = $("#auditError");
  const btn = $("#auditRun");

  if (!batch) {
    err.textContent = "Paste a batch id first.";
    err.hidden = false;
    return;
  }

  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Auditing…";
  $("#auditProgress").hidden = false;
  $("#auditBarFill").style.width = "0%";
  $("#auditProgressText").textContent = "Starting…";
  startAuditPolling();

  try {
    const res = await fetch("/api/admin?action=audit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": token },
      body: JSON.stringify({ batch, limit }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      token = "";
      sessionStorage.removeItem(TOKEN_KEY);
      showGate("Your session ended. Sign in again.");
      return;
    }
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    renderAudit(data.audit);
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    stopAuditPolling();
    $("#auditProgress").hidden = true;
    btn.disabled = false;
    btn.textContent = "Run audit";
  }
});

/** Ask once on load for the last report, so a reload does not start over. */
async function loadAudit() {
  if (!token) return;
  try {
    const res = await fetch("/api/admin?action=audit", { headers: { "x-admin-token": token } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success) return;
    if (data.running) {
      $("#auditProgress").hidden = false;
      startAuditPolling();
    }
    renderAudit(data.audit);
  } catch {
    /* the panel still works without a previous audit */
  }
}

/* ------------------------------------------------------------------- dpp */

/**
 * The DPP panel.
 *
 * The papers are real but the *questions* are not always readable: Physics
 * Wallah serves the index to a guest and the paper to a paid session. So the
 * list is the primary object here and opening a paper is a best effort — when
 * it is locked the panel says exactly that, rather than showing an empty test.
 */

let dppPage = 1;

function dppError(message) {
  const box = $("#dppError");
  if (!box) return;
  box.textContent = message || "";
  box.hidden = !message;
}

const dppQ = (value) => encodeURIComponent(String(value || "").trim());

function fmtMinutes(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 60 ? `${Math.round((n / 60) * 10) / 10} h` : `${n} min`;
}

/** Load the subjects of a batch into the picker. `subjects[].id` is the key. */
async function loadDppSubjects() {
  const batch = $("#dppBatch").value.trim();
  const picker = $("#dppSubject");
  if (!batch) {
    dppError("Paste a batch id first.");
    return;
  }
  dppError("");
  picker.disabled = true;
  picker.innerHTML = `<option value="">Loading subjects…</option>`;
  try {
    const res = await fetch(`/api/batch?id=${dppQ(batch)}`);
    const data = await res.json();
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    if (!subjects.length) {
      picker.innerHTML = `<option value="">No subjects in this batch</option>`;
      dppError("That batch has no subjects — check the id.");
      return;
    }
    // Built in a helper rather than a nested template: a second backtick inside
    // `${…}` trips the page-module checker, which strips literals line-blind.
    const optionLabel = (s) => {
      const count = Number(s.lectureCount) || 0;
      const suffix = count ? ` · ${count} lectures` : "";
      return `${s.name || s.slug || "Subject"}${suffix}`;
    };
    picker.innerHTML =
      `<option value="">Choose a subject…</option>` +
      subjects
        .map((s) => `<option value="${esc(s.id || "")}">${esc(optionLabel(s))}</option>`)
        .join("");
  } catch (err) {
    picker.innerHTML = `<option value="">Could not load subjects</option>`;
    dppError(err?.message || "The batch could not be read.");
  } finally {
    picker.disabled = false;
  }
}

async function loadDpps(page = 1) {
  const batch = $("#dppBatch").value.trim();
  const subject = $("#dppSubject").value;
  if (!batch) return dppError("Paste a batch id first.");
  if (!subject) return dppError("Choose a subject first.");

  dppPage = Math.max(1, Number(page) || 1);
  dppError("");
  $("#dppRun").disabled = true;
  $("#dppRun").textContent = "Reading…";
  try {
    const res = await fetch(
      `/api/admin?action=dpp&batch=${dppQ(batch)}&subject=${dppQ(subject)}&page=${dppPage}`,
      { headers: { "x-admin-token": token } }
    );
    const data = await res.json();
    if (!data.success) {
      $("#dppList").innerHTML = "";
      $("#dppHeadline").textContent = "";
      $("#dppPager").hidden = true;
      $("#dppStamp").textContent = "read failed";
      dppError(data.error || "The DPP list could not be read.");
      return;
    }
    renderDpps(data);
  } catch (err) {
    dppError(err?.message || "The DPP list could not be read.");
  } finally {
    $("#dppRun").disabled = false;
    $("#dppRun").textContent = "List DPPs";
  }
}

function renderDpps(data) {
  const items = data.items || [];
  $("#dppStamp").textContent = `${data.subject || "subject"} · page ${data.page || 1} of ${
    data.pages || 1
  }`;
  $("#dppHeadline").textContent = data.headline || "";

  $("#dppList").innerHTML = items.length
    ? items
        .map(
          (item) => `
      <li>
        <button class="dpp-row" type="button" data-id="${escAttr(item.id)}" data-name="${escAttr(
          item.name
        )}">
          <span class="dpp-serial">${esc(item.serial || item.displayOrder || "")}</span>
          <span class="dpp-name" title="${escAttr(item.name)}">${esc(item.name)}</span>
          <span class="dpp-meta">${item.questions ? `${Number(item.questions)} Q` : ""}${
            item.minutes ? ` · ${esc(fmtMinutes(item.minutes))}` : ""
          }</span>
        </button>
      </li>`
        )
        .join("")
    : `<li class="dpp-empty">No DPPs on this page.</li>`;

  $("#dppPager").hidden = (data.pages || 1) <= 1;
  $("#dppPageInfo").textContent = `${data.total || 0} papers · page ${data.page || 1}/${
    data.pages || 1
  }`;
  $("#dppPrev").disabled = (data.page || 1) <= 1;
  $("#dppNext").disabled = (data.page || 1) >= (data.pages || 1);
}

async function openDpp(id, name) {
  const paper = $("#dppPaper");
  const body = $("#dppPaperBody");
  paper.hidden = false;
  document.querySelector(".admin-dpp-body")?.classList.add("has-paper");
  $("#dppPaperName").textContent = name || "DPP";
  $("#dppPaperMeta").textContent = "Reading the paper…";
  body.innerHTML = "";

  try {
    const res = await fetch(`/api/admin?action=dpp-paper&id=${dppQ(id)}`, {
      headers: { "x-admin-token": token },
    });
    const data = await res.json();
    if (data.locked) {
      $("#dppPaperMeta").textContent = "locked";
      body.innerHTML = `<p class="dpp-locked-note">${esc(
        data.error ||
          "This paper needs a paid Physics Wallah session. Its questions cannot be shown to a guest."
      )}</p>`;
      return;
    }
    if (!data.success) {
      $("#dppPaperMeta").textContent = "could not read";
      body.innerHTML = `<p class="dpp-locked-note">${esc(
        data.error || "The paper could not be read."
      )}</p>`;
      return;
    }
    const questions = data.questions || [];
    $("#dppPaperMeta").textContent = [
      `${questions.length} question${questions.length === 1 ? "" : "s"}`,
      data.minutes ? fmtMinutes(data.minutes) : "",
      data.totalMarks ? `${data.totalMarks} marks` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    body.innerHTML = questions.length
      ? questions.map(renderQuestion).join("")
      : `<p class="dpp-locked-note">The paper came back empty. That is a data problem at the source, not a failure here.</p>`;
  } catch (err) {
    $("#dppPaperMeta").textContent = "could not read";
    body.innerHTML = `<p class="dpp-locked-note">${esc(
      err?.message || "The paper could not be read."
    )}</p>`;
  }
}

function renderQuestion(q) {
  const options = (q.options || [])
    .map(
      (opt, i) => `
      <li class="dpp-option${opt.correct ? " is-correct" : ""}">
        <span class="dpp-option-key">${esc(String.fromCharCode(65 + i))}</span>
        <span>${esc(opt.text)}</span>
      </li>`
    )
    .join("");
  return `
    <article class="dpp-question">
      <p class="dpp-question-text"><span class="dpp-question-num">${esc(q.number || "")}.</span>${esc(
        q.text
      )}</p>
      ${options ? `<ul class="dpp-options">${options}</ul>` : ""}
      ${q.answer ? `<p class="dpp-solution">${esc(q.answer)}</p>` : ""}
    </article>`;
}

function closeDpp() {
  $("#dppPaper").hidden = true;
  document.querySelector(".admin-dpp-body")?.classList.remove("has-paper");
}

$("#dppLoadSubjects")?.addEventListener("click", loadDppSubjects);
$("#dppForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  loadDpps(1);
});
$("#dppPrev")?.addEventListener("click", () => loadDpps(dppPage - 1));
$("#dppNext")?.addEventListener("click", () => loadDpps(dppPage + 1));
$("#dppPaperClose")?.addEventListener("click", closeDpp);
$("#dppList")?.addEventListener("click", (e) => {
  const row = e.target.closest(".dpp-row");
  if (!row) return;
  $("#dppList")
    .querySelectorAll('.dpp-row[aria-current="true"]')
    .forEach((el) => el.removeAttribute("aria-current"));
  row.setAttribute("aria-current", "true");
  openDpp(row.dataset.id, row.dataset.name);
});

/* ----------------------------------------------------- dpp papers & test */

/**
 * The papers, and the test runner.
 *
 * The quiz list above needs a paid student session, so it is mostly a catalogue.
 * The *papers* do not: PW serves one PDF per lecture to a guest, with the
 * questions and the answer key inside. `?action=dpp-paper&url=` reads that PDF
 * here (through this origin, never the browser's) and this code runs it as a
 * scored, timed test — answers stay off the page until submit.
 */

let dppPaperList = [];
const dppTest = {
  paper: null,
  answers: new Map(),
  startedAt: 0,
  endsAt: 0,
  timer: null,
  submitted: false,
  /** The marked attempt, as the server returned it. */
  result: null,
  /** index → { outcome } once submitted, for the per-question marks. */
  outcomes: new Map(),
  filter: "all",
};

function dppPapersError(message) {
  const box = $("#dppPapersError");
  if (!box) return;
  box.textContent = message || "";
  box.hidden = !message;
}

async function loadDppPapers() {
  const batch = $("#dppBatch").value.trim();
  const subject = $("#dppSubject").value;
  if (!batch) return dppPapersError("Paste a batch id first.");
  if (!subject) return dppPapersError("Choose a subject first.");

  dppPapersError("");
  const btn = $("#dppPapersLoad");
  btn.disabled = true;
  btn.textContent = "Finding papers…";
  try {
    const res = await fetch(
      `/api/admin?action=dpp-papers&batch=${dppQ(batch)}&subject=${dppQ(subject)}`,
      { headers: { "x-admin-token": token } }
    );
    const data = await res.json();
    if (!data.success) {
      dppPaperList = [];
      $("#dppPapers").innerHTML = "";
      $("#dppPapersStamp").textContent = "";
      dppPapersError(data.error || "The papers could not be listed.");
      return;
    }
    dppPaperList = data.papers || [];
    renderDppPapers(data);
  } catch (err) {
    dppPapersError(err?.message || "The papers could not be listed.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Load papers";
  }
}

function renderDppPapers(data) {
  const papers = data.papers || [];
  $("#dppPapersStamp").textContent = data.headline ? `· ${data.headline}` : "";

  if (!papers.length) {
    $("#dppPapers").innerHTML = `<li class="dpp-empty">${
      (data.notes || []).length
        ? esc(data.notes[0])
        : "No DPP papers in the chapters scanned."
    }</li>`;
    return;
  }

  $("#dppPapers").innerHTML = papers
    .map(
      (paper, index) => `
      <li>
        <button class="dpp-row" type="button" data-index="${index}">
          <span class="dpp-serial">${esc(paper.chapter ? paper.chapter.slice(0, 2) : "")}</span>
          <span class="dpp-name" title="${escAttr(paper.title)}">${esc(paper.title)}</span>
          <span class="dpp-meta">${esc(paper.chapter)}</span>
        </button>
      </li>`
    )
    .join("");
}

/** Open one paper and read it into a runnable test. */
async function openDppPaper(index) {
  const paper = dppPaperList[index];
  if (!paper) return;
  const block = $("#dppTestBlock");

  block.hidden = false;
  $("#dppTestTitle").textContent = paper.title;
  $("#dppTestMeta").textContent = "Reading the paper…";
  $("#dppTestQuestions").innerHTML = "";
  $("#dppTestResult").hidden = true;
  $("#dppTestResult").innerHTML = "";
  $("#dppTestClock").textContent = "—";
  // Guarded: not every environment that renders the panel has layout (jsdom
  // does not), and scrolling is a courtesy, not part of reading the paper.
  block.scrollIntoView?.({ behavior: "smooth", block: "start" });

  try {
    // The *public* practice route, deliberately: it hands out the questions and
    // withholds the key, so the panel runs the same test a student would. Reading
    // it through the admin route would send the answers with the questions, and
    // an operator cannot then tell a broken paper from a paper they have already
    // seen the key for.
    const res = await fetch(`/api/pdf?dpp=${dppQ(paper.url)}&name=${dppQ(paper.title)}`);
    const data = await res.json();
    if (!data.success) {
      $("#dppTestMeta").textContent = "could not read";
      $("#dppTestQuestions").innerHTML = `<p class="dpp-locked-note">${esc(
        data.error || "The paper could not be read."
      )}</p>`;
      return;
    }
    startDppTest(data, paper);
  } catch (err) {
    $("#dppTestMeta").textContent = "could not read";
    $("#dppTestQuestions").innerHTML = `<p class="dpp-locked-note">${esc(
      err?.message || "The paper could not be read."
    )}</p>`;
  }
}

function startDppTest(paper, meta) {
  dppTest.paper = paper;
  // Kept separately: `paper` is the payload, and the POST needs the URL it came
  // from. Assigning it onto the payload would send the key back to the server
  // inside the object the renderer iterates.
  dppTest.paperSourceUrl = meta?.url || paper.url || "";
  dppTest.answers = new Map();
  dppTest.submitted = false;
  dppTest.result = null;
  dppTest.outcomes = new Map();
  dppTest.filter = "all";
  $("#dppTestFilter").hidden = true;

  const runnable = (paper.questions || []).filter((q) => q.scorable);
  const stats = paper.stats || { total: 0, answerable: runnable.length };
  $("#dppTestMeta").textContent = [
    `${stats.total} question${stats.total === 1 ? "" : "s"}`,
    `${runnable.length} answerable`,
    paper.duration ? `${paper.duration} min` : "",
    paper.pages ? `${paper.pages} page${paper.pages === 1 ? "" : "s"}` : "",
    meta?.chapter || "",
  ]
    .filter(Boolean)
    .join(" · ");

  $("#dppTestQuestions").innerHTML = (paper.questions || [])
    .map((question, index) => renderTestQuestion(question, index))
    .join("");

  $("#dppTestSubmit").disabled = runnable.length === 0;
  updateTestProgress();

  // The clock is the paper's own time limit, not an invented one.
  const minutes = Number(paper.duration) || 0;
  if (minutes > 0) {
    dppTest.startedAt = Date.now();
    dppTest.endsAt = dppTest.startedAt + minutes * 60_000;
    startTestClock();
  } else {
    dppTest.endsAt = 0;
    $("#dppTestClock").textContent = "no limit";
  }
}

function renderTestQuestion(question, index) {
  const options = (question.options || [])
    .map(
      (option, optIndex) => `
      <label class="dpp-option dpp-choice">
        <input type="radio" name="q-${index}" value="${escAttr(option.letter)}"
          data-question="${index}" data-letter="${escAttr(option.letter)}" />
        <span class="dpp-option-key">${esc(option.letter)}</span>
        <span>${esc(option.text)}</span>
      </label>`
    )
    .join("");

  return `
    <article class="dpp-question" id="dpp-q-${index}" data-index="${index}">
      <p class="dpp-question-text"><span class="dpp-question-num">Q${esc(
        question.number
      )}</span>${esc(question.text)}</p>
      ${
        options
          ? `<div class="dpp-options">${options}</div>`
          : `<p class="dpp-solution">This question's options could not be recovered from the PDF, so it is not scored.</p>`
      }
      <p class="dpp-question-note tiny"></p>
    </article>`;
}

function updateTestProgress() {
  const total = (dppTest.paper?.questions || []).filter((q) => q.scorable).length;
  const answered = [...dppTest.answers.keys()].filter(
    (index) => dppTest.paper?.questions?.[index]?.scorable
  ).length;
  const progress = $("#dppTestProgress");
  if (dppTest.submitted && dppTest.result) {
    progress.textContent = `submitted · ${dppTest.result.percent}%`;
    return;
  }
  progress.textContent = `${answered} of ${total} answered`;
}

function startTestClock() {
  clearInterval(dppTest.timer);
  const tick = () => {
    const left = Math.max(0, dppTest.endsAt - Date.now());
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    const clock = $("#dppTestClock");
    if (!clock) return;
    clock.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    clock.classList.toggle("is-low", left <= 60000);
    // Running out of time submits, which is what a real paper does.
    if (!left && !dppTest.submitted) submitDppTest();
  };
  tick();
  dppTest.timer = setInterval(tick, 1000);
}

function stopTestClock() {
  clearInterval(dppTest.timer);
  dppTest.timer = null;
}

/**
 * Submit the attempt and show the analysis.
 *
 * The marking is the server's, not this file's: answers go to
 * `POST /api/pdf?dpp=…`, which reads the paper again and marks against its own
 * key. Marking in the browser would mean the key has to be *in* the browser,
 * which is the one thing the practice route exists to avoid — and it is why the
 * questions arrive without their answers.
 *
 * The per-question marks are still painted here, from the server's verdict, so a
 * wrong answer shows what the right one was on the paper itself.
 */
async function submitDppTest() {
  if (dppTest.submitted || !dppTest.paper) return;
  dppTest.submitted = true;
  stopTestClock();
  const button = $("#dppTestSubmit");
  button.disabled = true;
  button.textContent = "Marking…";

  let data = null;
  try {
    const res = await fetch(`/api/pdf?dpp=${dppQ(dppTest.paperSourceUrl)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: Object.fromEntries(dppTest.answers),
        elapsedMs: Math.max(0, Date.now() - dppTest.startedAt),
      }),
    });
    data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "The paper could not be marked.");
  } catch (err) {
    // A failed marking must not eat the attempt: unlock the paper so it can be
    // submitted again, and say what happened.
    dppTest.submitted = false;
    button.disabled = false;
    button.textContent = "Submit test";
    dppTest.startedAt = dppTest.startedAt || Date.now();
    if (dppTest.endsAt) startTestClock();
    $("#dppTestProgress").textContent = "marking failed — try again";
    $("#dppTestResult").hidden = false;
    $("#dppTestResult").innerHTML = `<p class="dpp-locked-note">${esc(
      err?.message || "The paper could not be marked."
    )}</p>`;
    return;
  }

  dppTest.result = data.result;
  dppTest.outcomes = new Map((data.review || []).map((row) => [row.index, row]));

  (dppTest.paper.questions || []).forEach((question, index) => {
    const row = document.getElementById(`dpp-q-${index}`);
    if (!row) return;
    const chosen = dppTest.answers.get(index) || "";
    const verdict = dppTest.outcomes.get(index);
    const note = row.querySelector(".dpp-question-note");

    row.querySelectorAll("input[type=radio]").forEach((input) => {
      input.disabled = true;
      const letter = input.getAttribute("data-letter");
      const label = input.closest("label");
      if (question.scorable && letter === verdict?.answer) label.classList.add("is-correct");
      if (question.scorable && letter === chosen && chosen !== verdict?.answer) {
        label.classList.add("is-wrong");
      }
      if (letter === chosen) input.checked = true;
    });

    if (!verdict) {
      note.textContent = "";
      return;
    }
    const labels = {
      correct: ["Correct", "dpp-question-note tiny is-ok"],
      wrong: [`Wrong · answer is ${verdict.answer}`, "dpp-question-note tiny is-bad"],
      skipped: [`Not answered · answer is ${verdict.answer}`, "dpp-question-note tiny dim"],
      unscored: [
        verdict.answer
          ? `Not scorable from the PDF · the key says ${verdict.answer}`
          : "No answer in the paper's key for this question.",
        "dpp-question-note tiny dim",
      ],
    };
    const [text, className] = labels[verdict.outcome] || ["", "dpp-question-note tiny"];
    note.textContent = text;
    note.className = className;
  });

  renderTestResult(data);
  button.textContent = "Submitted";
  updateTestProgress();
}

/** The scorecard and the review list, once the server has marked the paper. */
function renderTestResult(data) {
  const result = data.result || {};
  const box = $("#dppTestResult");
  box.hidden = false;
  box.innerHTML = `
    <div class="dpp-score">
      <div class="dpp-score-main">
        <strong>${Number(result.correct) || 0}</strong>
        <span>of ${Number(result.scored) || 0} correct</span>
      </div>
      <div class="dpp-score-detail">
        <span class="is-ok">${Number(result.correct) || 0} correct</span>
        <span class="is-bad">${Number(result.wrong) || 0} wrong</span>
        <span class="dim">${Number(result.skipped) || 0} skipped</span>
        ${result.unscored ? `<span class="dim">${result.unscored} not scorable</span>` : ""}
        <span class="dim">${Number(result.percent) || 0}%</span>
      </div>
    </div>
    ${
      result.focus && result.focus.length
        ? `<p class="tiny dim mt-2">Worth another look: ${result.focus
            .map((n) => `Q${esc(n)}`)
            .join(", ")}.</p>`
        : ""
    }`;

  $("#dppTestFilter").hidden = !(data.review || []).length;
  renderDppReview();
}

/** The review list, filtered — the analysis half of the panel's runner. */
function renderDppReview() {
  const rows = [];
  (dppTest.paper?.questions || []).forEach((question, index) => {
    const verdict = dppTest.outcomes.get(index);
    if (!verdict) return;
    if (dppTest.filter !== "all" && verdict.outcome !== dppTest.filter) return;
    rows.push({ question, verdict });
  });

  const host = $("#dppTestReview");
  if (!rows.length) {
    host.innerHTML = `<p class="tiny dim dpp-empty">${
      dppTest.filter === "wrong" ? "No wrong answers." : "Nothing was left blank."
    }</p>`;
    return;
  }

  const LABELS = {
    correct: ["Correct", "is-ok"],
    wrong: ["Wrong", "is-bad"],
    skipped: ["Not answered", "dim"],
    unscored: ["Not scorable", "dim"],
  };

  host.innerHTML = rows
    .map(({ question, verdict }) => {
      const [label, tone] = LABELS[verdict.outcome] || ["—", "dim"];
      const options = (verdict.options || [])
        .map((option) => {
          const isAnswer = verdict.outcome !== "unscored" && option.letter === verdict.answer;
          const isChosen = option.letter === verdict.chosen;
          const cls = [
            "dpp-option",
            isAnswer ? "is-correct" : "",
            isChosen && !isAnswer ? "is-wrong" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<li class="${cls}">
            <span class="dpp-option-key">${esc(option.letter)}</span>
            <span>${esc(option.text)}</span>
            ${isAnswer ? `<span class="dpp-rev-tag">key</span>` : ""}
          </li>`;
        })
        .join("");
      return `
        <article class="dpp-question dpp-rev is-${verdict.outcome}">
          <header class="dpp-rev-head">
            <span class="dpp-question-num">Q${esc(question.number)}</span>
            <span class="dpp-rev-badge ${tone}">${esc(label)}</span>
          </header>
          <p class="dpp-question-text">${esc(question.text || "—")}</p>
          ${options ? `<ul class="dpp-options">${options}</ul>` : ""}
          <p class="tiny dim">${
            verdict.outcome === "correct"
              ? `You answered ${esc(verdict.chosen)}.`
              : verdict.answer
                ? `You answered ${esc(verdict.chosen || "nothing")}; the key says ${esc(verdict.answer)}.`
                : "This question has no answer in the paper's key."
          }</p>
        </article>`;
    })
    .join("");
}

$("#dppTestFilter")?.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-filter]");
  if (!tab) return;
  dppTest.filter = tab.dataset.filter;
  $("#dppTestFilter")
    .querySelectorAll("[data-filter]")
    .forEach((el) => el.classList.toggle("active", el === tab));
  renderDppReview();
});

function closeDppTest() {
  stopTestClock();
  dppTest.paper = null;
  dppTest.paperSourceUrl = "";
  dppTest.answers = new Map();
  dppTest.submitted = false;
  $("#dppTestBlock").hidden = true;
}

$("#dppPapersLoad")?.addEventListener("click", loadDppPapers);
$("#dppPapers")?.addEventListener("click", (e) => {
  const row = e.target.closest(".dpp-row");
  if (!row) return;
  openDppPaper(Number(row.dataset.index));
});
$("#dppTestForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  submitDppTest();
});
$("#dppTestClose")?.addEventListener("click", closeDppTest);
$("#dppTestQuestions")?.addEventListener("change", (e) => {
  const input = e.target.closest("input[type=radio]");
  if (!input) return;
  dppTest.answers.set(Number(input.dataset.question), input.value);
  updateTestProgress();
});

/* ------------------------------------------------------------------ boot */

// An existing token may still be valid: check before showing the gate, so a
// refresh does not force the operator through the password again.
if (token) {
  fetch("/api/admin?action=whoami", { headers: { "x-admin-token": token } })
    .then((res) => res.json().then((d) => ({ ok: res.ok && d.signedIn })))
    .catch(() => ({ ok: false }))
    .then(({ ok }) => {
      if (!ok) {
        token = "";
        sessionStorage.removeItem(TOKEN_KEY);
        showGate("Your session has ended. Sign in again.");
        return;
      }
      showPanel();
      load();
      loadAudit();
      startPolling();
    });
} else {
  showGate();
}
