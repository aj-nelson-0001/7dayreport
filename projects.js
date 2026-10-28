/**
 * Project progress scanner for the 7-day report dashboard.
 *
 * Zero npm dependencies — Node built-ins only.
 *
 * For every project directory under PROJECTS_ROOT (default ~/Projects) it
 * gathers two kinds of truth:
 *
 *   1. Git/filesystem facts — branch, uncommitted-file count, commit count,
 *      last commit date + subject, recent commit subjects, newest file.
 *      Directories without git report file counts and newest-file dates.
 *
 *   2. Progress docs — the project's own planning files (README, PROGRESS,
 *      TODO, ROADMAP, BACKLOG, SUGFS, NOTES, CHANGELOG…): a description
 *      paragraph, checkbox done/open counts, and the bullet items under
 *      progress-ish headings (Done / In progress / Blocked / Backlog…).
 *
 * Everything is derived mechanically from what's on disk — no field is
 * invented. A project with no docs simply shows no doc summary; a repo with
 * no commits says so. Status (active/recent/dormant/archived) is derived
 * from activity dates and naming/markers, never asserted by anyone.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ROOT = process.env.PROJECTS_ROOT || path.join(os.homedir(), "Projects");
const CACHE_MS = Number(process.env.PROJECTS_CACHE_MS || 60000);
const GIT_TIMEOUT_MS = 5000;
const SCAN_CONCURRENCY = 6;

const MAX_DOCS_PER_PROJECT = 3;
const MAX_HEADINGS_PER_DOC = 8;
const MAX_ITEMS_PER_HEADING = 4;
const DESC_CAP = 220;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", "__pycache__",
  ".venv", "venv", ".cache", ".next", ".turbo", ".output",
]);

// Ordered by how likely the file is to describe progress, not alphabetical.
const DOC_PATTERNS = [
  /progress/i, /todo/i, /roadmap/i, /backlog/i, /sugfs/i,
  /^readme/i, /changelog/i, /notes/i, /status/i,
];

const ARCHIVE_NAME_RE = /(?:^|[-_])\d{4}-\d{2}-\d{2}(?:[-_]|$)/;
const ARCHIVE_TEXT_RE = /\b(archived|deprecated|unmaintained|no longer maintained)\b/i;
const ARCHIVE_COMMIT_RE = /\b(unmaintained|archived|deprecat)/i;

// ---------- small helpers ----------

const run = (cmd, args, opts = {}) =>
  execFileAsync(cmd, args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...opts,
  }).then(({ stdout }) => stdout.trim());

/** Run a git command, returning null on any failure (no commits, not a repo…). */
async function git(dir, ...args) {
  try {
    return await run("git", ["-C", dir, ...args]);
  } catch {
    return null;
  }
}

