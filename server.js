#!/usr/bin/env node
/**
 * Freebuff 7-day report server.
 *
 *   node server.js            # serves http://127.0.0.1:4177
 *   PORT=8080 node server.js  # custom port
 *   node server.js --print    # 7-day report as text to stdout, then exit
 *
 * Routes:
 *   GET  /               → public/index.html
 *   GET  /api/report     → { report } — 7-day summary (live fetch + history)
 *   POST /api/log        → capture a snapshot now (upsert today), returns report
 *   GET  /api/history    → raw history rows (debug/inspection)
 *   GET  /api/projects   → { projects } — progress across ~/Projects (cached ~60s)
 *   GET  /api/projects/history → { rows } — daily projects snapshots (progress over time)
 *
 * Zero npm dependencies: Node's built-in http + fetch.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  fetchLive,
  loadHistory,
  captureSnapshot,
  buildReport,
} from "./freebuff.js";
import { getProjects, loadProjectsHistory } from "./projects.js";

const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- text mode ----------

function formatText(report) {
  const t = report.totals;
  const c = report.current;
  const lines = [];

  lines.push(`Freebuff · 7-day report · ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push(`Timezone ${report.timeZone} · window ${report.window[0]} → ${report.window[6]}`);
  lines.push("");
  lines.push(
    `Days active   ${t.daysActive}/${t.expectedDays}  ·  recorded spend ${t.daysRecorded}/${t.expectedDays} days`,
  );
  lines.push(
    `Streak        ${c.streak} days  ·  bonus earned in window +${t.streakBonusEarned} (${t.dailyBonus}/day)`,
  );
  if (t.hasRecordedSpend) {
    lines.push(`Spent (recorded days)  ${t.totalSpentRecorded} freebucks`);
  } else {
    lines.push("Spent (recorded days)  no snapshots yet — run `node snapshot.js`");
  }
  lines.push("");
  lines.push(`Now            balance ${c.balance}  (wallet ${c.wallet} + daily pool ${c.dailyPool}/${c.dailyLimit})`);
  lines.push(`               today spent ${c.dailySpent} · used ${c.todayUsed ? "yes" : "no"} · credited ${c.todayCredited ? "yes" : "no"}`);
  const w = c.freeWindows;
  if (w) {
    lines.push(
      `Free windows   day ${w.dayUsed}/${w.dayLimit} · week ${w.weekUsed}/${w.weekLimit} · month ${w.monthUsed}/${w.monthLimit}`,
    );
  }
  lines.push("");
  for (const d of report.days) {
    const mark = d.active ? "●" : "○";
    const rec = d.recorded ? `spent ${d.spent ?? "?"} bal ${d.balance ?? "?"}` : "streak only";
    lines.push(`  ${mark} ${d.day}${d.isToday ? " (today)" : ""}  ${rec}`);
  }
  lines.push("");
  lines.push(report.source.note);
  return lines.join("\n");
}

if (process.argv.includes("--print")) {
  try {
    const live = await fetchLive();
    const history = await loadHistory();
    const report = buildReport(history, live);
    process.stdout.write(formatText(report) + "\n");
    process.exit(0);
  } catch (err) {
    console.error(`7dayreport failed: ${err.message || err}`);
    process.exit(1);
  }
}

// ---------- helpers ----------

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj, null, 2));
}

async function buildReportFromLive() {
  const live = await fetchLive();
  const history = await loadHistory();
  return buildReport(history, live);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/report" && req.method === "GET") {
      try {
        sendJson(res, 200, { report: await buildReportFromLive() });
      } catch (err) {
        sendJson(res, 502, { error: String(err.message || err) });
      }
      return;
    }

    if (url.pathname === "/api/log" && req.method === "POST") {
      try {
        await captureSnapshot();
        sendJson(res, 200, { report: await buildReportFromLive(), logged: true });
      } catch (err) {
        sendJson(res, 502, { error: String(err.message || err), logged: false });
      }
      return;
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      const history = await loadHistory();
      sendJson(res, 200, { rows: [...history.values()] });
      return;
    }

    if (url.pathname === "/api/projects/history" && req.method === "GET") {
      try {
        const history = await loadProjectsHistory();
        sendJson(res, 200, { rows: [...history.values()] });
      } catch (err) {
        sendJson(res, 502, { error: String(err.message || err) });
      }
      return;
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      try {
        // force=1 bypasses the ~60s cache (used by the Refresh button).
        const force = url.searchParams.get("force") === "1";
        sendJson(res, 200, await getProjects({ force }));
      } catch (err) {
        sendJson(res, 502, { error: String(err.message || err) });
      }
      return;
    }

    // Static UI files.
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.join(__dirname, "public", filePath);
    if (!abs.startsWith(path.join(__dirname, "public"))) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const data = await readFile(abs);
      res.writeHead(200, {
        "content-type": MIME[path.extname(abs)] || "application/octet-stream",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Freebuff 7-day report -> http://${HOST}:${PORT}`);
});
