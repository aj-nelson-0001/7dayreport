/**
 * Shared library for the Freebuff 7-day report.
 *
 * Zero npm dependencies — Node built-ins only (>=18 for global fetch).
 *
 * Responsibilities:
 *   - read the auth token the freebuff CLI stores in the OS keychain
 *   - call the same public API the CLI uses (/session, /streak)
 *   - persist one JSON snapshot per local day into data/history.jsonl
 *   - compute the 7-day activity report from history + live data
 *
 * Data honesty note: the Freebuff API exposes no per-day history endpoint.
 * Days before the first logged snapshot only have streak-derived activity
 * (active vs not) — spend figures for those days are null, never invented.
 * Once the daily logger has run for a week, every day carries real numbers.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, appendFile, rename } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ---------- configuration ----------

export const API_BASE = process.env.FREEBUFF_API_BASE || "https://www.codebuff.com";
export const FETCH_TIMEOUT_MS = Number(process.env.FREEBUFF_TIMEOUT_MS || 15000);
const KEYCHAIN_TIMEOUT_MS = 10000;

const KEYCHAIN_SERVICE = process.env.FREEBUFF_KEYCHAIN_SERVICE || "freebuff-cli";
const CREDENTIALS_PATH =
  process.env.FREEBUFF_CREDENTIALS_PATH ||
  path.join(process.env.HOME || "", ".config/manicode/credentials.json");

export const REPORT_DAYS = 7;
export const HISTORY_FILE =
  process.env.SEVEN_DAY_HISTORY_FILE ||
  path.join(path.dirname(new URL(import.meta.url).pathname), "data", "history.jsonl");

// ---------- auth ----------

/** Read the auth token from the OS keychain (Linux Secret Service via secret-tool). */
export async function readToken() {
  if (process.env.FREEBUFF_TOKEN) return process.env.FREEBUFF_TOKEN.trim();
  try {
    const { stdout } = await execFileAsync(
      "secret-tool",
      ["lookup", "service", KEYCHAIN_SERVICE, "account", CREDENTIALS_PATH],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    const token = stdout.trim();
    if (!token) throw new Error("empty token");
    return token;
  } catch (err) {
    throw new Error(
      `Could not read token from keychain (service=${KEYCHAIN_SERVICE}, account=${CREDENTIALS_PATH}): ${err.message}`,
    );
  }
}

// ---------- API ----------

/** Fetch one Freebuff API endpoint with the CLI's auth + client headers. */
export async function apiGet(token, pathname) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-freebuff-client": "freebuff-cli",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${pathname} -> non-JSON response: ${text.slice(0, 200)}`);
  }
}

/** Fetch both live endpoints in parallel. */
export async function fetchLive(token = null) {
  const t = token || (await readToken());
  const [session, streak] = await Promise.all([
    apiGet(t, "/api/v1/freebuff/session"),
    apiGet(t, "/api/v1/freebuff/streak"),
  ]);
  return { fetchedAt: new Date().toISOString(), session, streak };
}

// ---------- day/date helpers ----------

/**
 * The account's calendar day (YYYY-MM-DD) for an instant, using the
 * timezone the streak endpoint reports (falls back to UTC).
 */
export function dayKey(dateLike, timeZone = "UTC") {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(dateLike));
}

/** Shift a YYYY-MM-DD key by whole days (UTC arithmetic on the date parts). */
export function shiftDay(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/** Difference in whole days: toKey - fromKey. */
export function daysBetween(fromKey, toKey) {
  const f = Date.parse(`${fromKey}T00:00:00Z`);
  const t = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((t - f) / 86400000);
}

/** The REPORT_DAYS calendar days ending on (and including) endKey, oldest first. */
export function windowDays(endKey, count = REPORT_DAYS) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftDay(endKey, -i));
  return out;
}

// ---------- history (data/history.jsonl) ----------

