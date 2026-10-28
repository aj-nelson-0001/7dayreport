#!/usr/bin/env node
/**
 * Export the current project list as a standalone HTML page.
 *
 *   node export-projects.js            # writes public/projects.html
 *   OUT=/tmp/p.html node export-projects.js
 *
 * Reuses the same scanner the dashboard's /api/projects route uses, so the
 * page shows exactly what the dashboard shows: one row per directory under
 * PROJECTS_ROOT, grouped by derived status, each with its README one-liner.
 * Styled with the same black/amber palette as AI_Dashboard/index.html.
 * Zero npm dependencies.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProjects } from "./projects.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(__dirname, "public", "projects.html");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const GROUPS = [
  ["active", "Active", "activity within 3 days", "st-active"],
  ["recent", "Recent", "activity within 14 days", "st-recent"],
  ["dormant", "Dormant", "no activity for over 14 days", "st-dormant"],
  ["archived", "Archived", "archived or dated investigation track", "st-archived"],
];

const data = await getProjects({ force: true });

const groups = GROUPS.map(([key, label, note, cls]) => ({
  key,
  label,
  note,
  cls,
  items: data.projects.filter((p) => p.status === key),
})).filter((g) => g.items.length);

const rows = groups
  .map(
    (g) => `
  <section class="section">
    <div class="section-head">
      <div>
        <h3>${esc(g.label)}</h3>
        <p>${esc(g.note)}</p>
      </div>
      <div class="count">${g.items.length} PROJECT${g.items.length === 1 ? "" : "S"}</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Project</th><th>Description</th><th>Facts</th></tr></thead>
        <tbody>
${g.items
  .map((p) => {
    const desc = p.description.replace(/\s+/g, " ").trim();
    const meta = [
      p.kind === "git" ? `git · ${esc(p.git?.branch || "no branch")}` : "directory",
      p.activityDate ? `last activity ${esc(p.activityDate)}` : "no activity recorded",
      p.kind === "git" && p.git?.commits != null ? `${p.git.commits} commits` : null,
      p.docs.length ? `${p.docs.length} progress doc${p.docs.length > 1 ? "s" : ""}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `          <tr>
            <td><span class="st ${g.cls}">${esc(p.name)}</span></td>
            <td>${desc ? esc(desc) : '<em class="muted">no README description</em>'}</td>
            <td class="facts">${meta}</td>
          </tr>`;
  })
  .join("\n")}
        </tbody>
      </table>
    </div>
  </section>`
  )
  .join("\n");

const c = data.counts;
const generated = new Date().toISOString().slice(0, 16).replace("T", " ");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#080807">
<title>Projects — 7dayreport export</title>
<style>
:root {
  color-scheme: dark;
  --bg: #080807; --panel: #11110e; --panel2: #17150f; --line: #332714;
  --yellow: #ffd447; --orange: #ff922e; --cream: #fff4cc; --muted: #a89d80;
  --green: #a8d987; --red: #ff765e; --radius: 18px; --shadow: 0 18px 60px #0007;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0; color: var(--cream);
  background:
    radial-gradient(ellipse at 90% -10%, #5b371a45, transparent 34rem),
    radial-gradient(ellipse at -10% 20%, #6b5a1628, transparent 32rem),
    var(--bg);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
  min-height: 100vh;
}
.wrap { max-width: 1100px; margin: auto; padding: 38px 26px 72px; }
.top { display: flex; align-items: center; justify-content: space-between;
       gap: 20px; margin-bottom: 34px; }
.brand { display: flex; align-items: center; gap: 14px; }
.mark { width: 42px; height: 42px; border-radius: 13px; display: grid;
        place-items: center; color: #171107; font-weight: 1000;
        background: linear-gradient(145deg, var(--yellow), var(--orange));
        box-shadow: 0 6px 26px #ffb3223d; }
.brand h1 { font-size: 16px; letter-spacing: .04em; margin: 0; color: var(--cream); }
.brand p { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.updated { font-size: 12px; color: var(--muted); text-align: right; }
.updated strong { color: var(--yellow); font-weight: 650; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 26px; }
.tag { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px;
       border: 1px solid #56421d; border-radius: 100px; background: #211b0d;
       color: var(--yellow); font-size: 11px; font-weight: 750;
       letter-spacing: .05em; width: max-content; }
.tag:before { content: ""; width: 6px; height: 6px; border-radius: 50%;
              background: var(--yellow); box-shadow: 0 0 10px var(--yellow); }
.section { margin-top: 28px; }
.section-head { display: flex; justify-content: space-between; align-items: end;
                gap: 16px; margin-bottom: 14px; }
.section-head h3 { font-size: 21px; color: var(--yellow); margin: 0;
                   letter-spacing: -.025em; }
.section-head p { font-size: 12px; color: var(--muted); margin: 3px 0 0; }
.count { font-size: 11px; color: var(--orange); border: 1px solid #4b3118;
         background: #1d140d; padding: 6px 10px; border-radius: 999px;
         white-space: nowrap; }
.table-wrap { overflow: auto; border: 1px solid var(--line); background: #0e0e0c;
              border-radius: var(--radius); box-shadow: var(--shadow); }
table { width: 100%; border-collapse: collapse; min-width: 690px; }
th { text-align: left; text-transform: uppercase; letter-spacing: .1em;
     font-size: 10px; color: #a99b76; padding: 14px 18px;
     border-bottom: 1px solid var(--line); background: #14120e; }
td { padding: 13px 18px; border-bottom: 1px solid #262117; font-size: 13px;
     vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: #19160f; }
.st { display: inline-block; padding: 4px 9px; border-radius: 999px;
       font-family: ui-monospace, monospace; font-size: 12px; font-weight: 700;
       white-space: nowrap; }
.st-active   { background: #1c2815; color: var(--green); }
.st-recent   { background: #211b0d; color: var(--yellow); }
.st-dormant  { background: #2a1d0e; color: var(--orange); }
.st-archived { background: #1b1a16; color: var(--muted); }
.facts { color: var(--muted); font-size: 11px; white-space: nowrap;
         text-align: right; }
.muted { color: var(--muted); }
.footer { border-top: 1px solid #282217; margin-top: 38px; padding-top: 17px;
          display: flex; justify-content: space-between; gap: 12px;
          color: #837a66; font-size: 11px; }
.footer code { color: #d8c9a5; }
@media (max-width: 640px) {
  .wrap { padding: 22px 14px 48px; }
  .top { align-items: flex-start; }
  .facts { white-space: normal; text-align: left; }
}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="mark">P</div>
      <div>
        <h1>PROJECTS / ~/Projects</h1>
        <p>7dayreport export · same scanner as the dashboard's projects panel</p>
      </div>
    </div>
    <div class="updated">GENERATED<br><strong>${esc(generated)}</strong></div>
  </header>

  <div class="summary">
    <span class="tag">${c.total} PROJECTS</span>
    <span class="tag">${c.active7d} ACTIVE THIS WEEK</span>
    <span class="tag">${c.withDocs} WITH PROGRESS DOCS</span>
    <span class="tag">${c.git} GIT REPOS</span>
    <span class="tag">${c.archived} ARCHIVED</span>
  </div>
${rows}
  <footer class="footer">
    <span>Black / amber edition · matches AI_Dashboard palette</span>
    <span>Regenerate with <code>node export-projects.js</code></span>
  </footer>
</div>
</body>
</html>
`;

await writeFile(OUT, html, "utf8");
console.log(`wrote ${OUT} (${html.length} bytes, ${data.projects.length} projects)`);