/** First paragraph of a markdown file: prose only, no headings/code fences. */
function firstParagraph(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*#{1,6}\s/.test(line)) { if (out.length) break; continue; }
    if (!line.trim()) { if (out.length) break; continue; }
    out.push(line.trim());
    if (out.join(" ").length > DESC_CAP) break;
  }
  return out.join(" ").replace(/\s+/g, " ").replace(/[|`]$/, "").slice(0, DESC_CAP);
}

/**
 * Heading sections with their bullet items (fenced code skipped).
 * Returns at most MAX_HEADINGS_PER_DOC sections that actually have items.
 */
function extractSections(text) {
  const sections = [];
  let cur = null;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (cur && cur.items.length) sections.push(cur);
      const heading = h[2].replace(/[*`_]/g, "").trim();
      cur = { heading: heading.length > 90 ? heading.slice(0, 88).trimEnd() + "…" : heading, items: [] };
      continue;
    }
    const li = line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.*)/);
    if (li && cur && cur.items.length < MAX_ITEMS_PER_HEADING) {
      // Strip markdown emphasis and trailing hard-line-break backslashes.
      const item = li[1].replace(/[*_`]/g, "").replace(/\\+$/, "").trim().slice(0, 140);
      if (item) cur.items.push(item);
    }
  }
  if (cur && cur.items.length) sections.push(cur);
  return sections.slice(0, MAX_HEADINGS_PER_DOC);
}

/** Parse one progress doc into a structured summary. */
function summariseDoc(relName, text, mtime) {
  const done = (text.match(/^\s*[-*+]\s+\[[xX]\]/gm) || []).length;
  const open = (text.match(/^\s*[-*+]\s+\[ \]/gm) || []).length;
  return {
    file: relName,
    updated: mtime,
    description: relName.toLowerCase().includes("readme") ? firstParagraph(text) : "",
    done,
    open,
    sections: extractSections(text),
  };
}

/** Score a candidate doc filename by progress-likelihood (lower = better). */
function docPriority(name) {
  const idx = DOC_PATTERNS.findIndex((re) => re.test(name));
  return idx === -1 ? DOC_PATTERNS.length : idx;
}

// ---------- per-project scan ----------

/** Newest mtime of files under dir (depth ≤ 2, build/vendor dirs pruned). */
async function newestFile(dir) {
  let best = null;
  let files = 0;
  const walk = async (d, depth) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && depth === 0 && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (depth < 2 && !SKIP_DIRS.has(e.name)) await walk(path.join(d, e.name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      try {
        const st = await stat(path.join(d, e.name));
        if (!best || st.mtimeMs > best.mtimeMs) best = st;
      } catch {
        // raced with deletion — ignore
      }
    }
  };
  await walk(dir, 0);
  return { files, newest: best ? best.mtime.toISOString() : null };
}

/** Read the project's most progress-like markdown docs (≤ 3). */
async function scanDocs(dir) {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = names
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .filter((n) => DOC_PATTERNS.some((re) => re.test(n)))
    .sort((a, b) => docPriority(a) - docPriority(b) || a.localeCompare(b))
    .slice(0, MAX_DOCS_PER_PROJECT);

  const docs = [];
  for (const name of candidates) {
    try {
      const abs = path.join(dir, name);
      const [text, st] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
      docs.push(summariseDoc(name, text, st.mtime.toISOString().slice(0, 10)));
    } catch {
      // unreadable or vanished — skip
    }
  }

  // README is often pushed out of the top-3 by progress docs, but it is the
  // canonical source of the project's one-line description — read it
  // separately so the description never depends on the doc cap.
  let readmeDescription = "";
  const hasReadme = docs.some((d) => /^readme\.md$/i.test(d.file));
  if (!hasReadme && names.some((e) => e.isFile() && /^readme\.md$/i.test(e.name))) {
    try {
      readmeDescription = firstParagraph(await readFile(path.join(dir, "README.md"), "utf8"));
    } catch {
      // unreadable — leave empty
    }
  }

  return { docs, readmeDescription };
}

/** Scan one project directory into its facts + doc summaries. */
async function scanProject(root, name) {
  const dir = path.join(root, name);
  const hasGit = await git(dir, "rev-parse", "--is-inside-work-tree").then((v) => v === "true");

  let gitFacts = null;
  let lastCommitSubject = null;
  if (hasGit) {
    const [branch, logLine, dirtyRaw, countRaw, recentRaw, firstRaw, remote] = await Promise.all([
      git(dir, "branch", "--show-current"),
      git(dir, "log", "-1", "--format=%ad%x09%s", "--date=short"),
      git(dir, "status", "--porcelain"),
      git(dir, "rev-list", "--count", "HEAD"),
      git(dir, "log", "-3", "--format=%ad%x09%s", "--date=short"),
      git(dir, "log", "--reverse", "--format=%ad", "--date=short", "--max-count=1"),
      git(dir, "config", "--get", "remote.origin.url"),
    ]);

    const [lastDate, ...rest] = (logLine || "").split("\t");
    lastCommitSubject = rest.join("\t") || null;

    gitFacts = {
      branch: branch || null,
      lastCommitDate: logLine ? lastDate : null,
      lastCommitSubject,
      dirty: dirtyRaw ? dirtyRaw.split("\n").filter(Boolean).length : 0,
      commits: countRaw ? Number(countRaw) : null,
      firstCommitDate: firstRaw || null,
      remote: remote ? remote.replace(/^git@([^:]+):/, "github.com/").replace(/^https?:\/\//, "").replace(/\.git$/, "") : null,
      recentCommits: (recentRaw || "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [date, ...s] = line.split("\t");
          return { date, subject: s.join("\t") };
        }),
    };
  }

  const fsFacts = await newestFile(dir);
  const { docs, readmeDescription } = await scanDocs(dir);

  // Activity = the newest signal we have (git or file mtime).
  const activityDate = [gitFacts?.lastCommitDate, fsFacts.newest?.slice(0, 10)]
    .filter(Boolean)
    .sort()
    .pop() || null;

  const readme = docs.find((d) => /readme/i.test(d.file));
  const archiveMarkers = [
    ARCHIVE_NAME_RE.test(name),
    ARCHIVE_COMMIT_RE.test(lastCommitSubject || ""),
    ARCHIVE_TEXT_RE.test((readme?.description || "").slice(0, 200)),
  ].some(Boolean);

  return {
    name,
    kind: hasGit ? "git" : "dir",
    activityDate,
    git: gitFacts,
    files: fsFacts.files,
    newestFile: fsFacts.newest ? fsFacts.newest.slice(0, 10) : null,
    docs,
    description:
      readmeDescription || docs.find((d) => /readme/i.test(d.file))?.description || "",
    archivedMarker: archiveMarkers,
  };
}

// ---------- status derivation ----------

function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

function statusOf(project) {
  if (project.archivedMarker) return "archived";
  const d = daysSince(project.activityDate);
  if (d === null) return "dormant";
  if (d <= 3) return "active";
  if (d <= 14) return "recent";
  return "dormant";
}

// ---------- top level ----------

const cache = { at: 0, data: null, pending: null };

/** Bounded-concurrency map. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function build() {
  let entries;
  try {
    entries = await readdir(ROOT, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read projects root ${ROOT}: ${err.message}`);
  }
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const projects = await pool(names, SCAN_CONCURRENCY, (n) => scanProject(ROOT, n));
  for (const p of projects) {
    p.daysSinceActivity = daysSince(p.activityDate);
    p.status = statusOf(p);
    delete p.archivedMarker;
  }

  // Active first, archived last, then by name.
  const rank = { active: 0, recent: 1, dormant: 2, archived: 3 };
  projects.sort(
    (a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name),
  );

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    counts: {
      total: projects.length,
      git: projects.filter((p) => p.kind === "git").length,
      dirs: projects.filter((p) => p.kind === "dir").length,
      active7d: projects.filter((p) => p.daysSinceActivity !== null && p.daysSinceActivity <= 7).length,
      archived: projects.filter((p) => p.status === "archived").length,
      withDocs: projects.filter((p) => p.docs.length > 0).length,
    },
    projects,
  };
}