/**
 * Read history. Each line is a JSON snapshot:
 *   { day: "YYYY-MM-DD", capturedAt, session, streak }
 * One entry per day — the newest line for a day wins (the logger upserts).
 * Returns a Map<day, snapshot>.
 */
export async function loadHistory(file = HISTORY_FILE) {
  const map = new Map();
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return map;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const snap = JSON.parse(trimmed);
      if (snap && typeof snap.day === "string") map.set(snap.day, snap);
    } catch {
      // skip corrupt lines rather than failing the whole report
    }
  }
  return map;
}

/**
 * Upsert one snapshot for its calendar day. Replaces any existing entry for
 * that day so history stays one-row-per-day (append is atomic-ish: write to a
 * temp file, then rename over). Returns the snapshot written.
 */
export async function saveSnapshot(snapshot, file = HISTORY_FILE) {
  const history = await loadHistory(file);
  history.set(snapshot.day, snapshot);

  await mkdir(path.dirname(file), { recursive: true });
  const lines = [...history.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, snap]) => JSON.stringify(snap));

  const tmp = `${file}.${process.pid}.tmp`;
  await writeFileEnsured(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
  await rename(tmp, file);
  return snapshot;
}

async function writeFileEnsured(file, data) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, data, "utf8");
}

/** Capture live data and persist it as today's snapshot. */
export async function captureSnapshot(file = HISTORY_FILE) {
  const live = await fetchLive();
  const tz = live.streak?.timeZone || "UTC";
  const snapshot = {
    day: dayKey(new Date(), tz),
    capturedAt: live.fetchedAt,
    timeZone: tz,
    session: live.session,
    streak: live.streak,
  };
  await saveSnapshot(snapshot, file);
  return snapshot;
}

// ---------- report computation ----------

const num = (v) => (typeof v === "number" ? v : null);

/**
 * Build the 7-day report from stored history + the live fetch.
 *
 * For each of the last 7 calendar days:
 *   - active: derived from the streak. If streak >= N and lastUsageDate is
 *     known, every day within `streak` days before lastUsageDate was active.
 *     Snapshot evidence (streak.lastUsageDate === day) also marks a day active.
 *   - spent / balance / free-window numbers: only when a snapshot exists for
 *     that day; otherwise null (never fabricated).
 *
 * Totals:
 *   - daysActive / expectedDays
 *   - streakBonusEarned = daysActive * dailyBonus (what the streak paid in-window)
 *   - current position from the newest snapshot (or live if history is empty)
 */
