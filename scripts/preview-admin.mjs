/**
 * Local-only render check for the admin panel.
 *
 * There is no browser in this sandbox, so the panel is rendered as a static SVG
 * using the site's own stylesheet and real data from the running dev server.
 * This is not pixel-identical to a browser, but it catches the things a
 * screenshot is used for: does the type hold together, do the blocks line up, is
 * anything overflowing, is the contrast right.
 *
 *   node scripts/preview-admin.mjs /tmp/live.json design/admin-panel.png
 *
 * Not part of the build or the tests.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const [, , dataFile = "/tmp/live.json", outFile = "design/admin-panel.png"] = process.argv;
const data = JSON.parse(await readFile(dataFile, "utf8"));
const css = await readFile(path.resolve("public/assets/arsvibe.css"), "utf8");

/* Tokens, read straight out of the stylesheet so the preview cannot drift. */
const token = (name, fallback) => {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : fallback;
};
const C = {
  paper2: token("paper-2", "#e5eaf0"),
  card: token("card", "#f8fafc"),
  card2: token("card-2", "#ffffff"),
  ink: token("ink", "#0d1a2b"),
  ink2: token("ink-2", "#35485f"),
  ink3: token("ink-3", "#5f7288"),
  ink4: token("ink-4", "#8595a8"),
  rule: token("rule", "#c9d3de"),
  rule2: token("rule-2", "#aebbc9"),
  blue: token("blue", "#1c55c8"),
  ok: token("ok", "#0f7a58"),
  amber: token("amber", "#a9700c"),
  danger: token("danger", "#b0232b"),
};
const FONT = 'font-family="Inter, Helvetica, Arial, sans-serif"';
const MONO = 'font-family="ui-monospace, Menlo, monospace"';
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const W = 1180;
const parts = [];

const rect = (x, y, w, h, fill, stroke = "", r = 4) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ""}/>`;
const text = (x, y, s, { size = 12, fill = C.ink, weight = 400, anchor = "start", font = FONT } = {}) =>
  `<text x="${x}" y="${y}" ${font} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

/* ---------------------------------------------------------------- header */
parts.push(rect(0, 0, W, 52, C.card, C.rule2, 0));
parts.push(rect(24, 16, 20, 20, C.blue, "", 3));
parts.push(text(52, 31, "ArsVibe Admin", { size: 14, weight: 650 }));
parts.push(rect(168, 17, 74, 18, C.card2, C.rule2, 9));
parts.push(text(205, 30, "PRODUCTION", { size: 9, weight: 600, fill: C.ink3, anchor: "middle", font: MONO }));
parts.push(`<circle cx="${W - 300}" cy="26" r="4" fill="${C.ok}"/>`);
parts.push(text(W - 288, 30, "live", { size: 11, weight: 600, fill: C.ink3 }));
parts.push(text(W - 236, 30, "updated 09:32:11", { size: 11, fill: C.ink4 }));
parts.push(rect(W - 150, 15, 60, 22, C.card2, C.rule2, 3));
parts.push(text(W - 120, 30, "Refresh", { size: 11, anchor: "middle", fill: C.ink2 }));
parts.push(rect(W - 82, 15, 62, 22, C.card2, C.rule2, 3));
parts.push(text(W - 51, 30, "Sign out", { size: 11, anchor: "middle", fill: C.ink2 }));

/* ------------------------------------------------------------------ hero */
const heroY = 76;
parts.push(rect(24, heroY, W - 48, 116, C.card, C.rule2, 4));
parts.push(text(44, heroY + 26, "SITE STATUS", { size: 9, weight: 650, fill: C.ink3 }));
const failing = data.health.filter((h) => !h.ok && !h.soft && !h.skipped).length;
parts.push(
  text(44, heroY + 54, failing ? `${failing} checks failing` : "All systems operational", {
    size: 26,
    weight: 680,
    fill: failing ? C.danger : C.ok,
  })
);
const slowest = [...data.health].filter((h) => !h.skipped).sort((a, b) => b.ms - a.ms)[0];
const failingNames = data.health.filter((h) => !h.ok && !h.soft && !h.skipped).map((h) => h.name);
parts.push(
  text(
    44,
    heroY + 78,
    failing
      ? `Failing: ${failingNames.join(", ")}. ${data.health.find((h) => failingNames.includes(h.name))?.detail || ""}`
      : `Every probe answered. Slowest: ${slowest.name} at ${slowest.ms} ms.`,
    { size: 11.5, fill: C.ink3 }
  )
);
parts.push(text(44, heroY + 96, data.trafficNote, { size: 10.5, fill: C.ink4 }));