/**
 * Scan all projects (cached for CACHE_MS; concurrent callers share one scan).
 * `force: true` bypasses the cache.
 */
export async function getProjects({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;
  if (!cache.pending) {
    cache.pending = build()
      .then((data) => {
        cache.data = data;
        cache.at = Date.now();
        return data;
      })
      .finally(() => {
        cache.pending = null;
      });
  }
  return cache.pending;
}

// ---------- daily snapshot (progress over time) ----------

export const PROJECTS_HISTORY_FILE =
  process.env.SEVEN_DAY_PROJECTS_HISTORY_FILE ||
  path.join(path.dirname(new URL(import.meta.url).pathname), "data", "projects-history.jsonl");

/**
 * Read projects history. Each line is one JSON snapshot:
 *   { day, capturedAt, counts, projects: [compact per-project row] }
 * Returns a Map<day, row>. Missing file → empty map (no snapshots yet).
 */
export async function loadProjectsHistory(file = PROJECTS_HISTORY_FILE) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.day) map.set(row.day, row);
    } catch {
      // skip a corrupt line rather than losing the whole history
    }
  }
  return map;
}

/**
 * Upsert one projects snapshot for its calendar day. One row per day
 * (write temp file, then rename over — same pattern as freebuff.js).
 */
export async function saveProjectsSnapshot(snapshot, file = PROJECTS_HISTORY_FILE) {
  const history = await loadProjectsHistory(file);
  history.set(snapshot.day, snapshot);

  await mkdir(path.dirname(file), { recursive: true });
  const lines = [...history.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, row]) => JSON.stringify(row));

  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  await rename(tmp, file);
  return snapshot;
}

/** Compact per-project row — just what trend/delta comparisons need. */
function snapshotRow(p) {
  return {
    name: p.name,
    status: p.status,
    kind: p.kind,
    activityDate: p.activityDate,
    daysSinceActivity: p.daysSinceActivity,
    commits: p.kind === "git" ? (p.git?.commits ?? null) : null,
    dirty: p.kind === "git" ? (p.git?.dirty ?? null) : null,
    files: p.files,
    docs: p.docs.length,
    done: p.docs.reduce((n, d) => n + (d.done || 0), 0),
    open: p.docs.reduce((n, d) => n + (d.open || 0), 0),
  };
}

/**
 * Scan now (bypassing the cache) and persist today's compact row.
 * Called by snapshot.js on its daily run; `day` lets it share the exact
 * calendar-day key with the freebuff snapshot captured in the same run.
 */
export async function captureProjectsSnapshot({ file = PROJECTS_HISTORY_FILE, day } = {}) {
  const data = await getProjects({ force: true });
  const snapshot = {
    day: day || new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
    capturedAt: new Date().toISOString(),
    counts: data.counts,
    projects: data.projects.map(snapshotRow),
  };
  await saveProjectsSnapshot(snapshot, file);
  return snapshot;
}
