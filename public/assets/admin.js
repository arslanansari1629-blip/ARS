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
      startPolling();
    });
} else {
  showGate();
}