const t = data.traffic;
const stats = [
  ["Requests", t.requests.toLocaleString(), "since this instance started"],
  ["Errors", t.errors.toLocaleString(), `${t.errorRate}% of requests`],
  ["Page views", t.pages.toLocaleString(), "public HTML pages served"],
  ["Live sessions", String(t.liveSessions), "signed-in admins"],
];
const sx = 470;
const sw = 152;
stats.forEach(([label, value, hint], i) => {
  const x = sx + i * (sw + 12);
  parts.push(rect(x, heroY + 26, sw, 74, C.card2, C.rule, 4));
  parts.push(text(x + 12, heroY + 52, value, { size: 19, weight: 680 }));
  parts.push(text(x + 12, heroY + 70, label, { size: 10, weight: 600, fill: C.ink3 }));
  parts.push(text(x + 12, heroY + 86, hint, { size: 9, fill: C.ink4 }));
});

/* ----------------------------------------------------------------- grid */
const gap = 14;
const colW = (W - 48 - gap) / 2;
const leftX = 24;
const rightX = 24 + colW + gap;

const block = (x, y, h, title, hint = "") => {
  parts.push(rect(x, y, colW, h, C.card, C.rule2, 4));
  parts.push(text(x + 18, y + 28, title, { size: 14, weight: 650 }));
  if (hint) parts.push(text(x + colW - 18, y + 28, hint, { size: 10, fill: C.ink4, anchor: "end" }));
};

/* ---- health ---- */
let y1 = heroY + 132;
const healthH = data.health.length * 34 + 92;
block(leftX, y1, healthH, "API & host health", `${data.health.filter((h) => (h.ok || h.soft) && !h.skipped).length}/${data.health.filter((h) => !h.skipped).length} passing`);
let hy = y1 + 50;
for (const h of data.health) {
  const color = h.skipped ? C.ink4 : h.ok ? C.ok : h.soft ? C.amber : C.danger;
  parts.push(`<circle cx="${leftX + 22}" cy="${hy - 4}" r="4.5" fill="${color}"/>`);
  parts.push(text(leftX + 36, hy, h.name, { size: 12, weight: 600 }));
  parts.push(
    text(leftX + 36, hy + 14, h.detail || (h.kind === "index" ? `${h.count.toLocaleString()} batches indexed` : "responded"), {
      size: 9.5,
      fill: C.ink4,
    })
  );
  parts.push(text(leftX + colW - 18, hy, h.skipped ? "skipped" : `${h.ms} ms`, { size: 10, fill: C.ink3, anchor: "end", font: MONO }));
  parts.push(`<line x1="${leftX + 18}" y1="${hy + 22}" x2="${leftX + colW - 18}" y2="${hy + 22}" stroke="${C.rule}" stroke-width="1"/>`);
  hy += 34;
}
const tk = data.token;
const tokenY = y1 + healthH - 44;
parts.push(rect(leftX + 18, tokenY - 12, colW - 36, 30, C.card2, C.rule, 4));
parts.push(text(leftX + 30, tokenY + 7, "Upstream token", { size: 9.5, fill: C.ink4 }));
parts.push(text(leftX + 112, tokenY + 7, tk.source, { size: 10.5, weight: 600 }));
parts.push(
  rect(leftX + colW - 78, tokenY - 4, 58, 16, tk.usable ? "rgba(15,122,88,.12)" : "rgba(176,35,43,.12)", "", 8)
);
parts.push(
  text(leftX + colW - 49, tokenY + 7, tk.usable ? "usable" : "missing", {
    size: 8.5,
    fill: tk.usable ? C.ok : C.danger,
    anchor: "middle",
    font: MONO,
  })
);
parts.push(text(
  leftX + 30,
  tokenY + 26,
  `${tk.expiresAt ? `expires ${new Date(tk.expiresAt).toLocaleTimeString()} (in ${Math.round((tk.expiresIn || 0) / 60)} min)` : "no expiry claim"} · ${tk.prefix || "no token"} · ${data.credentials.length} in the ladder`,
  { size: 9, fill: C.ink4 }
));

/* ---- traffic ---- */
block(rightX, y1, healthH, "Traffic", "this server instance");
const svgW = colW - 36;
const series = data.traffic.series;
const max = Math.max(1, ...series);
const pts = series.map((v, i) => [
  (i / (series.length - 1)) * svgW,
  62 - (v / max) * 54,
]);
const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
parts.push(`<g transform="translate(${rightX + 18} ${y1 + 44})">`);
parts.push(`<path d="${line} L${svgW} 62 L0 62 Z" fill="rgba(28,85,200,.14)"/>`);
parts.push(`<path d="${line}" fill="none" stroke="${C.blue}" stroke-width="1.75"/>`);
parts.push(`</g>`);
parts.push(text(rightX + 18, y1 + 122, "30 min ago", { size: 9, fill: C.ink4 }));
parts.push(text(rightX + 18 + svgW / 2, y1 + 122, `${series[series.length - 1] || 0} req in the last minute`, { size: 9, fill: C.ink4, anchor: "middle" }));
parts.push(text(rightX + 18 + svgW, y1 + 122, "now", { size: 9, fill: C.ink4, anchor: "end" }));
const answered = Object.entries(t.byStatus).filter(([c]) => +c > 0).reduce((s, [, n]) => s + n, 0);
const okCount = Object.entries(t.byStatus).filter(([c]) => +c >= 200 && +c < 400).reduce((s, [, n]) => s + n, 0);
const kv = [
  ["Success rate", `${answered ? Math.round((okCount / answered) * 100) : 100}%`],
  ["Data requests", t.apiRequests.toLocaleString()],
  ["Bytes served", `${(t.bytesOut / 1048576).toFixed(1)} MB`],
  ["Server errors", Object.entries(t.byStatus).filter(([c]) => +c >= 500).map(([c, n]) => `${c}×${n}`).join(" ") || "none"],
];
kv.forEach(([k, v], i) => {
  const yy = y1 + 146 + i * 20;
  parts.push(text(rightX + 18, yy, k, { size: 10.5, fill: C.ink3 }));
  parts.push(text(rightX + colW - 18, yy, v, { size: 10.5, weight: 600, anchor: "end" }));
  parts.push(`<line x1="${rightX + 18}" y1="${yy + 6}" x2="${rightX + colW - 18}" y2="${yy + 6}" stroke="${C.rule}" stroke-width="1"/>`);
});