export function buildReport(historyMap, live) {
  const tz = live.streak?.timeZone || "UTC";
  const today = dayKey(new Date(), tz);
  const window = windowDays(today, REPORT_DAYS);

  const streak = live.streak || {};
  const streakLen = num(streak.streak) ?? 0;
  const lastUsage = typeof streak.lastUsageDate === "string" ? streak.lastUsageDate : null;
  const dailyBonus = num(streak.freebucksDailyBonus) ?? 0;

  const days = window.map((day) => {
    const snap = historyMap.get(day) || null;

    // Streak coverage: day is active if it lies within the streak run
    // ending at lastUsage (i.e. 0 <= lastUsage - day < streakLen).
    let streakCovered = false;
    if (lastUsage) {
      const ago = daysBetween(day, lastUsage);
      streakCovered = ago >= 0 && ago < streakLen;
    }
    // Snapshot proof: the API said this exact day was the last usage day,
    // or todayUsed was true on a snapshot captured that day.
    const snapActive =
      !!snap && (snap.streak?.lastUsageDate === day || snap.streak?.todayUsed === true);

    const active = streakCovered || snapActive;
    const s = snap?.session || null;

    return {
      day,
      isToday: day === today,
      active,
      source: snapActive && streakCovered ? "both" : snapActive ? "snapshot" : streakCovered ? "streak" : "none",
      recorded: !!snap,
      capturedAt: snap?.capturedAt || null,
      streakBonus: active ? dailyBonus : 0,
      // Real per-day numbers only when a snapshot exists:
      spent: snap ? num(s?.freebucks?.daily?.spent) : null,
      dailyLimit: snap ? num(s?.freebucks?.daily?.limit) : null,
      dailyRemaining: snap ? num(s?.freebucks?.daily?.remaining) : null,
      balance: snap ? totalBalance(s) : null,
      freeWindows: snap ? summarizeWindows(s?.freeWindows) : null,
      todayUsed: snap ? !!snap.streak?.todayUsed : null,
    };
  });

  const daysActive = days.filter((d) => d.active).length;
  const daysRecorded = days.filter((d) => d.recorded).length;
  const recordedSpend = days.filter((d) => d.recorded && typeof d.spent === "number");
  const totalSpentRecorded = recordedSpend.reduce((acc, d) => acc + (d.spent || 0), 0);

  // Newest snapshot (prefer today's, else latest in map) → current position.
  const newest = historyMap.get(today) || latestSnapshot(historyMap) || null;
  const curSession = newest?.session || live.session || null;
  const curStreak = newest?.streak || live.streak || null;

  return {
    generatedAt: new Date().toISOString(),
    timeZone: tz,
    today,
    window,
    days,
    totals: {
      expectedDays: REPORT_DAYS,
      daysActive,
      daysRecorded,
      streakBonusEarned: days.reduce((acc, d) => acc + d.streakBonus, 0),
      dailyBonus,
      totalSpentRecorded,
      hasRecordedSpend: recordedSpend.length > 0,
    },
    current: {
      balance: totalBalance(curSession),
      wallet: num(curSession?.freebucks?.wallet?.balance) ?? 0,
      dailyPool: num(curSession?.freebucks?.daily?.remaining) ?? 0,
      dailyLimit: num(curSession?.freebucks?.daily?.limit) ?? 0,
      dailySpent: num(curSession?.freebucks?.daily?.spent) ?? 0,
      streak: num(curStreak?.streak) ?? 0,
      todayUsed: !!curStreak?.todayUsed,
      todayCredited: !!curStreak?.todayCredited,
      planId: curSession?.freebucks?.planId || "free plan",
      accessTier: live.session?.accessTier || null,
      freeWindows: summarizeWindows(curSession?.freeWindows),
      prices: curSession?.freebucks?.prices || {},
      priceNotices: curSession?.freebucks?.priceNotices || {},
    },
    source: {
      liveFrom: live.fetchedAt,
      historyDays: historyMap.size,
      newestSnapshotDay: newest?.day || null,
      // Explain honesty: which fields are streak-derived vs recorded.
      note:
        daysRecorded < REPORT_DAYS
          ? `Per-day spend is recorded for ${daysRecorded}/${REPORT_DAYS} days in this window. Earlier days show activity from the streak only; numbers appear as the daily logger accumulates.`
          : `Per-day spend recorded for all ${REPORT_DAYS} days.`,
    },
  };
}

function latestSnapshot(historyMap) {
  let best = null;
  for (const snap of historyMap.values()) {
    if (!best || snap.day > best.day) best = snap;
  }
  return best;
}

export function totalBalance(session) {
  const daily = num(session?.freebucks?.daily?.remaining) ?? 0;
  const wallet = num(session?.freebucks?.wallet?.balance) ?? 0;
  return daily + wallet;
}

function summarizeWindows(fw) {
  if (!fw) return null;
  return {
    dayUsed: num(fw.dayUsed) ?? 0,
    dayLimit: num(fw.dayLimit) ?? 0,
    weekUsed: num(fw.weekUsed) ?? 0,
    weekLimit: num(fw.weekLimit) ?? 0,
    monthUsed: num(fw.monthUsed) ?? 0,
    monthLimit: num(fw.monthLimit) ?? 0,
  };
}
