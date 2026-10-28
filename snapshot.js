#!/usr/bin/env node
/**
 * Daily snapshot logger for the Freebuff 7-day report.
 *
 *   node snapshot.js           # capture now, upsert today's row, print summary
 *   node snapshot.js --quiet   # capture, print nothing on success
 *
 * Run this once a day (cron/systemd timer — see README) and the report's
 * per-day spend numbers fill in as real history accumulates. Safe to run
 * multiple times per day: it upserts by calendar day, keeping one row per day.
 */

import { captureSnapshot, loadHistory, totalBalance, REPORT_DAYS } from "./freebuff.js";
import { captureProjectsSnapshot, loadProjectsHistory } from "./projects.js";

const quiet = process.argv.includes("--quiet");

try {
  const snap = await captureSnapshot();
  const history = await loadHistory();
  // Same daily run also records a compact projects-scan row (progress over time).
  const projSnap = await captureProjectsSnapshot({ day: snap.day });
  const projHistory = await loadProjectsHistory();

  if (!quiet) {
    const balance = totalBalance(snap.session);
    const daily = snap.session?.freebucks?.daily || {};
    const streak = snap.streak || {};
    console.log(
      [
        `Snapshot saved for ${snap.day} (${snap.timeZone})`,
        `  balance ${balance} (daily ${daily.remaining ?? "?"}/${daily.limit ?? "?"}, wallet ${snap.session?.freebucks?.wallet?.balance ?? "?"})`,
        `  streak ${streak.streak ?? "?"} days · today used ${streak.todayUsed ? "yes" : "no"} · credited ${streak.todayCredited ? "yes" : "no"}`,
        `  history now has ${history.size} day${history.size === 1 ? "" : "s"} (${REPORT_DAYS}-day window fills up as days accumulate)`,
        `  projects ${projSnap.counts.total} total · ${projSnap.counts.active7d} active this week · ${projSnap.counts.withDocs} with docs · ${projHistory.size} snapshot day${projHistory.size === 1 ? "" : "s"}`,
      ].join("\n"),
    );
  }
  process.exit(0);
} catch (err) {
  console.error(`snapshot failed: ${err.message || err}`);
  process.exit(1);
}