/* ---- routes ---- */
const y2 = y1 + healthH + 14;
block(leftX, y2, 176, "Requests by route");
const routes = Object.entries(t.byRoute).sort((a, b) => b[1] - a[1]);
const rmax = Math.max(1, ...routes.map(([, n]) => n));
routes.forEach(([route, n], i) => {
  const yy = y2 + 54 + i * 25;
  parts.push(text(leftX + 18, yy, route, { size: 10, fill: C.ink3, font: MONO }));
  const tx = leftX + 106;
  const tw = colW - 106 - 70;
  parts.push(rect(tx, yy - 8, tw, 7, C.paper2, "", 4));
  parts.push(rect(tx, yy - 8, Math.max(3, (n / rmax) * tw), 7, C.blue, "", 4));
  parts.push(text(leftX + colW - 18, yy, String(n), { size: 10, fill: C.ink2, anchor: "end", font: MONO }));
});

/* ---- logs + release + runtime ---- */
block(rightX, y2, 176, "Slowest");
const logs = t.slowest.length ? t.slowest : t.lastErrors;
logs.slice(0, 4).forEach((row, i) => {
  const yy = y2 + 54 + i * 27;
  parts.push(text(rightX + 18, yy, row.route, { size: 10.5, font: MONO, fill: row.ms > 2500 ? C.danger : C.ink }));
  parts.push(text(rightX + colW - 18, yy, `${row.ms} ms · ${row.status ? `HTTP ${row.status}` : "no answer"}`, { size: 10, fill: C.ink4, anchor: "end" }));
  parts.push(`<line x1="${rightX + 18}" y1="${yy + 8}" x2="${rightX + colW - 18}" y2="${yy + 8}" stroke="${C.rule}" stroke-width="1"/>`);
});

const y3 = y2 + 190;
block(leftX, y3, 176, "Deployment");
const rel = [
  ["Commit", data.release.commit ? `${data.release.commitShort} (${data.release.ref || "—"})` : "local"],
  ["Environment", data.release.env],
  ["Region", data.release.region || "—"],
  ["Node", data.release.node],
];
rel.forEach(([k, v], i) => {
  const yy = y3 + 54 + i * 24;
  parts.push(text(leftX + 18, yy, k, { size: 10.5, fill: C.ink3 }));
  parts.push(text(leftX + colW - 18, yy, v, { size: 10.5, weight: 600, anchor: "end" }));
  parts.push(`<line x1="${leftX + 18}" y1="${yy + 7}" x2="${leftX + colW - 18}" y2="${yy + 7}" stroke="${C.rule}" stroke-width="1"/>`);
});

block(rightX, y3, 176, "Runtime & data");
const rt = [
  ["Uptime", `${Math.round(data.uptimeSeconds / 60)}m ${data.uptimeSeconds % 60}s`],
  ["Memory (RSS)", `${data.runtime.memoryMb} MB`],
  ["Catalogue", `${data.catalogue.batches.toLocaleString()} batches`],
  ["Admin sessions", String(t.liveSessions)],
];
rt.forEach(([k, v], i) => {
  const yy = y3 + 54 + i * 24;
  parts.push(text(rightX + 18, yy, k, { size: 10.5, fill: C.ink3 }));
  parts.push(text(rightX + colW - 18, yy, v, { size: 10.5, weight: 600, anchor: "end" }));
  parts.push(`<line x1="${rightX + 18}" y1="${yy + 7}" x2="${rightX + colW - 18}" y2="${yy + 7}" stroke="${C.rule}" stroke-width="1"/>`);
});

const H = y3 + 200;
parts.push(text(W / 2, H - 14, data.trafficNote, { size: 9.5, fill: C.ink4, anchor: "middle" }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${rect(0, 0, W, H, C.paper2, "", 0)}
${parts.join("\n")}
</svg>`;

await writeFile("/tmp/admin-panel.svg", svg);
const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
await writeFile(outFile, png);
console.log(`wrote ${outFile} (${W}×${H}, ${(png.length / 1024).toFixed(0)} KB)`);
