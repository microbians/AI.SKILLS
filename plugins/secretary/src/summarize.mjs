#!/usr/bin/env node

/**
 * The Secretary — AI-powered context persistence for Claude Code
 *
 * Uses a local LLM (MLX or llama-server) to:
 * - Incrementally summarize conversations
 * - Manage user memories (remember/forget)
 * - Take and manage notes
 * - Track reminders with due dates
 * - Classify user intents flexibly via LLM
 *
 * Commands:
 *   incremental  - Summarize new conversation since last checkpoint (PostToolUse hook)
 *   compact      - Warn user that compaction is about to happen (PreCompact hook)
 *   restore      - Inject saved summaries after /clear (SessionStart hook)
 *   force        - Force an immediate summary regardless of counter/threshold (Stop hook or manual)
 *   inject       - Inject arbitrary text as a summary entry (manual use)
 *   recall       - Show the stored index (saved items + context)
 *
 * Reads hook JSON from stdin.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, rmSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { execSync, execFile, execFileSync } from 'child_process';
import http from 'http';

// ═══════════════════ CONFIG ═══════════════════

const SECRETARY_DIR = join(homedir(), '.claude', 'the-secretary');
const CONFIG_PATH = join(SECRETARY_DIR, 'config.json');

// The `claude` binary moves with the way it was installed (Homebrew, the
// native installer, npm). A configured path that no longer exists falls back
// to the known locations instead of failing every summary. The native
// installer's copy is the default because it is the one that updates itself:
// a global npm install left behind keeps its old version, and an old CLI
// warms up its built-in agents on every start (one extra request on the
// user's main model per summary).
function resolveClaudeBin(configured) {
  const candidates = [
    configured,
    join(homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean).map(p => p.replace(/^~/, homedir()));
  return candidates.find(p => existsSync(p)) || configured;
}

function loadConfig() {
  const defaults = {
    provider: 'claude_cli',
    claude_bin: resolveClaudeBin('~/.local/bin/claude'),
    claude_model: 'claude-haiku-4-5',
    llm_url: 'http://localhost:8922/v1/chat/completions',
    model: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    summarize_every_n: 15,
    min_new_chars: 2000,
    max_summary_tokens: 800,
    restore_recent_items: 15,
    restore_tail_chars: 5000,
    context_warn_tokens: 130000,
    context_clear_tokens: 170000,
    trim_keep_tokens: 60000,
    db_path: join(SECRETARY_DIR, 'summaries.db'),
  };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    const merged = { ...defaults, ...raw };
    merged.db_path = merged.db_path.replace(/^~/, homedir());
    merged.claude_bin = resolveClaudeBin(merged.claude_bin);
    return merged;
  } catch {
    return defaults;
  }
}

// `secretary -limit <thousands>` sets this session's limit (in tokens here); warn and keep scale with it.
function applySessionLimit(cfg) {
  const limit = Number(process.env.SECRETARY_LIMIT);
  if (!limit) return cfg;
  return { ...cfg, context_clear_tokens: limit, context_warn_tokens: Math.round(limit * 0.75), trim_keep_tokens: Math.round(limit / 2) };
}

const config = applySessionLimit(loadConfig());

// ═══════════════════ PROJECT-ROOT RESOLUTION ═══════════════════
//
// Each project stores its own data under <projectRoot>/.claude/the-secretary/
// (summaries.db + bullets.md), so memory TRAVELS with the folder when it is
// copied or synced somewhere else. Only items explicitly marked 'global'
// (project_dir = '__global__') live in the shared DB at ~/.claude/the-secretary.
//
// the-secretary has NOTHING to do with git — it keys purely on the cwd path.
// The root is resolved from the filesystem: climb the cwd's ancestors until
// hitting a generic container folder (Code, Programacion, Documents, home…).
// While climbing, the highest ancestor that already holds .claude/the-secretary/
// data (or a plain .claude/ dir) anchors the root there, so sessions opened in
// any nested subfolder all share the same project DB.

// Generic parent folders that group many unrelated projects. We never treat
// these (or anything above them) as a project root.
const GENERIC_CONTAINERS = new Set([
  'Code', 'code', 'Programacion', 'Programación', 'Projects', 'projects',
  'Documents', 'Desktop', 'Developer', 'dev', 'src', 'repos', 'Repos',
  'work', 'Work', 'CloudDocs', 'Mobile Documents',
  'Library', 'CloudStorage', 'Shared drives',
]);

function parentDir(p) {
  const i = p.lastIndexOf('/');
  if (i <= 0) return null;
  return p.slice(0, i);
}

const PROJECT_DATA_SUBDIR = join('.claude', 'the-secretary');
// A handoff whose session did no work on the project: one line, never the resume point.
const OFF_PROJECT_TAG = 'OFF-PROJECT:';

function resolveProjectRoot(cwd) {
  if (!cwd || cwd === '__global__') return null;
  let dataRoot = null;
  let markerRoot = null;
  let top = cwd;
  let dir = cwd;
  // Climb until the PARENT is a generic container (or home/root): containers
  // stop the climb but a cwd itself named like one (e.g. …/project/src) still
  // resolves to its enclosing project.
  while (dir) {
    if (existsSync(join(dir, PROJECT_DATA_SUBDIR))) dataRoot = dir;
    if (existsSync(join(dir, '.claude'))) markerRoot = dir;
    top = dir;
    const parent = parentDir(dir);
    if (!parent || parent === homedir() || parent === '/' || GENERIC_CONTAINERS.has(basename(parent))) break;
    dir = parent;
  }
  // Existing secretary data anchors the root; a .claude/ dir is the next best
  // marker; otherwise fall back to the highest dir below a generic container.
  return dataRoot || markerRoot || top;
}

function projectDataDir(root) {
  return root ? join(root, PROJECT_DATA_SUBDIR) : null;
}

// Creates the project data dir with a self-ignoring .gitignore so the memory
// never gets committed/pushed, even in repos without their own ignore rules.
function ensureProjectDataDir(root) {
  const dir = projectDataDir(root);
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const gitignore = join(dir, '.gitignore');
  if (!existsSync(gitignore)) {
    try { writeFileSync(gitignore, '*\n', 'utf-8'); } catch { /* ignore */ }
  }
  return dir;
}

function projectDbPath(root) {
  return root ? join(projectDataDir(root), 'summaries.db') : null;
}

// Returns { clause, params } for a WHERE fragment matching the whole project
// tree rooted at `root`. Use as: `WHERE ${clause}` with `.all(...params)`.
// When root is falsy, matches nothing meaningful — callers guard on cwd first.
function projectTreeClause(root, column = 'project_dir') {
  if (!root) return { clause: '1=0', params: [] };
  return {
    clause: `(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`,
    params: [root, escapeLike(root) + '/%'],
  };
}

// Escape LIKE wildcards in a literal path so `_` / `%` in folder names don't
// act as wildcards. Paired with `ESCAPE '\'` in the clause above.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

// ═══════════════════ CACHE (per-project pre-generated summaries) ═══════════════════
//
// bullets.md now lives INSIDE the project (<root>/.claude/the-secretary/) so it
// travels with the folder. CACHE_DIR is the legacy pre-per-project location,
// kept only as a migration source and as fallback when no root resolves.

const CACHE_DIR = join(SECRETARY_DIR, 'cache');
const CACHE_MAX_BULLETS_PER_SESSION = 20;
const CACHE_MAX_CHARS_PER_SESSION = 4000;
const CACHE_SESSIONS_KEPT = 2;
const CACHE_BULLETS_PER_CHUNK = 3;
const BULLETS_FILE = 'bullets.md';

function projectFolderName(cwd) {
  if (!cwd) return '__unknown__';
  const base = basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '_') || '_';
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function cacheDirForProject(cwd) {
  const root = resolveProjectRoot(cwd);
  if (root) return projectDataDir(root);
  return join(CACHE_DIR, projectFolderName(cwd));
}

// One-time copy of the legacy bullets.md (~/.claude/the-secretary/cache/…)
// into the project's own .claude/the-secretary/ dir.
function migrateLegacyBullets(cwd) {
  const root = resolveProjectRoot(cwd);
  if (!root) return;
  const dest = join(projectDataDir(root), BULLETS_FILE);
  if (existsSync(dest)) return;
  for (const key of [root, cwd]) {
    const legacy = join(CACHE_DIR, projectFolderName(key), BULLETS_FILE);
    if (!existsSync(legacy)) continue;
    try {
      ensureProjectDataDir(root);
      writeFileSync(dest, readFileSync(legacy, 'utf-8'));
    } catch { /* ignore */ }
    return;
  }
}

function ensureCacheDir(cwd) {
  const root = resolveProjectRoot(cwd);
  if (root) {
    try { return ensureProjectDataDir(root); } catch { /* fall through */ }
  }
  const dir = cacheDirForProject(cwd);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function bulletsFilePath(cwd) {
  return join(cacheDirForProject(cwd), BULLETS_FILE);
}

/**
 * Read bullets.md and parse into sessions.
 * Format:
 *   ## Session <id> (started <iso>)
 *   - bullet 1
 *   - bullet 2
 *
 *   ## Session <id2> (started <iso>)
 *   - ...
 * Returns: [{ sessionId, startedAt, bullets: string[] }, ...]  (oldest first)
 */
function readBulletsCache(cwd) {
  if (!cwd) return [];
  migrateLegacyBullets(cwd);
  const file = bulletsFilePath(cwd);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf-8');
    const sections = [];
    const headerRe = /^## Session\s+(\S+)(?:\s+\(started\s+([^)]+)\))?\s*$/;
    let current = null;
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const m = line.match(headerRe);
      if (m) {
        if (current) sections.push(current);
        current = { sessionId: m[1], startedAt: m[2] || '', bullets: [] };
      } else if (current && line.startsWith('- ')) {
        const b = line.slice(2).trim();
        if (b) current.bullets.push(b);
      }
    }
    if (current) sections.push(current);
    return sections;
  } catch {
    return [];
  }
}

function serializeBulletsCache(sections) {
  return sections
    .map(s => {
      const header = `## Session ${s.sessionId}${s.startedAt ? ` (started ${s.startedAt})` : ''}`;
      const body = s.bullets.map(b => `- ${b}`).join('\n');
      return `${header}\n${body}`;
    })
    .join('\n\n') + (sections.length ? '\n' : '');
}

function writeBulletsCache(cwd, sections) {
  try {
    ensureCacheDir(cwd);
    writeFileSync(bulletsFilePath(cwd), serializeBulletsCache(sections), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Append new bullets to the current session, enforcing:
 *   - FIFO within session (max CACHE_MAX_BULLETS_PER_SESSION bullets,
 *     max CACHE_MAX_CHARS_PER_SESSION chars total)
 *   - Keep only last CACHE_SESSIONS_KEPT sessions across the file
 */
function appendBulletsForSession(cwd, sessionId, newBullets) {
  if (!cwd || !sessionId || !newBullets?.length) return false;
  const sections = readBulletsCache(cwd);

  let current = sections.find(s => s.sessionId === sessionId);
  if (!current) {
    current = { sessionId, startedAt: new Date().toISOString(), bullets: [] };
    sections.push(current);
  }

  for (const b of newBullets) {
    const clean = String(b).trim();
    if (!clean) continue;
    if (current.bullets.includes(clean)) continue;
    current.bullets.push(clean);
  }

  while (current.bullets.length > CACHE_MAX_BULLETS_PER_SESSION) current.bullets.shift();
  let totalChars = current.bullets.reduce((n, b) => n + b.length + 3, 0);
  while (totalChars > CACHE_MAX_CHARS_PER_SESSION && current.bullets.length > 1) {
    totalChars -= current.bullets[0].length + 3;
    current.bullets.shift();
  }

  while (sections.length > CACHE_SESSIONS_KEPT) sections.shift();

  return writeBulletsCache(cwd, sections);
}

// ═══════════════════ DATABASE ═══════════════════

let Database;
try {
  const require = createRequire(import.meta.url);
  try {
    Database = require('better-sqlite3');
  } catch {
    const globalPaths = [
      join(homedir(), '.claude', 'the-secretary', 'node_modules', 'better-sqlite3'),
      join(SECRETARY_DIR, 'node_modules', 'better-sqlite3'),
    ];
    for (const p of globalPaths) {
      try { Database = require(p); break; } catch { /* continue */ }
    }
  }
} catch { /* will be checked later */ }

function ensureSchema(db, schema = 'main') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${schema}.summaries (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ${schema}.state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Verbatim conversation turns, searchable word-by-word. Summaries lose the exact
  // wording ("ffmpeg on Railway" becomes "discussed deployment"), so recall questions
  // about something actually said can only be answered from the raw turns.
  // unicode61 + remove_diacritics 2 makes "edicion" match "edición" — required for ES.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${schema}.turns USING fts5(
        body,
        role UNINDEXED,
        session_id UNINDEXED,
        project_dir UNINDEXED,
        created_at UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  } catch { /* FTS5 unavailable: search silently falls back to LIKE over summaries */ }
}

const ITEM_COLS = 'session_id, project_dir, chunk_index, summary, message_count, created_at';
const ALL_ITEMS_COLS = `id, ${ITEM_COLS}`;

// MOVE this project's rows out of the global DB into the project's own DB, so a
// project carries its memory with it and the global file keeps only '__global__'
// items. Insert and delete run in one transaction: a copy that left the source
// behind used to duplicate every row, and the old "skip if the project DB has
// any row" guard meant a project already in use never migrated its history at
// all. Runs on every open and is a no-op once the global DB holds nothing for
// this tree.
function migrateFromGlobalDb(db, root) {
  try {
    const { clause, params } = projectTreeClause(root);
    const where = `${clause} AND project_dir != '__global__'`;
    const count = db.prepare(`SELECT COUNT(*) AS c FROM g.summaries WHERE ${where}`).get(...params)?.c || 0;
    if (!count) return;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO main.summaries (${ITEM_COLS})
        SELECT ${ITEM_COLS} FROM g.summaries WHERE ${where}
      `).run(...params);
      db.prepare(`DELETE FROM g.summaries WHERE ${where}`).run(...params);
    })();
    process.stderr.write(`[secretary] Moved ${count} item(s) from the global DB into ${projectDbPath(root)}\n`);
  } catch { /* best effort */ }
}

// Empties the global DB of per-project rows in one pass, instead of waiting for
// each project to be opened. Every project's items are moved into that project's
// own DB (created if needed) and deleted from the global one, so a project stays
// portable and the global file keeps only '__global__' items. A project whose
// directory no longer exists cannot be given a home, so its rows are left alone
// and reported rather than silently dropped.
function cmdDrainGlobal(dryRun = false) {
  if (!Database) { process.stderr.write('better-sqlite3 unavailable\n'); return; }
  const g = new Database(config.db_path);
  ensureSchema(g);

  const roots = new Map(); // project root -> [project_dir, ...]
  const orphans = [];
  for (const { project_dir: dir } of g.prepare(
    "SELECT DISTINCT project_dir FROM summaries WHERE project_dir != '__global__'"
  ).all()) {
    if (!dir || !existsSync(dir)) { orphans.push(dir); continue; }
    // Scratch directories are not projects: giving /private/tmp a DB would write
    // one into /private/.claude (unwritable anyway) and litter the filesystem.
    if (/^(?:\/private)?\/(?:tmp|var)(?:\/|$)/.test(dir)) { orphans.push(dir); continue; }
    const root = resolveProjectRoot(dir);
    if (!root) { orphans.push(dir); continue; }
    if (!roots.has(root)) roots.set(root, []);
    roots.get(root).push(dir);
  }

  let moved = 0;
  for (const root of roots.keys()) {
    const { clause, params } = projectTreeClause(root);
    const where = `${clause} AND project_dir != '__global__'`;
    const count = g.prepare(`SELECT COUNT(*) AS c FROM summaries WHERE ${where}`).get(...params)?.c || 0;
    if (!count) continue;
    process.stdout.write(`${dryRun ? 'would move' : 'moving'} ${String(count).padStart(6)} → ${projectDbPath(root)}\n`);
    moved += count;
    if (dryRun) continue;

    ensureProjectDataDir(root);
    const p = new Database(projectDbPath(root));
    p.pragma('journal_mode = WAL');
    ensureSchema(p);
    p.exec(`ATTACH DATABASE '${config.db_path.replace(/'/g, "''")}' AS g`);
    try {
      p.transaction(() => {
        p.prepare(`INSERT INTO main.summaries (${ITEM_COLS}) SELECT ${ITEM_COLS} FROM g.summaries WHERE ${where}`).run(...params);
        p.prepare(`DELETE FROM g.summaries WHERE ${where}`).run(...params);
      })();
    } finally {
      p.close();
    }
  }

  const left = g.prepare("SELECT COUNT(*) AS c FROM summaries WHERE project_dir != '__global__'").get()?.c || 0;
  const globals = g.prepare("SELECT COUNT(*) AS c FROM summaries WHERE project_dir = '__global__'").get()?.c || 0;
  if (!dryRun) g.exec('VACUUM');
  g.close();

  process.stdout.write(`\n${dryRun ? 'would move' : 'moved'} ${moved} item(s) into ${roots.size} project DB(s)\n`);
  process.stdout.write(`global keeps ${globals} '__global__' item(s); ${left} per-project row(s) still there\n`);
  if (orphans.length) {
    process.stdout.write(`\n${orphans.length} directory/ies no longer exist — left in the global DB:\n`);
    for (const o of orphans.slice(0, 20)) process.stdout.write(`  ${o}\n`);
    if (orphans.length > 20) process.stdout.write(`  ... and ${orphans.length - 20} more\n`);
  }
}

// Opens the PROJECT database (<root>/.claude/the-secretary/summaries.db) and
// attaches the global one as `g`. All reads go through the temp view
// `all_items` (project rows + '__global__' rows, tagged with src 'p'/'g').
// Without a resolvable root, falls back to the global DB alone.
function openDb(cwd) {
  if (!Database) return null;
  try {
    mkdirSync(SECRETARY_DIR, { recursive: true });
    const root = resolveProjectRoot(cwd);
    let db;
    if (root) {
      ensureProjectDataDir(root);
      db = new Database(projectDbPath(root));
      db.pragma('journal_mode = WAL');
      ensureSchema(db);
      db.exec(`ATTACH DATABASE '${config.db_path.replace(/'/g, "''")}' AS g`);
      ensureSchema(db, 'g');
      db._hasProject = true;
      migrateFromGlobalDb(db, root);
      db.exec(`CREATE TEMP VIEW IF NOT EXISTS all_items AS
        SELECT ${ALL_ITEMS_COLS}, 'p' AS src FROM main.summaries
        UNION ALL
        SELECT ${ALL_ITEMS_COLS}, 'g' AS src FROM g.summaries WHERE project_dir = '__global__'`);
    } else {
      db = new Database(config.db_path);
      db.pragma('journal_mode = WAL');
      ensureSchema(db);
      db._hasProject = false;
      db.exec(`CREATE TEMP VIEW IF NOT EXISTS all_items AS
        SELECT ${ALL_ITEMS_COLS}, 'p' AS src FROM main.summaries`);
    }
    return db;
  } catch {
    return null;
  }
}

// Physical table an item belongs to. Global items go to the attached global DB
// when a project DB is open; everything else lives in the project DB itself.
function itemTable(db, isGlobal) {
  return isGlobal && db._hasProject ? 'g.summaries' : 'summaries';
}

// ═══════════════════ LLM ═══════════════════

// A degenerate loop is not a bad summary, it is a non-answer: storing it costs
// the real content of that chunk and then re-injects the garbage on every
// SessionStart. Callers already treat an empty string as "nothing to save"
// (they exit without writing), so collapsing degeneration to '' routes it
// through the path that already exists instead of adding a second one.
// Detection is structural, not a word list: a looping generation reuses a tiny
// vocabulary over a long output, which no real summary does.
function isDegenerate(text) {
  const clean = (text || '').trim();
  // Short outputs (intent classifications, one-word blurbs) are legitimately
  // low-variety; the ratio only means something once there is enough text.
  if (clean.length < 400) return false;

  const words = clean.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  // Enough words to judge variety. Too few for that is not a pass: a separator-less
  // loop collapses into one huge "word", so it falls through to the periodicity
  // check below rather than being cleared here.
  if (words.length >= 60) {
    const unique = new Set(words);
    if (unique.size / words.length < 0.12) return true;

    // A cycle short enough to fit the same word repeatedly, e.g. "dev:dev:dev:".
    const top = new Map();
    for (const w of words) top.set(w, (top.get(w) || 0) + 1);
    const maxCount = Math.max(...top.values());
    if (maxCount / words.length > 0.35) return true;

    // Degeneration is usually LOCAL: the model writes real prose, falls into a
    // loop ("svgsvgsvg…", "asset asset asset"), and the loop is diluted by the
    // healthy half, so the whole-text ratios above stay respectable (measured
    // 0.13-0.20 on known-bad summaries, inside the legitimate range that starts
    // at 0.186). A sliding window finds the collapse the average hides: over
    // 29k stored summaries the worst 80-word window scores 0.66-0.81 on good
    // output and 0.04-0.10 on looping output, with a wide empty gap between.
    const W = 80;
    for (let i = 0; i + W <= words.length; i += 10) {
      if (new Set(words.slice(i, i + W)).size / W < 0.15) return true;
    }
  } else {
    // A loop made of punctuation (":\n:\n:\n", "：\n：\n") yields no words at all,
    // so every word ratio above is skipped and the alternating period defeats
    // the exact periodicity check below. Character variety still exposes it:
    // these score 0.0007-0.004 unique chars, any real summary far higher.
    const chars = clean.replace(/\s+/g, '');
    if (chars.length >= 200 && new Set(chars).size / chars.length < 0.02) return true;
  }

  // Cycles with no separators ("CallsCountCallsCount…") tokenize as one huge
  // word, so the ratios above never see them. Look for a repeating unit
  // directly: if the tail is periodic with some short period, every character
  // equals the one a period earlier. Checked over the last stretch only, so a
  // summary that merely ends in a list is not mistaken for a loop.
  const tail = clean.slice(-1200);
  for (let period = 2; period <= 80; period++) {
    if (tail.length < period * 10) break;
    let matches = 0;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] === tail[i - period]) matches++;
    }
    if (matches / (tail.length - period) > 0.95) return true;
  }
  return false;
}

// Degeneration often strikes a brief that was fine until it wasn't: a complete
// handoff whose last section loops the same two lines until the token budget
// runs out. Dropping the whole answer throws away real work, so cut at the
// point the loop starts and keep what came before — the same call the
// NOTHING-TO-REPORT guard makes (trim the noise, keep the brief).
// Returns '' when there is no healthy prefix to save.
function trimDegenerateTail(text) {
  const clean = (text || '').trim();
  if (!isDegenerate(clean)) return clean;

  // Walk forward over line boundaries and keep the longest prefix that is
  // still clean. Line granularity keeps the kept part readable markdown.
  const lines = clean.split('\n');
  let good = '';
  for (let i = 1; i <= lines.length; i++) {
    const candidate = lines.slice(0, i).join('\n');
    if (candidate.length >= 400 && isDegenerate(candidate)) break;
    good = candidate;
  }
  const trimmed = good.trim();
  // A prefix shorter than the handoff floor is not a brief, it is a fragment;
  // callers treat '' as "nothing to save" and fall back to older bullets.
  return trimmed.length >= 600 && !isDegenerate(trimmed) ? trimmed : '';
}

/**
 * Output that reports nothing, however it is worded.
 *
 * Both prompts offer an explicit way out (`NOTHING TO REPORT`) for a segment with
 * no work in it, and the model often ignores it: instead of the phrase it writes
 * *prose about* there being nothing — "Please provide the CONVERSATION text you
 * would like me to summarize", "Since no substantive coding activity occurred…
 * STATE: Waiting for instructions", "DECISIONS: - None made. CHANGES: - No
 * changes." Each clears every size floor, so all three got stored and were then
 * injected into the next session as if they were context.
 *
 * Chasing the phrasings one regex at a time is a losing game — these three were
 * three different wordings of one condition in a single afternoon. What they share
 * is that nothing survives once the scaffolding is removed: strip the section
 * headers the prompt itself dictates, the empty-value words, and the boilerplate
 * about the request, and a real summary still has sentences left while these do not.
 */
function reportsNothing(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (/^\W*nothing to report\W*$/i.test(t)) return true;

  // A reply that opens by asking for the input is never a summary.
  if (/^\W*(?:please\s+(?:provide|paste|share)|(?:it\s+looks\s+like|i\s+(?:don'?t|do\s+not))\s+(?:you\s+)?(?:have\s+)?(?:n[o']?t\s+)?(?:provided|see|received)|i'?m\s+ready\s+(?:to|when)|once\s+you\s+(?:paste|provide))/i.test(t)) return true;

  const stripped = t
    // section scaffolding the prompt asks for, in both flavours
    .replace(/^#{1,4}\s.*$/gim, '')
    .replace(/\b(?:DECISIONS|CHANGES|PROBLEMS|STATE|FILES TOUCHED)\b\s*:?/gi, '')
    // empty-value words and the phrases that only restate the absence
    .replace(/\b(?:none|n\/?a|nothing|no\s+(?:changes?|decisions?|problems?|errors?|files?|substantive|identifiable|reportable)\w*|not\s+applicable|empty|unchanged|made|occurred|reported|to\s+report)\b/gi, '')
    .replace(/\b(?:waiting\s+for\s+instructions?|no\s+further\s+action|awaiting\s+input)\b/gi, '')
    // Sentences ABOUT the segment rather than about the work. A real summary
    // describes what happened; these describe the absence of it, so the clause
    // that frames the segment itself is scaffolding too.
    .replace(/\b(?:since|because|as)\s+(?:there\s+(?:is|are|was|were)\s+)?[^.]*?\b(?:segment|conversation|transcript|provided|excerpt)\b[^.]*\.?/gi, '')
    .replace(/\bthere\s+(?:is|are|was|were)\s+[^.]*\.?/gi, '')
    .replace(/\b(?:in\s+)?the\s+(?:provided\s+)?(?:segment|conversation|transcript|excerpt)\b/gi, '')
    .replace(/\b(?:beyond|apart\s+from|other\s+than)\s+a?\s*(?:user\s+)?(?:greeting|acknowledgement|acknowledgment)\b[^.]*/gi, '')
    // markdown/list punctuation carries no content on its own
    .replace(/[*_`~#>\-–—:;,.!?()\[\]{}"'|\/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Real summaries leave plenty behind (measured: 400+ chars of residue on a
  // genuine brief); the three bad ones above leave under 60.
  return stripped.length < 60;
}

async function callLLM(prompt, maxTokens = config.max_summary_tokens) {
  let raw;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await requestLLM(prompt, maxTokens);
      break;
    } catch (err) {
      // An external GPU hold froze the local server mid-request (see LOCAL
      // HOOKS): wait for it to end, then ask again, so the text this request
      // was summarizing is not lost
      if (config.provider !== 'claude_cli' && attempt < 3 && gpuHeldExternally()) {
        await waitForExternalGpuHold();
        continue;
      }
      throw err;
    }
  }
  if (process.env.SECRETARY_DEBUG) {
    process.stderr.write(`[llm] prompt=${prompt.length} chars, raw=${raw.length} chars: ${JSON.stringify(raw.slice(0, 600))}\n`);
    try { appendFileSync(join(tmpdir(), 'secretary-prompts-debug.txt'), `\n═════ ${new Date().toISOString()} ═════\n${prompt}\n`, 'utf-8'); } catch { /* ignore */ }
  }
  if (isDegenerate(raw)) {
    const salvaged = trimDegenerateTail(raw);
    if (salvaged) {
      process.stderr.write('the-secretary: trimmed degenerate tail (kept the clean prefix)\n');
      return salvaged;
    }
    process.stderr.write('the-secretary: discarded degenerate LLM output (repetition loop)\n');
    return '';
  }
  return raw;
}

/**
 * callLLM for prompts whose answer is a summary. Only there does "reports
 * nothing" mean "discard": a one-line answer (`SAVE|…`, a list of ids, a
 * notification blurb) is short by design and must reach its caller intact.
 */
async function callLLMForSummary(prompt, maxTokens = config.max_summary_tokens) {
  const summary = await callLLM(prompt, maxTokens);
  if (reportsNothing(summary)) {
    process.stderr.write('the-secretary: discarded LLM output (reports no content)\n');
    return '';
  }
  return summary;
}

function requestLLM(prompt, maxTokens = 1500) {
  if (config.provider === 'claude_cli') {
    return callClaudeCLI(prompt, maxTokens);
  }
  return new Promise((resolve, reject) => {
    const url = new URL(config.llm_url);
    const body = JSON.stringify({
      model: detectedModel || config.model,
      messages: [
        { role: 'system', content: 'You are a precise assistant. Follow instructions exactly.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
      // A 4-bit quantized model at near-zero temperature always takes the most
      // likely token, so once it enters a repeating cycle ("CallsCountCallsCount…")
      // nothing breaks it and it fills the whole token budget with garbage. The
      // MLX server defaults both penalties to 0.0 (none), so they must be sent
      // explicitly. Names are MLX's own — `repeat_penalty` (llama.cpp's spelling)
      // is silently ignored here. The context sizes default to 20 tokens, far too
      // short to notice a long loop, hence the wider windows.
      // Apple's on-device model (apfel) rejects frequency_penalty, so it gets none.
      ...(config.local_backend === 'apple' ? {} : {
        repetition_penalty: 1.1,
        repetition_context_size: 256,
        frequency_penalty: 0.3,
        frequency_context_size: 256,
      }),
    });

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch { reject(new Error('LLM response parse error')); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.write(body);
    req.end();
  });
}

let detectedModel = null;

// ── Claude CLI degradation tracking ─────────────────────────────────
// If the CLI fails N times in a row, mark the provider as degraded for
// DEGRADE_MS so we stop retrying on every tool call. State is persisted
// to a tmp file so it survives across the short-lived hook invocations.
const CLAUDE_DEGRADE_FILE = join(tmpdir(), 'secretary-claude-cli-degraded.json');
const CLAUDE_FAIL_THRESHOLD = 2;
const CLAUDE_DEGRADE_MS = 10 * 60_000; // 10 minutes

function readClaudeState() {
  try {
    if (!existsSync(CLAUDE_DEGRADE_FILE)) return { fails: 0, degradedUntil: 0 };
    const raw = readFileSync(CLAUDE_DEGRADE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // Number(), not `| 0`: a millisecond timestamp does not fit in 32 bits, and
    // the truncated value always lay in the past, so the cooldown never held.
    return { fails: Number(parsed.fails) || 0, degradedUntil: Number(parsed.degradedUntil) || 0 };
  } catch { return { fails: 0, degradedUntil: 0 }; }
}

function writeClaudeState(state) {
  try { writeFileSync(CLAUDE_DEGRADE_FILE, JSON.stringify(state), 'utf-8'); } catch { /* ignore */ }
}

function isClaudeDegraded() {
  const s = readClaudeState();
  return s.degradedUntil > Date.now();
}

function recordClaudeFail() {
  const s = readClaudeState();
  s.fails += 1;
  if (s.fails >= CLAUDE_FAIL_THRESHOLD) {
    s.degradedUntil = Date.now() + CLAUDE_DEGRADE_MS;
  }
  writeClaudeState(s);
}

function recordClaudeSuccess() {
  writeClaudeState({ fails: 0, degradedUntil: 0 });
}

// Which Claude account the CLI bills. Each account is a config folder
// (CLAUDE_CONFIG_DIR): a path picks that account, "default" the one with no
// CLAUDE_CONFIG_DIR, and no key keeps whatever the current session uses.
function claudeAccountEnv(account) {
  const env = { ...process.env };
  if (account === 'default') delete env.CLAUDE_CONFIG_DIR;
  else if (account) env.CLAUDE_CONFIG_DIR = account.replace(/^~/, homedir());
  return env;
}

function callClaudeCLI(prompt, maxTokens = 1500) {
  return new Promise((resolve, reject) => {
    if (isClaudeDegraded()) {
      return reject(new Error('claude CLI provider is degraded (cooling down after repeated failures)'));
    }
    const bin = config.claude_bin;
    const model = config.claude_model;
    // This call is itself a Claude session: with hooks on, its Stop hook runs
    // The Secretary again, which calls the CLI again — an unbounded chain of
    // summaries of summaries. Hooks off breaks the chain; no persistence keeps
    // these throwaway sessions out of the project's transcript folder.
    const args = ['-p', '--model', model, '--output-format', 'json',
      '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];
    const child = execFile(bin, args, {
      timeout: 45000,
      maxBuffer: 10 * 1024 * 1024,
      env: claudeAccountEnv(config.claude_config_dir),
    }, (err, stdout, stderr) => {
      if (err) {
        recordClaudeFail();
        return reject(new Error(`claude CLI failed: ${err.message} ${stderr || ''}`));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        recordClaudeFail();
        return reject(new Error(`claude CLI parse error: ${e.message}`));
      }
      // Strict success validation: any deviation = failure (no silent passes).
      if (parsed.is_error) {
        recordClaudeFail();
        return reject(new Error(`claude CLI api error: ${parsed.api_error_status || 'unknown'}`));
      }
      if (parsed.subtype && parsed.subtype !== 'success') {
        recordClaudeFail();
        return reject(new Error(`claude CLI non-success subtype: ${parsed.subtype}`));
      }
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        recordClaudeFail();
        return reject(new Error(`claude CLI returned errors: ${JSON.stringify(parsed.errors).slice(0, 200)}`));
      }
      const result = typeof parsed.result === 'string' ? parsed.result.trim() : '';
      if (!result) {
        recordClaudeFail();
        return reject(new Error('claude CLI returned empty result'));
      }
      recordClaudeSuccess();
      resolve(result);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function isLLMAvailable() {
  if (config.provider === 'claude_cli') {
    if (isClaudeDegraded()) return Promise.resolve(false);
    return Promise.resolve(existsSync(config.claude_bin));
  }
  return new Promise((resolve) => {
    const url = new URL(config.llm_url);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/models',
      method: 'GET',
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            // /v1/models lists EVERY model in the HF cache, not the loaded one,
            // and its order is alphabetical — data[0] was picking
            // Qwen2.5-3B-Instruct-4bit regardless of what config.model asked
            // for, so the configured model was silently ignored. Only fall back
            // to autodetection when the configured model isn't served at all.
            const ids = (parsed.data || []).map(m => m.id).filter(Boolean);
            detectedModel = ids.includes(config.model) ? null : (ids[0] || null);
          } catch {}
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ═══════════════════ LOCAL HOOKS ═══════════════════
// Optional machine-specific behaviour lives in local/hooks.mjs next to this
// file (start-llm.sh has its twin, local/hooks.sh). The folder is never shipped
// and install.sh never touches it, so it survives upgrades. Without it every
// hook below is a no-op.
//
//   gpuHeldExternally()  true while something outside The Secretary needs the
//                        GPU to itself. Everything local then yields to it:
//                        acquireGpuLock treats the GPU as held, the background
//                        summarizer waits (its text is kept, nothing goes
//                        online) and a request that failed meanwhile is retried.
const LOCAL_HOOKS = join(SECRETARY_DIR, 'local', 'hooks.mjs');

let localHooks = {};
if (existsSync(LOCAL_HOOKS)) {
  try { localHooks = await import(LOCAL_HOOKS); }
  catch (err) { process.stderr.write(`[secretary] local hooks failed to load: ${err.message}\n`); }
}

function gpuHeldExternally() {
  try { return !!localHooks.gpuHeldExternally?.(); }
  catch { return false; }
}

async function waitForExternalGpuHold() {
  while (gpuHeldExternally()) await new Promise(r => setTimeout(r, 2000));
}

async function ensureLLMRunning() {
  if (config.provider === 'claude_cli') {
    if (isClaudeDegraded()) return false;
    return existsSync(config.claude_bin);
  }
  const startScript = join(SECRETARY_DIR, 'start-llm.sh');
  if (!(await isLLMAvailable())) {
    if (!existsSync(startScript)) return false;
    try {
      execSync(`bash "${startScript}" start`, { timeout: 30000, stdio: 'ignore' });
    } catch {
      return false;
    }
    if (!(await isLLMAvailable())) return false;
  }
  // Record the use: the server is shared by every session's workers, so none
  // of them stops it. start-llm.sh's idle reaper does, once this goes stale.
  try { execSync(`bash "${startScript}" touch`, { stdio: 'ignore' }); } catch { /* best-effort */ }
  return true;
}

// ═══════════════════ BG WORKER LOCK + DEBOUNCE ═══════════════════
//
// Prevents a flood of concurrent _bg_summarize processes from queuing up on
// slower machines. If a worker is still alive, skip spawning a new one.
// Also enforces a minimum gap between launches (debounce).

const BG_DEBOUNCE_MS = 30_000;

// Detached workers have no terminal, so what they write to stderr (why a
// summary was discarded, why the LLM was unreachable) is lost. With
// SECRETARY_DEBUG set it is appended to this file instead.
const WORKER_DEBUG_LOG = join(tmpdir(), 'secretary-worker-debug.log');

function workerStdio() {
  if (!process.env.SECRETARY_DEBUG) return 'ignore';
  return ['ignore', 'ignore', openSync(WORKER_DEBUG_LOG, 'a')];
}

function bgLockPath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(tmpdir(), `secretary-bg-${safe}.lock`);
}

function canSpawnBgWorker(sessionId) {
  const lockFile = bgLockPath(sessionId);
  if (!existsSync(lockFile)) return true;
  try {
    const raw = readFileSync(lockFile, 'utf-8').trim();
    const [pidStr, tsStr] = raw.split('|');
    const pid = parseInt(pidStr, 10);
    const ts = parseInt(tsStr, 10) || 0;

    // Worker still alive → skip
    if (pid > 0) {
      try { process.kill(pid, 0); return false; } catch { /* dead */ }
    }
    // Debounce window not elapsed → skip even if previous worker is dead
    if (Date.now() - ts < BG_DEBOUNCE_MS) return false;
  } catch { /* malformed lock, fall through */ }
  return true;
}

function registerBgWorker(sessionId, pid) {
  try {
    writeFileSync(bgLockPath(sessionId), `${pid}|${Date.now()}`, 'utf-8');
  } catch { /* ignore */ }
}

function clearBgWorker(sessionId) {
  try { unlinkSync(bgLockPath(sessionId)); } catch { /* ignore */ }
}

// Per-project lock: ensures at most ONE background worker per cwd, even if
// multiple Claude sessions are open in the same project. Prevents the
// "tormenta de procesos" when Claude CLI is the provider and several sessions
// fire summaries / deletes / regenerates at the same time.
function bgProjectLockPath(cwd) {
  const key = createHash('sha1').update(String(cwd || 'default')).digest('hex').slice(0, 16);
  return join(tmpdir(), `secretary-bg-project-${key}.lock`);
}

function canSpawnBgWorkerForProject(cwd) {
  const lockFile = bgProjectLockPath(cwd);
  if (!existsSync(lockFile)) return true;
  try {
    const raw = readFileSync(lockFile, 'utf-8').trim();
    const [pidStr, tsStr] = raw.split('|');
    const pid = parseInt(pidStr, 10);
    const ts = parseInt(tsStr, 10) || 0;
    if (pid > 0) {
      try { process.kill(pid, 0); return false; } catch { /* dead */ }
    }
    if (Date.now() - ts < BG_DEBOUNCE_MS) return false;
  } catch { /* malformed, fall through */ }
  return true;
}

function registerBgWorkerForProject(cwd, pid) {
  try { writeFileSync(bgProjectLockPath(cwd), `${pid}|${Date.now()}`, 'utf-8'); } catch { /* ignore */ }
}

function clearBgWorkerForProject(cwd) {
  try { unlinkSync(bgProjectLockPath(cwd)); } catch { /* ignore */ }
}

// PID of the live process a lock file names, or 0 (no lock, dead, malformed)
function liveLockPid(lockFile) {
  if (!existsSync(lockFile)) return 0;
  try {
    const pid = parseInt(readFileSync(lockFile, 'utf-8').split('|')[0], 10);
    if (pid > 0) { process.kill(pid, 0); return pid; }
  } catch { /* dead or malformed */ }
  return 0;
}

// PID of the `claude` CLI process this hook runs under. /clear keeps that
// process and only swaps the session id, so it is what ties a new session to
// the one it replaced; another terminal on the same project has its own.
function claudeCliPid() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const [ppid, ...comm] = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split(/\s+/);
      if (basename(comm.join(' ')) === 'claude') return pid;
      pid = parseInt(ppid, 10);
    } catch { return 0; }
  }
  return 0;
}

// Handoff lock: the summarizer spawned by force --stop-llm, keyed by project
// root AND claude CLI, so only the session this terminal just left counts —
// never another session open on the same project.
function handoffLockPath(cwd) {
  const root = resolveProjectRoot(cwd) || cwd || 'default';
  const key = createHash('sha1').update(`${root}|${claudeCliPid()}`).digest('hex').slice(0, 16);
  return join(tmpdir(), `secretary-handoff-${key}.lock`);
}

function registerHandoffWorker(cwd, sessionId, pid) {
  try { writeFileSync(handoffLockPath(cwd), `${pid}|${Date.now()}|${sessionId}`, 'utf-8'); } catch { /* ignore */ }
}

// Session this terminal ran before `sessionId` (the one /clear just left), or
// ''. The handoff lock is the only record of which session a terminal ran, so
// force() keeps it current even when it spawns no summarizer.
function previousSessionId(cwd, sessionId) {
  try {
    const prev = readFileSync(handoffLockPath(cwd), 'utf-8').trim().split('|')[2] || '';
    return prev === sessionId ? '' : prev;
  } catch { return ''; }
}

// Live handoff summarizer of a PREVIOUS session in this terminal, or 0. This
// session's own handoffs (one per reply, via the Stop hook) do not count.
function previousHandoffPid(cwd, sessionId) {
  const lockFile = handoffLockPath(cwd);
  const pid = liveLockPid(lockFile);
  if (!pid) return 0;
  try {
    if (readFileSync(lockFile, 'utf-8').trim().split('|')[2] === sessionId) return 0;
  } catch { return 0; }
  return pid;
}

// Blocks until that summarizer exits. No time cap: liveLockPid() checks the pid,
// so a lock left by a dead worker ends the wait on the next poll.
async function waitForPreviousHandoff(cwd, sessionId) {
  while (previousHandoffPid(cwd, sessionId)) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ═══════════════════ NOTIFICATIONS ═══════════════════

/**
 * Short project name for notification titles.
 * Prefers the git repo root so every subdirectory of one repo notifies under the
 * same name; resolveProjectRoot() anchors on any nested .claude/ marker, which
 * would otherwise title the same project differently depending on the cwd.
 */
function projectLabel(cwd) {
  try {
    if (!cwd || cwd === '__global__') return '';
    try {
      const gitRoot = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (gitRoot) return basename(gitRoot);
    } catch { /* not a repo, or git unavailable */ }
    const root = resolveProjectRoot(cwd);
    return root ? basename(root) : '';
  } catch { return ''; }
}

function notifyMemoryRecovered(cwd, message) {
  const proj = projectLabel(cwd);
  notify(proj ? `${proj} — Memory recovered` : 'The Secretary — Memory recovered', message);
}

function notify(title, message) {
  try {
    execSync(`osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`, { timeout: 3000, stdio: 'ignore' });
  } catch { /* silent */ }
}

// ═══════════════════ TRANSCRIPT PARSING ═══════════════════

/**
 * Harness noise that reaches the transcript as user text but carries no intent:
 * slash-command plumbing, interruption markers, subagent notifications, hook output.
 * Stripping it keeps the summarizer's budget for what the user actually said.
 */
const NOISE_PATTERNS = [
  // NOTE: the tag groups MUST be capturing — `\1` refers to them. Written as (?:...)
  // the backreference had nothing to bind to, so these two patterns silently matched
  // nothing and every slash-command wrapper landed verbatim in the index.
  /<command-(name|message|args|contents)>[\s\S]*?<\/command-\1>/g,
  /<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g,
  // Same tags left unclosed: a turn is truncated at 3000 chars, which can cut the
  // closing tag off and leave the opening one stranded.
  /<\/?(?:command-(?:name|message|args|contents)|local-command-(?:stdout|stderr|caveat))>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /\[Request interrupted by user(?: for tool use)?\]/g,
  /\[Image(?: #\d+)?(?::[^\]]*)?\]/g,
];

function stripNoise(text) {
  let out = text;
  for (const re of NOISE_PATTERNS) out = out.replace(re, ' ');
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Acknowledgements carry no information worth a slot in the summary budget. */
const FILLER_RE = /^(?:ok(?:ay)?|vale|dale|sigue|continua|continúa|gracias|thanks|thx|si|sí|no|yes|yep|nope|y|and|perfecto|genial|bien|good|great|👍|ya|listo)[\s.!?]*$/i;

/**
 * Tools whose file_path means the file was MODIFIED vs merely inspected. A handoff
 * that calls a file "changed" when it was only read is the same class of error as
 * inventing the path, so the verb is taken from the tool, never guessed.
 */
const FILE_WRITERS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const FILE_READERS = new Set(['Read', 'Grep', 'Glob']);

function parseTranscript(transcriptPath, fromOffset = 0) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { messages: [], rawLength: 0, filesTouched: new Map() };
  }

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];
  // Ground truth for "Key files touched". Tool traffic is admitted to the summary
  // budget LAST (see messagesToText), and on a real session the talk turns consume
  // all of it — measured: 7980 of 8000 chars, leaving 20, so 0 of 178 tool turns got
  // in and the model saw ZERO file paths while being told to "quote exact paths".
  // It filled the gap with plausible inventions (26 fabricated paths across three
  // projects). This manifest is built straight from tool_use blocks, costs ~300
  // chars for a whole session, and is passed to the model as authoritative.
  const filesTouched = new Map();
  // The first cwd the session reports is where it was launched (the project
  // root); later entries follow the shell wherever a command cd'd to.
  let sessionRoot = '';

  for (let i = fromOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!sessionRoot && entry.cwd) sessionRoot = entry.cwd;
      const msg = entry.message || entry;
      // Only real conversation roles. A transcript also carries bookkeeping entries
      // ('attachment', 'last-prompt', 'mode', 'system', 'queue-operation', …) that have
      // no message.role; falling back to entry.type filed them all as 'tool', and
      // 'last-prompt' duplicated the user's own prompt into the index.
      const role = msg.role;

      if (role !== 'user' && role !== 'assistant') continue;

      const content = msg.content;
      // Conversation text and tool traffic are collected apart: they are ranked
      // separately later, so tool noise can never crowd out what was actually said.
      let text = '';
      let toolText = '';
      // Pasted screenshots travel inline as base64. Claude Code's own copy lives in
      // /private/tmp and dies with the session, so the transcript is the only
      // durable source; indexTranscript() persists them next to the DB.
      const images = [];

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            text += block.text + '\n';
          } else if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) {
            images.push(block.source);
          } else if (block.type === 'tool_use') {
            toolText += `[Tool: ${block.name}] ${JSON.stringify(block.input || {}).slice(0, 200)}\n`;
            let fp = block.input?.file_path || block.input?.notebook_path;
            // Relative to the session's root: absolute paths under a deep project
            // root cost ~150 chars each, so the manifest cap cut the list after
            // 8 files and the session's most edited files never reached the model.
            if (fp && sessionRoot && fp.startsWith(sessionRoot + '/')) fp = fp.slice(sessionRoot.length + 1);
            if (fp) {
              const verb = FILE_WRITERS.has(block.name) ? 'changed'
                : FILE_READERS.has(block.name) ? 'read' : 'used';
              // A write outranks an earlier read of the same file.
              const prev = filesTouched.get(fp);
              if (!prev || (prev !== 'changed' && verb === 'changed')) filesTouched.set(fp, verb);
            }
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            toolText += `[Result] ${resultText.slice(0, 200)}\n`;
          }
        }
      }

      text = stripNoise(text);

      const mappedRole = role;

      // The transcript stamps every entry; keeping it lets the index answer
      // "what were we doing" by recency instead of only by keyword match.
      const ts = entry.timestamp || '';

      // Full text, never truncated here: the index stores it whole (in chunks) and
      // the summarizer applies its own per-turn cap in messagesToText().
      if ((text.length > 10 && !FILLER_RE.test(text)) || images.length) {
        messages.push({ role: mappedRole, kind: 'talk', text, images, line: i, ts });
      } else if (toolText.trim().length > 10) {
        messages.push({ role: 'tool', kind: 'tool', text: toolText.trim().slice(0, 1000), line: i, ts });
      }
    } catch (err) {
      if (process.env.SECRETARY_DEBUG) process.stderr.write(`[parse] line ${i} skipped: ${err.message}\n`);
    }
  }

  return { messages, rawLength: lines.length, filesTouched };
}

/**
 * Build the summarizer input under a char budget.
 *
 * Two rules, both learned the hard way from transcripts where the summary came out
 * describing tool output instead of the work:
 *  - Conversation turns (user and assistant together) are admitted first; tool
 *    traffic fills whatever is left, if anything.
 *  - Selection walks BACKWARDS. The end of a session holds its current state, which is
 *    what a handoff needs; truncating from the front kept only the stale opening.
 * Emitted output is restored to chronological order so the model reads a conversation.
 */
/**
 * Render the files-touched manifest that prefixes the summarizer input.
 * Writes come first: a handoff cares about what changed, and a long read-only
 * list would otherwise push the changes out of view.
 */
function filesTouchedBlock(filesTouched, maxChars = 1200) {
  if (!filesTouched?.size) return '';
  const rank = { changed: 0, used: 1, read: 2 };
  const rows = [...filesTouched].sort((a, b) => (rank[a[1]] ?? 3) - (rank[b[1]] ?? 3));
  let out = '';
  for (const [path, verb] of rows) {
    const line = `- ${path} (${verb})\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  if (!out) return '';
  return `FILES TOUCHED (from this session's tool calls — authoritative; do NOT list any file absent from here). Relative paths are under the session's working directory:\n${out}\n`;
}

const SUMMARY_TURN_CHARS = 3000;

/**
 * The literal end of a conversation, newest turns kept whole until `maxChars`
 * (the oldest kept turn is cut from its front). Unlike messagesToText() it is
 * contiguous: it shows where the session stopped, including whether the last
 * reply finished the task or broke off mid-way.
 */
function transcriptTail(messages, maxChars) {
  const turnCap = Math.max(500, Math.floor(maxChars / 3));
  const format = (m) => {
    const prefix = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL';
    // A tool turn only needs to show that a step ran: one line, not its output.
    let body = m.kind === 'tool' ? m.text.trim().split('\n')[0] : m.text.trim();
    const cap = m.kind === 'tool' ? 200 : turnCap;
    if (body.length > cap) body = body.slice(0, cap) + '…';
    return `[${prefix}]: ${body}`;
  };
  messages = messages.filter(m => m.text);
  // The last request always goes in: a run of tool calls can fill the whole
  // budget, and without the ask the tail cannot say whether it was finished.
  let askAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].kind === 'talk') { askAt = i; break; }
  }
  const ask = askAt >= 0 ? format(messages[askAt]) : '';
  const rows = [];
  let used = ask.length;
  let i = messages.length - 1;
  for (; i > askAt && used < maxChars; i--) {
    let row = format(messages[i]);
    if (used + row.length > maxChars) row = '…' + row.slice(row.length - (maxChars - used));
    rows.unshift(row);
    used += row.length + 2;
  }
  if (ask) {
    if (i > askAt) rows.unshift(`[… ${i - askAt} turns omitted …]`);
    rows.unshift(ask);
  }
  return rows.join('\n\n');
}

function messagesToText(messages, maxChars = 8000, filesTouched = null) {
  const budget = { used: 0 };
  const picked = new Set();
  // One huge turn (a pasted log) must not eat the whole budget: cap each turn.
  messages = messages
    .filter(m => m.text)
    .map(m => m.text.length > SUMMARY_TURN_CHARS ? { ...m, text: m.text.slice(0, SUMMARY_TURN_CHARS) } : m);

  const admit = (list) => {
    for (const m of list) {
      const cost = m.text.length + 16;
      if (budget.used + cost > maxChars) continue;
      budget.used += cost;
      picked.add(m);
    }
  };

  // The manifest is charged to the budget so a long file list can't silently
  // push the conversation itself out of the prompt.
  const manifest = filesTouchedBlock(filesTouched);
  budget.used += manifest.length;

  // Both sides of the conversation in one recency pass. Admitting every user
  // turn before any assistant turn let a long session's requests fill the whole
  // budget: the model saw only asks, no replies, and answered NOTHING TO REPORT
  // for a day of real work, so no handoff was stored after the session grew.
  const recentFirst = [...messages].reverse();
  admit(recentFirst.filter(m => m.kind === 'talk'));
  admit(recentFirst.filter(m => m.kind === 'tool'));

  let text = '';
  for (const m of messages) {
    if (!picked.has(m)) continue;
    const prefix = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL';
    text += `[${prefix}]: ${m.text}\n\n`;
  }
  return manifest ? `${manifest}\n${text}` : text;
}

// Rows are chunks, not whole turns: a long turn used to be cut at 3000 chars and
// lose its tail, and the embedder only reads the first ~1000 chars of each row.
const TURN_CHUNK_CHARS = 800;

/** Split text at the latest paragraph / line / sentence / word break that keeps chunks ≥ half full. */
function chunkText(text, max = TURN_CHUNK_CHARS) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', ' ']) {
      const at = win.lastIndexOf(sep);
      if (at >= max / 2) { cut = at + sep.length; break; }
    }
    if (cut < 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Persist base64 images next to the DB, named by content hash. Returns their paths. */
function saveTurnImages(images, cwd) {
  if (!images?.length) return [];
  const root = resolveProjectRoot(cwd);
  const dir = join(root ? ensureProjectDataDir(root) : SECRETARY_DIR, 'images');
  const paths = [];
  for (const src of images) {
    try {
      mkdirSync(dir, { recursive: true });
      const buf = Buffer.from(src.data, 'base64');
      const ext = (src.media_type || 'image/png').split('/')[1].replace('jpeg', 'jpg');
      const file = join(dir, `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`);
      if (!existsSync(file)) writeFileSync(file, buf);
      paths.push(file);
    } catch { /* one bad image must not drop the turn */ }
  }
  return paths;
}

/**
 * Store a transcript's conversation verbatim in the FTS index — the transcript is the
 * source of truth, the summaries are only a layer on top of it.
 *
 * Reads from its OWN cursor (`fts-line:<session>`), never from the summarizer's
 * `offset:`. Fed from the summarizer's offset, every turn that the Stop hook
 * consumed before the next tool call was skipped for good: pure-chat exchanges
 * (no tool call in between) never reached the index.
 *
 * Only `talk` turns are kept — tool traffic is machine chatter nobody recalls in words.
 */
function indexTranscript(db, transcriptPath, { session_id, cwd }) {
  if (!db || !transcriptPath || !session_id) return 0;

  const guardKey = `fts-line:${session_id}`;
  let lastLine = -1;
  try {
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(guardKey);
    if (row) lastLine = parseInt(row.value, 10);
  } catch { return 0; }

  const { messages } = parseTranscript(transcriptPath, lastLine + 1);
  const talk = messages.filter(m => m.kind === 'talk' && (m.text.length >= 20 || m.images?.length));
  if (!talk.length) return 0;

  try {
    const insert = db.prepare(
      'INSERT INTO turns (body, role, session_id, project_dir, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    // Prefer the turn's own timestamp; fall back to now only for entries that lack one
    // (older transcript formats). Indexing time is not conversation time: a backfill
    // would otherwise stamp thousands of turns with one identical instant.
    const now = new Date().toISOString();
    let rows = 0;
    db.transaction(() => {
      for (const m of talk) {
        const images = saveTurnImages(m.images, cwd).map(p => `[imagen: ${p}]`);
        const body = [m.text, ...images].join('\n').trim();
        for (const chunk of chunkText(body)) {
          insert.run(chunk, m.role, session_id, cwd || '', m.ts || now);
          rows++;
        }
      }
      const maxLine = talk.reduce((a, m) => Math.max(a, m.line), lastLine);
      db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
        .run(guardKey, String(maxLine));
    })();
    return rows;
  } catch {
    return 0; // FTS table missing (old DB, no FTS5) — never break summarization
  }
}

/**
 * Build an FTS5 MATCH expression that degrades gracefully.
 *
 * Terms are OR-ed with a prefix wildcard, so a query still returns its best partial
 * matches instead of nothing when one word is absent — bm25 ranks whatever matched
 * most. Quotes/operators are stripped: user text must never be read as FTS syntax.
 */
function buildMatchQuery(terms) {
  const safe = terms
    .map(t => t.replace(/["*()^:-]/g, '').trim())
    .filter(t => t.length >= 2);
  if (!safe.length) return null;
  return safe.map(t => `"${t}"*`).join(' OR ');
}

// ═══════════════════ SEMANTIC FALLBACK (sqlite-vec + local embeddings) ═══════════════════
//
// FTS5 answers the literal question ("did we touch component.css?") exactly, and its
// zero is meaningful. What it cannot do is bridge vocabulary: "espaciado vertical"
// never matches the turn that says "les falta gap vertical".
//
// Measured on a real 2k-turn project index:
//   - literal queries: FTS5 finds every occurrence of an identifier; vectors recover 8%
//   - conceptual queries: FTS5 OR-matching returns 1000+ noise rows; vectors nail it
//
// So the two are not interchangeable and neither replaces the other. FTS5 runs first
// and owns the literal answer; vectors run ONLY when FTS5 came up short, and their
// hits are tagged `approx` so a semantic neighbour is never mistaken for a quote.

const VEC_DIM = 1024;                       // Qwen3-Embedding-0.6B
// Calibrated against this index: real topics scored 0.58-0.78, invented ones 0.55-0.65.
// The ranges OVERLAP — no threshold separates them cleanly, so a vector hit can never
// prove a topic was discussed. 0.62 drops most invented queries; whatever survives is
// still reported as `approx`, and the caller must treat it as "similar wording found",
// never as evidence. Only an FTS5 hit proves something was actually said.
// 0.62 was the cutoff while vectors were a standalone fallback. Fused with FTS5, the
// RANK decides, and 0.62 threw away real answers: "the site similar to X" put the turn
// saying "a site like X" 9th among 10k — at 0.582. The floor now only
// drops the plainly unrelated; real topics start at 0.58.
const VEC_MIN_SIM = 0.5;
const EMBED_SCRIPT = join(SECRETARY_DIR, 'embed.py');

function embedPython() {
  return config.embed_python || join(SECRETARY_DIR, 'venv', 'bin', 'python');
}

/** Semantic search is optional: without the venv and sqlite-vec we simply stay on FTS5. */
function semanticAvailable() {
  try {
    if (!existsSync(EMBED_SCRIPT) || !existsSync(embedPython())) return false;
    loadVecExtension.probe ??= (() => {
      try { createRequire(import.meta.url)('sqlite-vec'); return true; } catch { return false; }
    })();
    return loadVecExtension.probe;
  } catch { return false; }
}

function loadVecExtension(db) {
  try {
    const require = createRequire(import.meta.url);
    require('sqlite-vec').load(db);
    return true;
  } catch { return false; }
}

// Serialises every Metal workload this tool owns. embed.py opens its own Metal
// context while the mlx_lm server already holds one; running both at once made
// a command buffer come back with an error, and MLX turns that into an abort()
// from Metal's completion queue. The process then dies with buffers in flight,
// leaking IOGPU resources until the display itself corrupts. One GPU consumer
// at a time — the same mkdir-based lock start-llm.sh uses for its spawn race.
const GPU_LOCK_DIR = join(tmpdir(), 'the-secretary-gpu.lock');
const GPU_LOCK_STALE_MS = 5 * 60_000;
const GPU_LOCK_WAIT_MS = 90_000;

let gpuLockDepth = 0;

function acquireGpuLock(waitMs = GPU_LOCK_WAIT_MS) {
  // Reentrant: index-vectors holds it across every batch so the mlx_lm server
  // cannot slip a Metal context in between two embed runs.
  if (gpuLockDepth > 0) { gpuLockDepth++; return true; }
  const deadline = Date.now() + waitMs;
  for (;;) {
    // An external GPU hold counts as held (see LOCAL HOOKS)
    if (gpuHeldExternally()) {
      if (Date.now() > deadline) return false;
      try { execFileSync('sleep', ['0.25'], { stdio: 'ignore' }); } catch { return false; }
      continue;
    }
    try { mkdirSync(GPU_LOCK_DIR); gpuLockDepth = 1; return true; } catch { /* held */ }
    try {
      const age = Date.now() - statSync(GPU_LOCK_DIR).mtimeMs;
      if (age > GPU_LOCK_STALE_MS) {
        // Holder died without releasing (an abort leaves the dir behind).
        rmSync(GPU_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
    } catch { continue; }
    if (Date.now() > deadline) return false;
    try { execFileSync('sleep', ['0.25'], { stdio: 'ignore' }); } catch { return false; }
  }
}

function releaseGpuLock() {
  if (gpuLockDepth > 1) { gpuLockDepth--; return; }
  gpuLockDepth = 0;
  try { rmSync(GPU_LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Embed texts via the helper process. Returns Float32Array[] or null on any failure. */
function embedTexts(texts, { lockWaitMs } = {}) {
  if (!texts?.length || !semanticAvailable()) return null;
  if (!acquireGpuLock(lockWaitMs)) {
    process.stderr.write('[secretary] embed skipped: GPU lock busy\n');
    return null;
  }
  try {
    const out = execFileSync(embedPython(), [EMBED_SCRIPT], {
      input: JSON.stringify({ texts }),
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf-8',
      // stderr inherited on purpose: swallowing it is what hid six consecutive
      // Metal aborts behind a silent fallback to FTS5.
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const parsed = JSON.parse(out);
    if (parsed.error) {
      process.stderr.write(`[secretary] embed failed: ${parsed.error}\n`);
      return null;
    }
    if (!parsed.vectors?.length) return null;
    return parsed.vectors.map(v => new Float32Array(v));
  } catch (e) {
    process.stderr.write(`[secretary] embed helper crashed: ${e?.message || e}\n`);
    return null;
  } finally {
    releaseGpuLock();
  }
}

/** Nearest turns by cosine similarity. Returns [] whenever the stack is unavailable. */
function vectorSearch(db, query, limit) {
  if (!semanticAvailable()) return [];
  try {
    if (!loadVecExtension(db)) return [];
    const has = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'vturns'").get()?.n;
    if (!has) return [];
    // Search runs inside a 10 s prompt hook: a GPU held by index-vectors must cost
    // the semantic half of the answer, never the whole answer.
    const [qv] = embedTexts([query], { lockWaitMs: 2000 }) || [];
    if (!qv) return [];
    const rows = db.prepare(`
      SELECT v.turn_rowid AS rid, v.distance AS distance
      FROM (SELECT rowid AS turn_rowid, distance FROM vturns
            WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
    `).all(qv, limit * 3);
    const out = [];
    for (const r of rows) {
      // vec0 returns L2 distance over unit vectors: cos = 1 - d²/2.
      const sim = 1 - (r.distance * r.distance) / 2;
      if (sim < VEC_MIN_SIM) continue;
      const t = db.prepare('SELECT rowid AS rid, body, role, project_dir, created_at FROM turns WHERE rowid = ?').get(r.rid);
      if (t) out.push({ ...t, sim });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// ═══════════════════ DATE PARSING ═══════════════════

// A date in a recall question ("qué hicimos ayer", "lo del martes pasado",
// "last week", "hace 3 días", "el 5 de octubre", "2026-10-28") narrows the
// search to that span of local time. Returns { from, to, index, phrase } —
// `to` is exclusive; `index`/`phrase` locate the date words so the caller can
// search for the rest — or null when the text names no date.
const WEEKDAYS = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7,
  septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
};
const NUMBER_WORDS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};
const WEEKDAY_RX = Object.keys(WEEKDAYS).join('|');
const MONTH_RX = Object.keys(MONTHS).join('|');

// Lowercase and strip accents one character for one, so a match index in the
// folded text is also valid in the original.
const foldSameLength = (s) => s.toLowerCase()
  .replace(/[áàâä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
  .replace(/[óòôö]/g, 'o').replace(/[úùûü]/g, 'u');

function parseDateRange(text, now = new Date()) {
  const s = foldSameLength(text || '');
  const day = (d, add = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + add);
  const today = day(now);
  const count = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w]) || 0;
  const monday = (d) => day(d, -((d.getDay() + 6) % 7));
  // A day or month named without a year is the most recent one not in the future.
  const pastYear = (month, date = 1) =>
    new Date(today.getFullYear(), month, date) > today ? today.getFullYear() - 1 : today.getFullYear();
  const oneDay = (d) => ({ from: d, to: day(d, 1) });
  const dayOf = (month, date) => oneDay(new Date(pastYear(month, date), month, date));
  const monthOf = (month) => {
    const y = pastYear(month);
    return { from: new Date(y, month, 1), to: new Date(y, month + 1, 1) };
  };
  const ago = (k, unit) => {
    if (!k) return null;
    if (/^d/.test(unit)) return oneDay(day(today, -k));
    if (/^(?:s|w)/.test(unit)) return { from: day(today, -7 * k), to: day(today, -7 * (k - 1)) };
    return { from: new Date(today.getFullYear(), today.getMonth() - k, 1), to: new Date(today.getFullYear(), today.getMonth() - k + 1, 1) };
  };

  // Most specific first: an explicit date beats "ayer" in the same sentence.
  const rules = [
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => oneDay(new Date(+m[1], m[2] - 1, +m[3]))],
    [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/, (m) => m[3]
      ? oneDay(new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[2] - 1, +m[1]))
      : dayOf(m[2] - 1, +m[1])],
    [new RegExp(`\\b(?:el\\s+)?(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_RX})\\b`), (m) => dayOf(MONTHS[m[2]], +m[1])],
    [new RegExp(`\\b(${MONTH_RX})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`), (m) => dayOf(MONTHS[m[1]], +m[2])],
    [/\b(?:anteayer|antes\s+de\s+ayer|(?:the\s+)?day\s+before\s+yesterday)\b/, () => oneDay(day(today, -2))],
    [/\b(?:ayer|yesterday)\b/, () => oneDay(day(today, -1))],
    [/\b(?:hoy|today)\b/, () => oneDay(today)],
    [/\b(?:(?:en\s+)?los\s+)?(?:ultimos|last|past)\s+(\d+|[a-z]+)\s+(dias|days|semanas|weeks)\b/, (m) => {
      const k = count(m[1]) * (/^(?:s|w)/.test(m[2]) ? 7 : 1);
      return k ? { from: day(today, -k), to: day(today, 1) } : null;
    }],
    [/\bhace\s+(\d+|[a-z]+)\s+(dias?|semanas?|mes(?:es)?)\b/, (m) => ago(count(m[1]), m[2])],
    [/\b(\d+|[a-z]+)\s+(days?|weeks?|months?)\s+ago\b/, (m) => ago(count(m[1]), m[2])],
    [/\b(?:(?:la\s+)?semana\s+pasada|last\s+week)\b/, () => ({ from: day(monday(today), -7), to: monday(today) })],
    [/\b(?:esta\s+semana|this\s+week)\b/, () => ({ from: monday(today), to: day(today, 1) })],
    [/\b(?:(?:el\s+)?mes\s+pasado|last\s+month)\b/, () => ({
      from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1),
    })],
    [/\b(?:este\s+mes|this\s+month)\b/, () => ({ from: new Date(today.getFullYear(), today.getMonth(), 1), to: day(today, 1) })],
    // "el martes", "el martes pasado", "martes pasado", "last tuesday", "on tuesday":
    // the latest such day before today. A bare weekday word is left alone.
    [new RegExp(`\\b(?:el\\s+(${WEEKDAY_RX})(?:\\s+pasado)?|(${WEEKDAY_RX})\\s+pasado|(?:last|on)\\s+(${WEEKDAY_RX}))\\b`), (m) => {
      const wd = WEEKDAYS[m[1] || m[2] || m[3]];
      return oneDay(day(today, -((today.getDay() - wd + 7) % 7 || 7)));
    }],
    [new RegExp(`\\b(?:en|in)\\s+(${MONTH_RX})\\b`), (m) => monthOf(MONTHS[m[1]])],
  ];

  for (const [rx, toRange] of rules) {
    const m = s.match(rx);
    if (!m) continue;
    const range = toRange(m);
    if (range && !isNaN(range.from) && range.to > range.from) return { ...range, index: m.index, phrase: m[0] };
  }
  return null;
}

// The span as each table stores it: turns in ISO UTC, summaries in SQLite's UTC text.
function dateBounds(range) {
  const iso = [range.from.toISOString(), range.to.toISOString()];
  return { turns: iso, summaries: iso.map((t) => t.replace('T', ' ').slice(0, 19)) };
}

// A question that is only a date ("qué hicimos ayer"): what happened then, oldest
// first — the session handoffs written in that span, else its other summaries.
function searchByDate(cwd, range, { maxHits, snippetChars }) {
  const db = openDb(cwd);
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT project_dir, summary, created_at FROM all_items
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at
    `).all(...dateBounds(range).summaries);
    const handoffs = rows.filter((r) => r.summary.startsWith('[HANDOFF]'));
    // Stored in UTC; shown in the user's local time, like the dates they asked about.
    const local = (utc) => {
      const d = new Date(`${utc.replace(' ', 'T')}Z`);
      const p = (n) => String(n).padStart(2, '0');
      return isNaN(d) ? utc : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    return (handoffs.length ? handoffs : rows).slice(-maxHits).map((r) => ({
      source: 'db',
      project: basename(r.project_dir || '') || 'unknown',
      date: local(r.created_at || ''),
      score: 0,
      snippet: r.summary.slice(0, snippetChars).trim(),
    }));
  } catch { return []; }
  finally { db.close(); }
}


// ═══════════════════ INTENT CLASSIFICATION ═══════════════════

/**
 * Pre-filter: cheap regex to detect lines that MIGHT be secretary orders.
 * This avoids sending every user line to the LLM.
 */
const ORDER_PREFILTER = /(?:recuerda|remember|olvida|forget|nota|note|anota|apunta|av[ií]sa|remind|recordatorio|reminder|borra|elimina|delete|remove|ya\s+(?:hice|no)|mark\s+done|prefiero|prefer|soy\s+|i\s+am|i'm\s+|mi\s+nombre|my\s+name|me\s+llamo|toma\s+nota|take\s+note|pon\s+(?:un\s+)?recordatorio|set\s+(?:a\s+)?reminder|quita|tacha|cancela|cancel|dismiss|descartar?|no\s+recuerdes|don't\s+remember|no\s+olvides|don't\s+forget|listo\s+el|completed?|global)/i;

/**
 * Lines that look like tool outputs — never process as user orders.
 */
function isToolOutputLine(line) {
  if (/^\d+\|/.test(line)) return true;              // sqlite output: "242|..."
  if (/\[REMEMBER\]/i.test(line)) return true;        // stored memory
  if (/\[MANUAL\]/i.test(line)) return true;          // stored memory
  if (/\[NOTE\]/i.test(line)) return true;            // stored note
  if (/\[Tool:|^\[Result\]/i.test(line)) return true; // tool markers
  if (/\[secretary\]/i.test(line)) return true;        // secretary log output
  if (/^\{.*\}$/.test(line.trim())) return true;       // JSON objects
  if (/intent:|content:/.test(line)) return true;      // classification output
  if (/SAVE\||FORGET\||NONE\|/.test(line)) return true;   // LLM classification output
  if (/^\s*→\s/.test(line)) return true;               // arrow output from tests
  return false;
}

/**
 * Use the local LLM to classify a user line into an intent.
 * Returns: { intent, content }
 *
 * Intents: SAVE, FORGET, NONE — the index is flat, so there is nothing to
 * classify beyond "write this down" vs "drop this".
 */
async function classifyIntent(line) {
  const prompt = `Classify this user message into exactly ONE intent. The user is talking to an AI coding assistant that keeps a single flat index of everything worth remembering.

USER MESSAGE: "${line}"

INTENTS:
- SAVE: User wants something written down — a fact about themselves, a preference, an observation, a task, anything. Key signals: "recuerda que", "soy...", "mi nombre es...", "prefiero...", "toma nota", "anota", "apunta", "avísame", "recuérdame", "remember that", "note down", "remind me".
- FORGET: User wants something dropped from the index. Key signals: "olvida que...", "forget that...", "ya no soy...", "borra la nota...", "cancela el recordatorio...", "ya hice..."
- NONE: Not an order, just regular conversation

RESPOND WITH ONLY ONE LINE in this exact format:
INTENT|content text here

Where INTENT is one of: SAVE, FORGET, NONE
And content is the extracted core content, without the command words.
For NONE, content can be empty.

Examples:
- "recuerda que soy developer senior" → SAVE|soy developer senior
- "toma nota: el servidor se cae los martes" → SAVE|el servidor se cae los martes
- "avísame el viernes que hay deploy" → SAVE|hay deploy el viernes
- "olvida lo del mono" → FORGET|lo del mono
- "borra la nota del servidor" → FORGET|del servidor
- "cambia el color del botón a rojo" → NONE|`;

  try {
    const response = await callLLM(prompt, 50);
    const cleaned = response.trim().split('\n')[0]; // take first line only
    const pipeIdx = cleaned.indexOf('|');
    if (pipeIdx === -1) return { intent: 'NONE', content: '' };

    const intent = cleaned.slice(0, pipeIdx).trim().toUpperCase();
    const content = cleaned.slice(pipeIdx + 1).trim();

    const validIntents = ['SAVE', 'FORGET', 'NONE'];
    if (!validIntents.includes(intent)) return { intent: 'NONE', content: '' };

    return { intent, content };
  } catch {
    return { intent: 'NONE', content: '' };
  }
}

/**
 * Regex-only fallback classification (when LLM is not available).
 */
function classifyIntentRegex(line) {
  const t = line.trim();

  // ── SAVE ── every phrasing that used to mean remember / note / remind now
  // writes one plain item into the session index. No types, no prefixes.
  if (/(?:recuerda\s+global\s+que|remember\s+global\s+that)\s+(.+)/i.test(t)) return { intent: 'SAVE', content: t, global: true };
  if (/(?:recuerda\s+que|no\s+olvides\s+que|remember\s+that|don'?t\s+forget\s+that)\s+(.+)/i.test(t)) return { intent: 'SAVE', content: t };
  if (/^(?:recuerda|remember)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: t, global: true };
  if (/^(?:recuerda|remember)[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: t };
  if (/(?:^|\.\s*)(?:yo\s+)?soy\s+(?:un[ao]?\s+)?(.+)/i.test(t)) return { intent: 'SAVE', content: t };
  if (/(?:^|\.\s*)(?:i\s+am|i'm)\s+(?:a\s+)?(.+)/i.test(t)) return { intent: 'SAVE', content: t };
  if (/(?:mi\s+nombre\s+es|me\s+llamo|my\s+name\s+is)\s+(.+)/i.test(t)) return { intent: 'SAVE', content: t };
  if (/(?:prefiero|i\s+prefer|me\s+gusta\s+(?:más|mas))\s+(.+)/i.test(t)) return { intent: 'SAVE', content: t };
  if (/^(?:toma\s+nota|anota|apunta|nota|take\s+(?:a\s+)?note|note\s+(?:down|this)|note)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1, global: true };
  if (/^(?:toma\s+nota|anota|apunta|nota|take\s+(?:a\s+)?note|note\s+(?:down|this)|note)[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1 };
  if (/^(?:av[ií]same|recuerd[ae]me|remind\s+me)\s+global\s+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1, global: true };
  if (/^(?:av[ií]same|recuerd[ae]me|remind\s+me)\s+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1 };
  if (/^(?:pon(?:me)?\s+(?:un\s+)?recordatorio|set\s+(?:a\s+)?reminder)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1, global: true };
  if (/^(?:pon(?:me)?\s+(?:un\s+)?recordatorio|set\s+(?:a\s+)?reminder)[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1 };
  if (/^(?:reminder|recordatorio)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1, global: true };
  if (/^(?:reminder|recordatorio)[:\s]+(.+)/i.test(t)) return { intent: 'SAVE', content: RegExp.$1 };

  // ── FORGET ── every phrasing that used to delete a memory, a note or
  // complete a reminder now removes the matching item from the index.
  if (/(?:olvida|forget|olvidar)\s+/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:borra|elimina|delete|remove)\s+(?:la\s+)?(?:memoria|memory|recuerdo|nota|note)/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:no\s+recuerdes|don'?t\s+remember)\s+/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:ya\s+no\s+soy|i'?m\s+no\s+longer)\s+/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:borra|elimina|delete|remove|quita|tacha)\s+(?:la\s+)?(?:nota|note)/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:borra|elimina|delete|remove|cancela?|cancel)\s+(?:el\s+)?(?:recordatorio|reminder)/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:dismiss|descartar?)\s+(?:el\s+)?(?:recordatorio|reminder)/i.test(t)) return { intent: 'FORGET', content: t };

  return { intent: 'NONE', content: '' };
}

// ═══════════════════ SECRETARY ACTIONS ═══════════════════

/**
 * Process all user messages: detect orders via regex classification,
 * then execute the appropriate action. LLM is used only for flexible
 * matching in the forget action.
 */
async function processSecretaryOrders(messages, db, cwd, sessionId) {
  if (!db || !messages?.length) return;

  const candidateLines = [];

  // Step 1: Pre-filter user lines that might be orders
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const lines = m.text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 5 || trimmed.length > 500) continue;
      if (isToolOutputLine(trimmed)) continue;
      if (ORDER_PREFILTER.test(trimmed)) {
        candidateLines.push(trimmed);
      }
    }
  }

  if (candidateLines.length === 0) return;

  // Step 2: Classify each candidate via regex (reliable for clear patterns)
  // Collect LLM-dependent deletions to launch in background
  const bgDeletions = [];

  for (const line of candidateLines) {
    const classification = classifyIntentRegex(line);

    if (classification.intent === 'NONE') continue;

    // Step 3: Execute the action
    // Use '__global__' as project_dir when the "global" modifier is detected
    const effectiveCwd = classification.global ? '__global__' : cwd;
    switch (classification.intent) {
      // Sync action (SQLite only, instant):
      case 'SAVE':
        await actionSave(classification.content || line, db, effectiveCwd, sessionId);
        break;
      // LLM-dependent action — queue for background:
      case 'FORGET':
        bgDeletions.push({ intent: classification.intent, content: classification.content || line });
        break;
    }
  }

  // Launch LLM-dependent deletions in background (don't block the hook).
  // Per-project lock prevents pile-up when multiple sessions of the same
  // project receive deletion orders at once.
  if (bgDeletions.length > 0) {
    if (!canSpawnBgWorkerForProject(cwd)) {
      process.stderr.write(`[secretary] Skipping bg deletions (project worker busy/debounced)\n`);
      return;
    }
    const { spawn } = await import('child_process');
    const child = spawn('node', [new URL(import.meta.url).pathname,
      '_bg_delete', cwd || '', JSON.stringify(bgDeletions)
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    registerBgWorkerForProject(cwd, child.pid);
    process.stderr.write(`[secretary] Deletions launched in background (${bgDeletions.length} action(s))\n`);
  }
}

// ── SAVE (single flat index — no memory types) ──
//
// Every explicit memory is just another item in the session's index, stored
// under the CURRENT session_id exactly like an automatic summary. There are no
// categories, no prefixes and no lifecycle columns: one index, one shape.

async function actionSave(content, db, cwd, sessionId) {
  const existing = db.prepare(`
    SELECT summary FROM all_items
    WHERE (src = 'p' OR project_dir = '__global__') AND message_count = 0
  `).all().map(r => r.summary.toLowerCase());

  const normalized = content.toLowerCase();
  if (existing.some(e => e.includes(normalized) || normalized.includes(e))) return;

  const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM all_items WHERE session_id = ?').get(sessionId);
  const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;
  db.prepare(`INSERT INTO ${itemTable(db, cwd === '__global__')} (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)`).run(
    sessionId, cwd || '', chunkIndex, content, 0
  );
  process.stderr.write(`[secretary] 💾 Saved: "${content.slice(0, 80)}"\n`);
}

// ── FORGET ──

async function actionForget(content, db, cwd, llmAvailable) {
  const entries = db.prepare(`
    SELECT id, src, summary FROM all_items
    WHERE (src = 'p' OR project_dir = '__global__') AND message_count = 0
  `).all();

  if (entries.length === 0) return;

  const toDelete = await matchItemsForDeletion(content, entries, 'items', llmAvailable);

  for (const entry of toDelete) {
    db.prepare(`DELETE FROM ${itemTable(db, entry.src === 'g')} WHERE id = ?`).run(entry.id);
    process.stderr.write(`[secretary] 🗑️ Deleted: "${entry.summary.slice(0, 80)}"\n`);
  }
}

// ── SHARED: LLM-based matching for deletion/completion ──

// Returns the matched ENTRIES (not raw ids): entries can come from both the
// project and the global DB, where numeric ids may collide, so the LLM is
// shown positional ids (1..N) that map back to the entry list.
async function matchItemsForDeletion(userRequest, entries, category, llmAvailable) {
  const entriesList = entries.map((e, i) => `[ID:${i + 1}] ${e.summary}`).join('\n');

  let matched = [];

  if (llmAvailable) {
    try {
      const prompt = `The user wants to DELETE/COMPLETE some ${category}. Given their request and the list of stored ${category}, return ONLY the IDs that match.

USER REQUEST: "${userRequest}"

STORED ${category.toUpperCase()}:
${entriesList}

RULES:
- Match by meaning, not exact words.
- Be flexible with language (Spanish/English) and phrasing variations.
- Only match items that clearly relate to the request. Do NOT match unrelated items.
- If no items match, return NONE.

RESPOND WITH ONLY a comma-separated list of numeric IDs, or NONE.
DO NOT include any other text.`;

      const response = await callLLM(prompt, 100);
      const cleaned = response.trim();

      if (cleaned && cleaned !== 'NONE' && cleaned.toLowerCase() !== 'none') {
        matched = cleaned.split(/[,\s]+/)
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n) && n >= 1 && n <= entries.length)
          .map(n => entries[n - 1]);
      }
    } catch (err) {
      process.stderr.write(`[secretary] LLM matching failed: ${err.message}, falling back to keyword match\n`);
      matched = [];
    }
  }

  // Fallback: keyword matching
  if (matched.length === 0) {
    const keyword = userRequest.toLowerCase();
    for (const entry of entries) {
      const cleanEntry = entry.summary.toLowerCase()
        .replace(/^\[(?:remember|manual|note|reminder)\]\s*/gi, '')
        .trim();
      if (cleanEntry.includes(keyword) || keyword.includes(cleanEntry)) {
        matched.push(entry);
      }
    }
  }

  return matched;
}

// ═══════════════════ COMMANDS ═══════════════════

async function incremental(hookInput) {
  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) return;

  const db = openDb(cwd);
  if (!db) return;

  try {
    const stateKey = `offset:${session_id}`;
    const counterKey = `counter:${session_id}`;

    const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
    const counterRow = db.prepare('SELECT value FROM state WHERE key = ?').get(counterKey);

    const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;
    const counter = counterRow ? parseInt(counterRow.value, 10) + 1 : 1;

    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(counterKey, String(counter));

    const { messages, rawLength, filesTouched } = parseTranscript(transcript_path, lastOffset);

    // Process secretary orders on EVERY call (no counter gate) — fast regex, sync
    await processSecretaryOrders(messages, db, cwd, session_id);

    // Index verbatim turns on EVERY call too: the summary gate below runs once every
    // N calls, and turns skipped here would never be searchable.
    indexTranscript(db, transcript_path, { session_id, cwd });

    // Only do full LLM summary every N tool calls
    if (counter % config.summarize_every_n !== 0) return;

    const text = messagesToText(messages, 8000, filesTouched);
    if (text.length < config.min_new_chars) return;

    // Update offset NOW so next call doesn't re-process these messages
    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(stateKey, String(rawLength));

    // Write conversation text to temp file for the background worker
    const { writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const tmpFile = join(tmpdir(), `secretary-bg-${session_id}-${Date.now()}.txt`);
    writeFileSync(tmpFile, text, 'utf-8');

    // Skip if a previous worker is still running or ran very recently.
    // Avoids a queue of heavy LLM jobs piling up on slower machines.
    // Also respect the per-project lock so multiple sessions of the same
    // project don't fire workers in parallel.
    if (!canSpawnBgWorker(session_id) || !canSpawnBgWorkerForProject(cwd)) {
      process.stderr.write(`[secretary] Skipping bg summary (worker busy/debounced)\n`);
      try { unlinkSync(tmpFile); } catch {}
      return;
    }

    // Launch LLM summarization in background — don't block Claude
    const { spawn } = await import('child_process');
    const child = spawn('node', [new URL(import.meta.url).pathname,
      '_bg_summarize', session_id, cwd || '', String(messages.length), tmpFile
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    registerBgWorker(session_id, child.pid);
    registerBgWorkerForProject(cwd, child.pid);
    process.stderr.write(`[secretary] Summarization launched in background (counter=${counter})\n`);

  } finally {
    db.close();
  }
}

/**
 * Distill the latest chunk summary into N short bullets and append them to
 * the per-project bullets.md. Bullets are 1-line, focused on state/decisions/
 * changes/bugs. Deduplicates against existing bullets in the session so the
 * LLM is told what's already known and avoids repeating.
 *
 * Scope: STRICTLY per-project (cwd). Never mixes bullets across projects.
 */
async function updateBulletsCache(db, cwd, sessionId, latestSummary) {
  if (!cwd || !sessionId) return;
  if (!latestSummary || latestSummary.length < 50) return;

  const existing = readBulletsCache(cwd);
  const currentSession = existing.find(s => s.sessionId === sessionId);
  const prevBullets = currentSession ? currentSession.bullets.slice(-15) : [];

  let bullets = [];
  if (await isLLMAvailable()) {
    const prevBlock = prevBullets.length
      ? `\n\nEXISTING BULLETS for this session (do NOT repeat these; only output genuinely NEW info):\n${prevBullets.map(b => `- ${b}`).join('\n')}`
      : '';
    const prompt = `Extract the ${CACHE_BULLETS_PER_CHUNK} MOST IMPORTANT facts from the conversation summary below, as terse one-line bullets.

PRIORITIES (in order):
1. CURRENT STATE / next step
2. KEY DECISIONS made
3. FILES CHANGED (with paths)
4. UNRESOLVED BUGS or blockers

RULES:
- Output ONLY bullets, one per line, starting with "- "
- Each bullet ≤ 150 characters, single sentence, no markdown inside
- Include specific file paths, function names, variable names when relevant
- Output at most ${CACHE_BULLETS_PER_CHUNK} bullets. Fewer is fine if nothing new.
- If nothing genuinely new vs existing bullets, output nothing.${prevBlock}

SUMMARY:
${latestSummary}`;

    try {
      const raw = await callLLMForSummary(prompt, 300);
      bullets = (raw || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
        .map(l => l.slice(2).trim())
        .filter(Boolean)
        .slice(0, CACHE_BULLETS_PER_CHUNK);
    } catch {
      bullets = [];
    }
  }

  if (bullets.length === 0) return;

  appendBulletsForSession(cwd, sessionId, bullets);
  process.stderr.write(`[secretary] Bullets cache updated: +${bullets.length} bullet(s) for session ${sessionId.slice(0, 8)}\n`);
}

/**
 * One-time bootstrap: if bullets.md doesn't exist yet for this project but the
 * DB has summaries, distill the most recent session's chunks into bullets so
 * the new cache format has content on first use. Strictly per-project (cwd).
 */
async function bootstrapBulletsFromDb(db, cwd) {
  if (!cwd || !db) return false;
  if (existsSync(bulletsFilePath(cwd))) return false;

  const lastSessionRow = db.prepare(`
    SELECT session_id FROM all_items
    WHERE src = 'p'
    ORDER BY created_at DESC LIMIT 1
  `).get();
  if (!lastSessionRow?.session_id) return false;

  const lastSessionId = lastSessionRow.session_id;
  const chunks = db.prepare(`
    SELECT summary FROM all_items
    WHERE src = 'p' AND session_id = ?
    ORDER BY chunk_index ASC
  `).all(lastSessionId);
  if (chunks.length === 0) return false;

  if (!(await isLLMAvailable())) return false;

  const joined = chunks.map((c, i) => `--- Chunk ${i + 1} ---\n${c.summary}`).join('\n\n');
  const prompt = `Distill the following conversation summaries into ${CACHE_MAX_BULLETS_PER_SESSION} terse one-line bullets covering current state, key decisions, files changed, and unresolved bugs.

RULES:
- Output ONLY bullets, one per line, starting with "- "
- Each bullet ≤ 150 characters
- Most recent info is most important
- Max ${CACHE_MAX_BULLETS_PER_SESSION} bullets

SUMMARIES:
${joined}`;

  let bullets = [];
  try {
    const raw = await callLLMForSummary(prompt, 1200);
    bullets = (raw || '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim())
      .filter(Boolean)
      .slice(0, CACHE_MAX_BULLETS_PER_SESSION);
  } catch {
    return false;
  }

  if (bullets.length === 0) return false;

  appendBulletsForSession(cwd, lastSessionId, bullets);
  process.stderr.write(`[secretary] Bootstrapped bullets.md from DB: ${bullets.length} bullet(s)\n`);
  return true;
}

/**
 * Background summarization worker — called as a forked child process.
 * Args: _bg_summarize <session_id> <cwd> <message_count> <tmpFile>
 */
async function bgSummarize(sessionId, cwd, messageCount, tmpFile, { notify: shouldNotify = false, isHandoff = false } = {}) {
  let text;
  try {
    text = readFileSync(tmpFile, 'utf-8');
    // Clean up temp file
    const { unlinkSync } = await import('fs');
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  } catch {
    process.exit(1);
  }

  // The text is already safe in memory, so wait out an external GPU hold
  // (see LOCAL HOOKS) instead of dropping it
  await waitForExternalGpuHold();

  if (!(await ensureLLMRunning())) {
    process.stderr.write('the-secretary: summary dropped (LLM server unavailable)\n');
    process.exit(1);
  }

  // Two prompt flavours:
  //   - Incremental (every N tool calls): bullet-list of decisions/changes/
  //     problems/state. Useful for in-session recall.
  //   - Handoff (Stop hook — session is closing): a denser brief written so
  //     the next session can resume WITHOUT the user re-explaining anything.
  //     Mirrors the manual context the user used to inject by hand.
  const incrementalPrompt = `Summarize this coding conversation segment.

FIRST, judge whether the segment contains actual work. If it holds no identifiable
decisions, file changes or problems — a bare acknowledgement, a greeting, a question
with no answer yet — output exactly this and nothing else:

NOTHING TO REPORT

Do NOT write a summary that says there is nothing to summarize: no "None" sections,
no "no substantive activity occurred", no "waiting for instructions". Those get stored
and then read back as if they were session context. Use the line above instead.

Otherwise extract:

- DECISIONS: What was decided and why (max 3)
- CHANGES: Files modified and how (max 5). If a FILES TOUCHED list opens the conversation, take paths ONLY from it, verbatim; "read" there means inspected, not modified.
- PROBLEMS: Errors encountered and their solutions (max 3)
- STATE: Current task status and next steps

Be specific: include file paths, function names, error messages.
Keep each item to 1-2 sentences.

ACCURACY RULES (mandatory):
- Report ONLY what literally happened. Never infer or extrapolate.
- Searching is NOT implementing. A grep/search/read for symbol X, or confirming X is absent, must NEVER be written as "implemented X" or "added X". Write "verified X does not exist" instead.
- A failed, reverted, or abandoned attempt must be recorded AS failed — never as an accomplishment.
- Record negative findings explicitly (not found, not working, still broken, untested).
- If the assistant corrected an earlier claim, keep the correction and drop the wrong claim.
- Never invent file paths, function names, versions, or metrics absent from the conversation.

CONVERSATION:
${text}`;

  const handoffRoot = resolveProjectRoot(cwd) || cwd;
  const handoffPrompt = `You are writing a session handoff so the NEXT session can resume this work WITHOUT the user explaining anything again. The reader will be a fresh assistant with no memory of what just happened.

PROJECT: ${basename(handoffRoot)} (root: ${handoffRoot})
The handoff is about THIS project only. Work on anything else — shell config, Claude
or tooling setup, accounts, other folders, files outside the project root — is
OFF-PROJECT. Off-project work never fills the sections below; it gets at most ONE short
bullet in the final "## Outside the project" section.

FIRST, read the CONVERSATION below and judge whether it actually contains a session's
work. If it is only a line or two, or holds no identifiable files, decisions or problems,
output exactly this and nothing else:

NOTHING TO REPORT

If the session's only work was OFF-PROJECT, output exactly one line and nothing else:

${OFF_PROJECT_TAG} <one sentence, max 120 characters, naming what was done>

That is a valid, expected answer. An empty handoff costs the next session nothing, while
an invented one misleads it for hours. NEVER fill the sections below with plausible but
unstated content — no example file paths, no assumed servers or ports, no typical project
structure. Every path, name and number you write must appear literally in the CONVERSATION.

Otherwise, output Markdown with these sections (skip a section only if truly nothing applies):

## What was accomplished
2-5 bullets. Concrete: feature names, file paths, what now works that didn't before.

## Current state
Where things stand at session close. What's running, what's broken, what's untested. Mention the active branch, a server URL, or a running process ONLY if the CONVERSATION states it — asking for these is not a reason to invent them. A handoff that claimed "the server URL is http://localhost:3000" in a project that runs no server came from this line; omit what was never said.

## Next step
The single most likely first action when the user returns. Be specific (a file to open, a function to write, a bug to verify).

## Open questions / decisions pending
Things the user has not decided yet that would block progress.

## Don't break / hard rules
Constraints repeated by the user this session: backups required, naming conventions, "never revert without permission", language rules, etc. Anything that, if forgotten, would frustrate the user.

## Backups
Paths of any backup folders created this session.

## Key files touched
File paths + one-line description of what changed in each. If the conversation opens
with a FILES TOUCHED list, that list is the ONLY valid source for this section: every
path must come from it verbatim, and a file it marks "read" was inspected, NOT changed.
Never add a file that is absent from it. Only files inside the project root go here.

## Outside the project
At most one bullet, max 120 characters, for off-project work. Omit if there was none.

Rules:
- Be concrete, name things. No vague language ("we worked on improvements").
- Quote exact file paths, function names, command names where relevant.
- Don't pad. Skip sections that have nothing real to say.
- Maximum 600 words total.

ACCURACY RULES (mandatory — a wrong handoff misleads the next session for hours):
- Report ONLY what literally happened. Never infer, extrapolate, or fill gaps with plausible-sounding work.
- Searching is NOT implementing. A grep/search/read for symbol X, or confirming X is absent, must NEVER become "implemented X" / "added X". Write "verified X does not exist" instead.
- A failed, reverted, or abandoned attempt goes under what did NOT work — never under "What was accomplished".
- "Untested" and "unverified" are load-bearing words. If code was written but never run, say so explicitly in Current state.
- If the assistant corrected an earlier claim during the session, keep the correction and drop the wrong claim entirely.
- Never invent file paths, function names, versions, or metrics that do not appear in the conversation.

CONVERSATION:
${text}`;

  const prompt = isHandoff ? handoffPrompt : incrementalPrompt;
  // Handoffs need room for all sections, but headroom is where the 4-bit model
  // degenerates: once the content runs out before the budget does, it keeps
  // emitting and fills the remainder by repeating. Real output measures
  // 460-921 chars, so max_summary_tokens (800) clears it with margin to spare.
  const summary = await callLLMForSummary(prompt, config.max_summary_tokens);
  if (!summary || summary.length < 50) {
    process.stderr.write(`the-secretary: summary dropped (LLM returned ${summary ? summary.length : 0} chars)\n`);
    process.exit(0);
  }

  // The model was given an explicit way out when the transcript holds no real
  // work. It uses it two ways, and they mean opposite things:
  //   - As the whole answer → there was nothing to report; store nothing.
  //   - Appended after a real brief → a stray echo of the instruction. The
  //     brief is good; only the trailing line is noise, so trim it rather
  //     than throw away a valid handoff (observed on a 208-message session).
  // Both are anchored, so the phrase quoted mid-text in a genuine brief survives.
  // \W* on both sides so markdown emphasis around the phrase ("**NOTHING TO
  // REPORT**") is matched too, not just a bare line.
  let finalSummary = summary.replace(/\n+\W*nothing to report\W*$/i, '').trim();
  // Off-project session: keep only its one line, stripped of markdown emphasis.
  const offProject = isHandoff && finalSummary.match(/^\W*OFF-PROJECT\W*:?\**\s*(.+)/i);
  if (offProject) finalSummary = `${OFF_PROJECT_TAG} ${offProject[1].split('\n')[0].replace(/\*+/g, '').trim()}`;
  if (/^\W*nothing to report\W*$/i.test(finalSummary) || finalSummary.length < (offProject ? 20 : 50)) {
    process.stderr.write('the-secretary: handoff skipped (transcript held no reportable work)\n');
    process.exit(0);
  }


  const db = openDb(cwd);
  if (!db) process.exit(1);

  try {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM all_items WHERE session_id = ?').get(sessionId);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    // Tag handoff entries with a [HANDOFF] prefix so the SessionStart hook
    // can surface them prominently. Plain summaries stay untagged.
    const summaryRow = isHandoff ? `[HANDOFF] ${finalSummary}` : finalSummary;
    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      sessionId, cwd, chunkIndex, summaryRow, parseInt(messageCount, 10)
    );

    try { await updateBulletsCache(db, cwd, sessionId, finalSummary); } catch { /* cache failure must not break summarization */ }
  } finally {
    db.close();
  }

  if (shouldNotify) {
    let blurb = '';
    try {
      const blurbPrompt = `From this coding session summary, write ONE short sentence in ENGLISH (max 90 characters, no quotes, no markdown) describing what was accomplished or the current state. Be concrete — mention the main thing done. Output only the sentence, nothing else.\n\nSUMMARY:\n${finalSummary}`;
      const raw = await callLLM(blurbPrompt, 60);
      blurb = (raw || '').replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
      if (blurb.length > 120) blurb = blurb.slice(0, 117) + '...';
    } catch { /* notify without blurb */ }
    const proj = projectLabel(cwd);
    notify(proj ? `${proj} — Session saved` : 'Claude Code — Session saved', blurb || 'Context stored by The Secretary');
  }
}

async function compact(hookInput) {
  const { session_id, transcript_path, cwd } = hookInput;

  if (session_id && transcript_path) {
    const db = openDb(cwd);
    if (db) {
      try {
        const stateKey = `offset:${session_id}`;
        const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
        const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;

        const { messages, rawLength, filesTouched } = parseTranscript(transcript_path, lastOffset);

        await processSecretaryOrders(messages, db, cwd, session_id);

        indexTranscript(db, transcript_path, { session_id, cwd });

        const text = messagesToText(messages, 8000, filesTouched);

        if (text.length >= 500) {
          if (await ensureLLMRunning()) {
            const prompt = `Summarize this coding conversation segment. Extract:

- DECISIONS: What was decided and why (max 3)
- CHANGES: Files modified and how (max 5). If a FILES TOUCHED list opens the conversation, take paths ONLY from it, verbatim; "read" there means inspected, not modified.
- PROBLEMS: Errors encountered and their solutions (max 3)
- STATE: Current task status and next steps

Be specific: include file paths, function names, error messages.
Keep each item to 1-2 sentences.

ACCURACY RULES (mandatory):
- Report ONLY what literally happened. Never infer or extrapolate.
- Searching is NOT implementing. A grep/search/read for symbol X, or confirming X is absent, must NEVER be written as "implemented X" or "added X". Write "verified X does not exist" instead.
- A failed, reverted, or abandoned attempt must be recorded AS failed — never as an accomplishment.
- Record negative findings explicitly (not found, not working, still broken, untested).
- If the assistant corrected an earlier claim, keep the correction and drop the wrong claim.
- Never invent file paths, function names, versions, or metrics absent from the conversation.

CONVERSATION:
${text}`;

            const summary = await callLLMForSummary(prompt);
            if (summary && summary.length >= 50) {
              const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM all_items WHERE session_id = ?').get(session_id);
              const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

              db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
                session_id, cwd || '', chunkIndex, summary, messages.length
              );
              db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(stateKey, String(rawLength));

              process.stderr.write('[secretary] Final pre-compaction summary saved.\n');
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[secretary] Pre-compaction summary failed: ${err.message}\n`);
      } finally {
        db.close();
      }
    }
  }

  const db2 = openDb(cwd);
  const hasSummaries = db2 ? (() => {
    try {
      const row = db2.prepare('SELECT COUNT(*) as count FROM all_items WHERE session_id = ?').get(session_id);
      return row?.count > 0;
    } finally {
      db2.close();
    }
  })() : false;

  if (hasSummaries) {
    process.stderr.write(`[secretary] Local summaries available for this session. Tip: /clear loads them instead of compacting.\n`);
  } else {
    process.stderr.write(`[secretary] No local summaries yet — Claude's built-in compaction will proceed.\n`);
  }
  process.exit(0);
}

async function restore(hookInput) {
  const { session_id, cwd, transcript_path, source } = hookInput;

  const db = openDb(cwd);
  if (!db) {
    process.stdout.write(`⚠️ **The Secretary: No se pudo abrir la base de datos.** Ejecuta manualmente:\n\`\`\`bash\nbash ~/.claude/the-secretary/start-llm.sh start\necho '{"cwd":"${cwd || ''}"}' | node ~/.claude/the-secretary/summarize.mjs recall\n\`\`\`\n`);
    return;
  }

  try {
    // ── Gather all data ──

    // Resolve the whole project tree (repo root + every nested subfolder a
    // session ran in) so restore never misses today's work just because it was
    // saved under a sibling path. See resolveProjectRoot/projectTreeClause.
    const projectRoot = resolveProjectRoot(cwd);
    const tree = projectTreeClause(projectRoot);

    const lastSessionRow = cwd
      ? db.prepare(`
          SELECT session_id FROM all_items
          WHERE ${tree.clause}
          ORDER BY created_at DESC LIMIT 1
        `).get(...tree.params)
      : db.prepare(`
          SELECT session_id FROM all_items
          WHERE 1=1
          ORDER BY created_at DESC LIMIT 1
        `).get();

    const lastSessionId = lastSessionRow?.session_id;

    // Explicit items (message_count = 0) match the whole project tree (root +
    // nested subfolders) so an item anchored to the project is visible from any
    // subfolder a session opens in — same tree resolution as the conversation
    // summaries above. '__global__' items are always included.
    const savedItems = cwd ? db.prepare(`
      SELECT summary, created_at FROM all_items
      WHERE (${tree.clause} OR project_dir = '__global__') AND message_count = 0
      ORDER BY created_at ASC
    `).all(...tree.params) : [];

    // Get conversation summaries
    let summaries = [];
    if (lastSessionId) {
      summaries = db.prepare(`
        SELECT summary, chunk_index, created_at, session_id FROM all_items
        WHERE session_id = ? ORDER BY chunk_index ASC
      `).all(lastSessionId);

      const MIN_CHUNKS = 10;
      if (summaries.length < MIN_CHUNKS && cwd) {
        const needed = MIN_CHUNKS - summaries.length;
        const backfill = db.prepare(`
          SELECT summary, chunk_index, created_at, session_id FROM all_items
          WHERE ${tree.clause} AND session_id != ?
          ORDER BY created_at DESC LIMIT ?
        `).all(...tree.params, lastSessionId, needed);
        backfill.reverse();
        summaries = [...backfill, ...summaries];
      }
    }

    const hasAnything = summaries.length > 0 || savedItems.length > 0;
    if (!hasAnything) {
      process.stderr.write('☑ Session memory: no previous context found\n');
      return;
    }

    // ── Build output ──
    let output = '';

    // 1. Conversation context from bullets.md (strictly per-project).
    //    bullets.md is built incrementally by updateBulletsCache() after each
    //    chunk summary, so SessionStart just reads a small file — no LLM call,
    //    no blocking, no race with a still-running summarizer.
    //
    //    If bullets.md is missing (first run after migration) but DB has
    //    chunks, fall back to raw concatenation and spawn a background
    //    bootstrap so the next SessionStart gets real bullets.
    let finalSummary = '';
    let cacheHit = false;

    if (cwd) {
      const sections = readBulletsCache(cwd);
      if (sections.length > 0) {
        const parts = [];
        for (let i = 0; i < sections.length; i++) {
          const s = sections[i];
          const label = i === sections.length - 1 ? 'Most recent session' : 'Previous session';
          const when = s.startedAt ? ` _(started ${s.startedAt.slice(0, 16).replace('T', ' ')})_` : '';
          parts.push(`### ${label}${when}\n${s.bullets.map(b => `- ${b}`).join('\n')}`);
        }
        finalSummary = parts.join('\n\n');
        cacheHit = true;
      }
    }

    if (summaries.length === 0 && !cacheHit) {
      finalSummary = '(No conversation summaries available)';
    } else if (!cacheHit) {
      const ordered = [...summaries].sort((a, b) => (a.chunk_index || 0) - (b.chunk_index || 0));
      finalSummary = ordered.map(s => s.summary).join('\n\n---\n\n');
      if (finalSummary.length > 4000) {
        finalSummary = finalSummary.slice(-3950) + '\n\n[...older chunks truncated]';
      }

      if (cwd && lastSessionId && canSpawnBgWorkerForProject(cwd)) {
        try {
          const { spawn } = await import('child_process');
          const child = spawn('node', [
            new URL(import.meta.url).pathname, '_bg_regenerate', cwd, lastSessionId,
          ], { detached: true, stdio: 'ignore' });
          child.unref();
          registerBgWorkerForProject(cwd, child.pid);
          process.stderr.write('[secretary] Bullets bootstrap spawned in background\n');
        } catch { /* best effort */ }
      }
    }

    // 2a. Handoff brief — written by the previous session's Stop hook with
    //     the explicit goal of letting the next session resume without the
    //     user re-explaining anything. Surface this BEFORE the older bullet
    //     summaries so it dominates the new session's initial context.
    let handoffBrief = '';
    if (cwd) {
      // The resume point is the latest handoff with PROJECT work; sessions spent
      // on something else after it only get their one line.
      const offProjectLike = `[HANDOFF] ${OFF_PROJECT_TAG}%`;
      const handoffRow = db.prepare(`
        SELECT summary, created_at, session_id FROM all_items
        WHERE ${tree.clause}
          AND summary LIKE '[HANDOFF]%' AND summary NOT LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(...tree.params, offProjectLike);
      if (handoffRow) {
        const body = (handoffRow.summary || '').replace(/^\[HANDOFF\]\s*/i, '').trim();
        const when = handoffRow.created_at
          ? new Date(handoffRow.created_at + 'Z').toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        handoffBrief = `## 📋 Session handoff — resume here\n\n_Last session with work on this project (${when}). Read this first; the older bullet summaries below are background._\n\n${body}\n`;
        output += handoffBrief + '\n';
      }
      const offProjectRows = db.prepare(`
        SELECT summary, MAX(created_at) AS created_at FROM all_items
        WHERE ${tree.clause}
          AND summary LIKE ? AND created_at > ?
        GROUP BY summary
        ORDER BY created_at DESC
        LIMIT 3
      `).all(...tree.params, offProjectLike, handoffRow?.created_at || '');
      if (offProjectRows.length > 0) {
        output += `## ↪ Outside the project since then\n\n`;
        for (const r of offProjectRows) {
          const date = new Date(r.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
          output += `- ${r.summary.replace(/^\[HANDOFF\]\s*OFF-PROJECT:\s*/i, '')} _(${date})_\n`;
        }
        output += '\n';
      }
    }

    // 2a'. After /clear, the literal tail of the session just left. A summary
    //      says what was done; only the raw end shows whether the last reply
    //      finished or broke off mid-task. Transcripts of one project share a
    //      folder, so the previous one sits next to this session's.
    const prevSessionId = source === 'clear' && cwd && transcript_path ? previousSessionId(cwd, session_id) : '';
    if (prevSessionId) {
      const tailChars = Math.max(500, parseInt(config.restore_tail_chars, 10) || 5000);
      const { messages } = parseTranscript(join(dirname(transcript_path), `${prevSessionId}.jsonl`));
      const tail = transcriptTail(messages, tailChars);
      if (tail) {
        output += `## 🧵 End of the previous conversation (last ~${tailChars} chars, verbatim)\n\n`
          + `_Check this before anything else: if the last turns left work unfinished (a step announced but not run, an edit not applied, a question unanswered), tell the user in one line what was pending and offer to resume it. If they show the task finished, do not reopen it._\n\n`
          + `${tail}\n\n`;
      }
    }

    // 2b. Latest raw items across the WHOLE project tree, newest-first. This is
    //     the literal "what happened most recently in the DB" view the user
    //     asked for — independent of session grouping or bullet caching, so it
    //     can never go stale relative to a handoff written under a sibling path.
    //     Skipped when a handoff exists: it repeats the handoff's own drafts and
    //     every restored token is paid again on each turn of the session.
    if (cwd && !handoffBrief) {
      const N = Math.max(1, parseInt(config.restore_recent_items, 10) || 15);
      const recentItems = db.prepare(`
        SELECT summary, created_at FROM all_items
        WHERE ${tree.clause}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...tree.params, N);
      if (recentItems.length > 0) {
        output += `## 🕑 Latest ${recentItems.length} items in the DB (newest first)\n\n`;
        for (const it of recentItems) {
          const when = it.created_at
            ? new Date(it.created_at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '';
          // Strip the [HANDOFF]/[NOTE]/etc tag and collapse to a single compact line.
          const oneLine = (it.summary || '')
            .replace(/^\[[A-Z]+\]\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 220);
          output += `- _${when}_ — ${oneLine}\n`;
        }
        output += '\n';
      }
    }

    // Older session bullets only stand in for a missing handoff; next to one
    // they repeat it. They stay reachable through `recall`.
    if (!handoffBrief) {
      const cacheLabel = cacheHit ? ` _(bullets cache)_` : '';
      output += `## Context from Previous Conversation (auto-injected by The Secretary)${cacheLabel}\n\n${finalSummary}\n`;
    }

    // 2. Saved items — one flat list, no categories.
    if (savedItems.length > 0) {
      output += `\n## Saved items (NEVER ignore these)\n`;
      for (const e of savedItems) {
        const date = e.created_at ? new Date(e.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '';
        output += `- ${e.summary}${date ? ` _(${date})_` : ''}\n`;
      }
    }

    // ── Final output ──
    const totalItems = summaries.length + savedItems.length;

    if (totalItems === 0) {
      process.stdout.write(`⚠️ **The Secretary: No hay contexto previo para este proyecto.** Si crees que debería haberlo, ejecuta:\n\`\`\`bash\nbash ~/.claude/the-secretary/start-llm.sh start\necho '{"cwd":"${cwd || ''}"}' | node ~/.claude/the-secretary/summarize.mjs recall\n\`\`\`\n`);
      return;
    }

    output += `\n---\n*${totalItems} items restored by The Secretary.*`;

    const allDates = [...summaries, ...savedItems].map(e => e.created_at).filter(Boolean);
    const lastDate = allDates[allDates.length - 1] || 'unknown';
    const formattedDate = lastDate !== 'unknown' ? new Date(lastDate + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : lastDate;

    process.stdout.write(output + `\n\n☑ Session memory recovered from ${formattedDate} (${totalItems} items restored)`);
    // After /clear the previous session's handoff is usually still being
    // written, so recovery is not over yet: the `await-handoff --rewake` hook
    // notifies once it lands.
    if (source !== 'clear') notifyMemoryRecovered(cwd, `From ${formattedDate} (${totalItems} items)`);

    // ── Fresh-context watermark ──
    // Record max(created_at) of summaries known at restore-time for this project.
    // userPromptHook() compares against this to detect summaries that landed
    // AFTER restore (e.g. the previous session's tail finishing post-/clear)
    // and injects a "new context available" notice on the next prompt.
    try {
      if (cwd && session_id) {
        const maxRow = db.prepare(`
          SELECT MAX(created_at) AS max_at FROM all_items
          WHERE (src = 'p' OR project_dir = '__global__')
        `).get();
        const watermark = {
          session_id,
          project_dir: cwd,
          max_at: maxRow?.max_at || new Date().toISOString().replace('T',' ').slice(0,19),
          restored_at: new Date().toISOString()
        };
        mkdirSync(WATERMARKS_DIR, { recursive: true });
        writeFileSync(watermarkFilePath(session_id), JSON.stringify(watermark));
      }
    } catch (err) {
      process.stderr.write(`[secretary] watermark write failed: ${err.message}\n`);
    }

  } finally {
    db.close();
  }
}

async function force(hookInput, { stopLlm = false, notify: shouldNotify = false } = {}) {
  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) return;

  const db = openDb(cwd);
  if (!db) return;

  try {
    const stateKey = `offset:${session_id}`;
    const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
    const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;

    // A handoff is the state of the WHOLE session, so it reads the whole
    // transcript — not the unprocessed tail. Reading from `lastOffset` made the
    // brief depend on how much the incremental summarizer had already consumed:
    // at session close that is usually everything, so the handoff was written
    // from the last message or two. A model asked to fill eight mandatory
    // sections from one line does not refuse, it invents a plausible project —
    // one real handoff described `src/controllers/userController.js` and
    // `localhost:3000` in a repo containing neither, generated from the single
    // line "Commiteado en `main` como `08becc2`, working tree limpio."
    // Incremental summaries keep using the offset; only the handoff reads it all.
    const fromOffset = stopLlm ? 0 : lastOffset;
    const { messages, rawLength, filesTouched } = parseTranscript(transcript_path, fromOffset);

    await processSecretaryOrders(messages, db, cwd, session_id);

    // Stop fires after EVERY reply, including pure-chat ones with no tool call, so
    // this is the only hook that sees those turns while they are the latest.
    indexTranscript(db, transcript_path, { session_id, cwd });

    // The whole session needs more room than an incremental chunk, or the
    // budget would drop precisely the early turns that state the session's goal.
    const text = messagesToText(messages, stopLlm ? 16000 : 8000, filesTouched);

    // A handoff needs enough substance to be worth writing. Below this floor the
    // model has nothing to summarize and fabricates instead, so writing nothing
    // is strictly better: the reader falls back to the older bullets, which are
    // at least true. The incremental path keeps the lower bar — a thin chunk
    // there is just a thin chunk, not a fabricated session state.
    const minChars = stopLlm ? 600 : 100;
    // Record this session as the terminal's latest even when no handoff is
    // written, so the next /clear reads the right transcript tail. A live
    // summarizer keeps its lock: it is what await-handoff waits on.
    if (stopLlm && !liveLockPid(handoffLockPath(cwd))) registerHandoffWorker(cwd, session_id, 0);
    if (text.length < minChars) {
      process.stderr.write('☑ Session memory: nothing new to save\n');
      return;
    }

    // Update offset NOW so next call doesn't re-process
    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(stateKey, String(rawLength));

    // Write conversation text to temp file for the background worker
    const { writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const tmpFile = join(tmpdir(), `secretary-bg-${session_id}-${Date.now()}.txt`);
    writeFileSync(tmpFile, text, 'utf-8');

    // Respect the same lock/debounce used by incremental(), unless --stop-llm
    // was passed (Stop hook — final summary at session end should always run).
    if (!stopLlm && (!canSpawnBgWorker(session_id) || !canSpawnBgWorkerForProject(cwd))) {
      process.stderr.write('[secretary] Skipping forced summary (worker busy/debounced)\n');
      try { unlinkSync(tmpFile); } catch {}
      return;
    }

    // Launch LLM summarization in background using spawn (faster than fork)
    const { spawn } = await import('child_process');
    const spawnArgs = [new URL(import.meta.url).pathname, '_bg_summarize', session_id, cwd || '', String(messages.length), tmpFile];
    if (stopLlm) spawnArgs.push('--stop-llm');
    if (shouldNotify) spawnArgs.push('--notify');
    const child = spawn('node', spawnArgs, {
      detached: true,
      stdio: workerStdio(),
    });
    child.unref();
    registerBgWorker(session_id, child.pid);
    registerBgWorkerForProject(cwd, child.pid);
    if (stopLlm) registerHandoffWorker(cwd, session_id, child.pid);
    process.stderr.write(`☑ Session memory: summarization launched in background\n`);
  } finally {
    db.close();
  }
}

async function inject(hookInput) {
  const session_id = hookInput.session_id || 'manual';
  const cwd = hookInput.cwd || process.cwd();

  const textArgIdx = process.argv.indexOf('--text');
  let text = '';
  if (textArgIdx !== -1 && process.argv[textArgIdx + 1]) {
    text = process.argv.slice(textArgIdx + 1).join(' ');
  }

  if (!text) {
    process.stderr.write('Usage: summarize.mjs inject --text "your context here"\n');
    process.exit(1);
  }

  const db = openDb(cwd);
  if (!db) {
    process.stderr.write('[secretary] Cannot open database.\n');
    return;
  }

  try {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM all_items WHERE session_id = ?').get(session_id);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      session_id, cwd, chunkIndex, text, 0
    );

    // Also index it verbatim, so an injected item is searchable exactly like a
    // normal one. `turns` is fed from transcripts, and an injected item has no
    // transcript behind it — without this it would reach the FTS stage never,
    // and be findable only by the weaker LIKE fallback.
    try {
      db.prepare('INSERT INTO turns (body, role, session_id, project_dir, created_at) VALUES (?, ?, ?, ?, ?)').run(
        text, 'assistant', session_id, cwd, new Date().toISOString()
      );
    } catch { /* no FTS table (older DB): the summaries row alone still works */ }

    process.stderr.write(`[secretary] Injected context (chunk ${chunkIndex}).\n`);
  } finally {
    db.close();
  }
}

async function recall(hookInput) {
  const cwd = hookInput.cwd || process.argv[3] || process.cwd();

  const db = openDb(cwd);
  if (!db) {
    process.stdout.write('No database available.\n');
    return;
  }

  try {
    let output = '';

    // Saved items — one flat list. No categories, no prefixes, no lifecycle.
    const entries = db.prepare(`
      SELECT id, summary, created_at, project_dir FROM all_items
      WHERE (src = 'p' OR project_dir = '__global__') AND message_count = 0
      ORDER BY created_at ASC
    `).all();

    if (entries.length > 0) {
      output += `## Elementos guardados (${entries.length})\n\n`;
      for (const e of entries) {
        const date = e.created_at ? new Date(e.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const globalTag = e.project_dir === '__global__' ? ' [global]' : '';
        output += `- ${e.summary}${date ? ` _(${date})_` : ''}${globalTag}\n`;
      }
      output += '\n';
    }

    // Context summaries
    {
      const lastSessionRow = db.prepare(`
        SELECT session_id FROM all_items
        WHERE src = 'p'
        ORDER BY created_at DESC LIMIT 1
      `).get();

      if (lastSessionRow) {
        // Last session in full, plus recent handoffs from earlier sessions —
        // a handoff is the distilled state of a whole session, so dropping the
        // older ones (LIMIT 1 on the session) threw away most of the history.
        const summaries = db.prepare(`
          SELECT summary, created_at FROM all_items
          WHERE session_id = ? ORDER BY chunk_index ASC
        `).all(lastSessionRow.session_id);

        const priorHandoffs = db.prepare(`
          SELECT summary, created_at FROM all_items
          WHERE src = 'p' AND session_id != ?
            AND summary LIKE '[HANDOFF]%' AND summary NOT LIKE ?
          ORDER BY created_at DESC LIMIT 2
        `).all(lastSessionRow.session_id, `[HANDOFF] ${OFF_PROJECT_TAG}%`);

        if (priorHandoffs.length > 0) {
          output += `## Handoffs de sesiones anteriores (${priorHandoffs.length})\n\n`;
          for (const h of priorHandoffs.reverse()) {
            const date = h.created_at ? new Date(h.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '';
            // Truncated: full handoffs are ~600 words each and would dwarf the
            // rest of the recall. The current session's context follows below.
            let body = h.summary.replace(/^\[HANDOFF\]\s*/i, '');
            if (body.length > 900) body = body.slice(0, 900) + '\n…(truncado)';
            output += `### ${date}\n${body}\n\n---\n\n`;
          }
        }

        if (summaries.length > 0) {
          output += `## Contexto de conversaciones anteriores (${summaries.length} chunks)\n\n`;

          if (await isLLMAvailable()) {
            const allSummaries = summaries.map((s, i) => `--- Chunk ${i + 1} (${s.created_at}) ---\n${s.summary}`).join('\n\n');
            try {
              const prompt = `Merge these ${summaries.length} conversation summaries into ONE readable summary in Spanish. Be concise but include key decisions, files changed, and current state. Use markdown formatting.

CRITICAL ACCURACY RULES — violating these makes the summary worse than useless:
- Report ONLY what the summaries literally state. Never infer, extrapolate, or fill gaps.
- Searching for a symbol is NOT implementing it. "grep X", "looked for X", "verified X is missing" must NEVER become "implemented X".
- Preserve negative findings verbatim: if something was NOT found, NOT working, failed, or was reverted, say so explicitly.
- Preserve explicit corrections: if a summary corrects an earlier claim, the correction wins and the corrected claim must not reappear.
- If two summaries conflict, keep the LATER one and note the discrepancy.
- Never invent file paths, function names, version numbers, or metrics that do not appear in the source text.

SUMMARIES:\n${allSummaries}`;
              const consolidated = await callLLMForSummary(prompt, 2000);
              if (consolidated && consolidated.length >= 50) {
                output += consolidated + '\n';
              } else {
                output += summaries.map(s => s.summary).join('\n\n---\n\n') + '\n';
              }
            } catch {
              output += summaries.map(s => s.summary).join('\n\n---\n\n') + '\n';
            }
          } else {
            output += summaries.map(s => s.summary).join('\n\n---\n\n') + '\n';
          }
        }
      }
    }

    if (!output) {
      process.stdout.write('No tengo nada guardado para este proyecto.\n');
      return;
    }

    process.stdout.write(output);
  } finally {
    db.close();
  }
}

// ═══════════════════ SEARCH / RECALL-ON-DEMAND ═══════════════════

/**
 * Extract keywords from a user query. Strips common Spanish/English
 * interrogatives and stop-words so we can match substrings against
 * cache and DB content.
 */
function extractSearchQuery(prompt) {
  if (!prompt) return '';
  let q = prompt.toLowerCase();
  q = q.replace(/[¿?¡!.,:;]/g, ' ');
  const stripPatterns = [
    /\brecuerdas?\b/g, /\bte acuerdas?\b/g,
    /\bdo you remember\b/g, /\bdo you recall\b/g, /\bremember when\b/g,
    /\b(el|la|los|las|un|una|unos|unas|the|a|an|that)\b/g,
    /\b(de|del|sobre|about|on|para|for|que|qué|what|cuando|when|donde|where|como|how)\b/g,
    /\b(si|no|yes|please|por favor|me|te|se|le|mi|tu|su)\b/g,
  ];
  for (const p of stripPatterns) q = q.replace(p, ' ');
  return q.replace(/\s+/g, ' ').trim();
}

const RECALL_TRIGGERS = [
  /\brecuerdas?\b/i,
  /\bte acuerdas?\b/i,
  /\bdo you remember\b/i,
  /\bdo you recall\b/i,
  /\bremember when\b/i,
];

function isRecallQuery(prompt) {
  if (!prompt || prompt.length > 500) return false;
  return RECALL_TRIGGERS.some((rx) => rx.test(prompt)) || isTemporalQuery(prompt);
}

/**
 * "Where were we?" questions ask about a POINT IN TIME, not a topic.
 *
 * Keyword search answers them badly by construction: it ranks every turn that happens
 * to contain "estábamos" from any session, so months-old work outranks this morning's.
 * These are answered by recency instead — the tail of the conversation, in order.
 */
const TEMPORAL_TRIGGERS = [
  /\b(?:en|por)\s+(?:qu[eé]|donde|d[oó]nde)\s+(?:nos\s+)?(?:hab[ií]amos\s+)?(?:qued|estab|iba)/i,
  /\bpor\s+d[oó]nde\s+(?:vamos|[ií]bamos|seguimos|segu[ií]a)/i,
  /\b(?:qu[eé]|cual)\s+(?:es\s+)?(?:lo\s+)?[uú]ltimo\s+que\s+(?:hicimos|hice|hiciste|estab)/i,
  /\bretomamos?\b/i,
  /\bc[oó]mo\s+(?:vas|vamos|va\s+(?:eso|la\s+cosa|todo))\b/i,
  /\bqu[eé]\s+tal\s+(?:vas|vamos|va)\b/i,
  /\bd[oó]nde\s+(?:lo\s+)?(?:dejamos|dej[eé])\b/i,
  /\bwhere\s+(?:were|did)\s+we\s+(?:leave|left|stop|at)\b/i,
  /\bwhat\s+(?:were|was)\s+(?:we|i)\s+(?:working|doing)\b/i,
  /\bpick\s+up\s+where\b/i,
  /\bwhat'?s?\s+the\s+last\s+thing\b/i,
];

function isTemporalQuery(prompt) {
  if (!prompt || prompt.length > 500) return false;
  return TEMPORAL_TRIGGERS.some((rx) => rx.test(prompt));
}

/**
 * Ask the local LLM whether a prompt is a "where were we" question.
 *
 * Phrasings are open-ended ("sigue con lo de antes", "que estabas haciendo") and no
 * regex list covers them; a small local model classifies them reliably. Used ONLY as a
 * second opinion after the regex misses, so the common path stays instant and the model
 * never sits between the user and an obvious prompt.
 *
 * Fails closed to `false`: if the server is down or slow, detection degrades to the
 * regex tier rather than blocking the hook.
 */
async function isTemporalQueryLLM(prompt, { timeoutMs = 2500 } = {}) {
  const p = (prompt || '').trim();
  // Only short, question-like prompts are worth a round trip. A long prompt is a task,
  // not a "where were we".
  if (p.length < 4 || p.length > 120) return false;

  const system = 'You classify a user message from a coding assistant. Reply with ONE word only.\n'
    + 'RECENT = the user asks what we were working on, where we left off, or what was done last (any language).\n'
    + 'OTHER = anything else: a task to do, a code question, a command.';

  try {
    const answer = await callLLMChat(
      [{ role: 'system', content: system }, { role: 'user', content: p }],
      { maxTokens: 4, temperature: 0, timeoutMs }
    );
    return /RECENT/i.test(answer || '');
  } catch {
    return false;
  }
}

/**
 * Minimal chat call with an explicit timeout, for latency-sensitive paths that must
 * never hold up a hook. `callLLM` is tuned for long summaries (60s timeout).
 */
function callLLMChat(messages, { maxTokens = 8, temperature = 0, timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.llm_url);
    const body = JSON.stringify({
      model: detectedModel || config.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).choices?.[0]?.message?.content || '');
        } catch { reject(new Error('LLM response parse error')); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Answer a "where were we" question from the tail of the indexed conversation.
 *
 * Returns the most recent turns of the most recent session, oldest-first so they read
 * as a conversation. Consecutive near-duplicates are collapsed: repeated prompts and
 * retried messages otherwise fill the whole answer with the same line.
 */
function recentContext(cwd, { limit = 12 } = {}) {
  const db = openDb(cwd);
  if (!db) return [];
  try {
    const last = db.prepare(`
      SELECT session_id, MAX(created_at) AS last_at
      FROM turns
      GROUP BY session_id
      ORDER BY last_at DESC
      LIMIT 1
    `).get();
    if (!last?.session_id) return [];

    const rows = db.prepare(`
      SELECT body, role, created_at
      FROM turns
      WHERE session_id = ?
      ORDER BY rowid DESC
      LIMIT ?
    `).all(last.session_id, limit * 3);

    const seen = new Set();
    const picked = [];
    for (const r of rows) {
      const key = (r.body || '').slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(r);
      if (picked.length >= limit) break;
    }
    return picked.reverse(); // chronological
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Search for `query` across the project's cache .md files (fast) and its DB
 * summaries (fallback). Strictly per-project: only the cwd's project data
 * (plus '__global__' items via the DB view) is searched.
 * Returns an array of hits: { source, project, date, snippet }.
 */
async function searchContext(query, { maxHits = 5, snippetChars = 400, cwd = process.cwd() } = {}) {
  const q = (query || '').trim();
  if (q.length < 3) return [];

  // A date narrows WHERE to look; the words around it are WHAT to look for.
  const range = parseDateRange(q);
  const words = range ? `${q.slice(0, range.index)} ${q.slice(range.index + range.phrase.length)}`.trim() : q;
  const bounds = range && dateBounds(range);
  const inRange = (row) => !bounds || (row.created_at >= bounds.turns[0] && row.created_at < bounds.turns[1]);

  // "Where were we?" is a question about time, not about words — answer it from the
  // tail of the conversation. Keyword ranking would surface any old turn that merely
  // repeats the phrasing. Regex first (instant, covers the common phrasings); the local
  // model is consulted only when it misses, since phrasing is open-ended.
  if (!range && (isTemporalQuery(q) || await isTemporalQueryLLM(q))) {
    const recent = recentContext(cwd, { limit: maxHits * 2 });
    if (recent.length) {
      return recent.map((r) => ({
        source: r.role === 'user' ? 'said' : 'turn',
        project: basename(cwd) || 'unknown',
        date: (r.created_at || '').split('T')[0],
        score: 0,
        snippet: (r.body || '').slice(0, snippetChars).trim(),
      }));
    }
    // No indexed turns yet: fall through to keyword search rather than answering nothing.
  }

  // Drop stopwords: a recall question is mostly filler ("que hice hoy en X"),
  // and scoring by raw term count lets that filler outrank the real subject.
  const STOPWORDS = new Set([
    'que', 'qué', 'como', 'cómo', 'cual', 'cuál', 'donde', 'dónde', 'cuando', 'cuándo',
    'hice', 'hicimos', 'hizo', 'hacer', 'hoy', 'ayer', 'los', 'las', 'del', 'para', 'por',
    'con', 'sin', 'una', 'uno', 'unos', 'unas', 'esta', 'este', 'esto', 'esos', 'esas',
    'sobre', 'todo', 'toda', 'todos', 'todas', 'mas', 'más', 'muy', 'ser', 'era', 'son',
    'the', 'and', 'for', 'what', 'did', 'was', 'were', 'have', 'has', 'with', 'from',
    'this', 'that', 'these', 'those', 'about', 'into', 'been', 'they', 'you', 'your',
  ]);
  let terms = words.split(/\s+/)
    .map((t) => t.replace(/[.,;:!?()"'¿¡]/g, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  // Only a date left ("qué hicimos ayer"): answer with what happened then.
  if (range && terms.length === 0) return searchByDate(cwd, range, { maxHits, snippetChars });
  // If the query was ALL stopwords, fall back to the original tokens rather
  // than returning nothing.
  if (terms.length === 0) terms = q.split(/\s+/).filter((t) => t.length >= 3);
  terms = terms.slice(0, 5);
  if (terms.length === 0) return [];

  const hits = [];

  // ── 1. Cache .md files (this project only) ──
  // The cache has no per-entry dates, so a dated question skips it.
  if (!range) try {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const projPath = cacheDirForProject(cwd);
    const projName = basename(resolveProjectRoot(cwd) || cwd || '');
    {
      let files = [];
      try {
        files = readdirSync(projPath).filter((f) => f.endsWith('.md'));
      } catch { files = []; }

      for (const f of files) {
        const full = join(projPath, f);
        let content = '';
        try { content = readFileSync(full, 'utf-8'); } catch { continue; }
        const lower = content.toLowerCase();
        const matchCount = terms.filter((t) => lower.includes(t.toLowerCase())).length;
        if (matchCount === 0) continue;

        // Extract snippet around the first matching term
        const firstTerm = terms.find((t) => lower.includes(t.toLowerCase()));
        const idx = lower.indexOf(firstTerm.toLowerCase());
        const start = Math.max(0, idx - 120);
        const end = Math.min(content.length, idx + snippetChars);
        const snippet = (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');

        let mtime = '';
        try { mtime = statSync(full).mtime.toISOString().split('T')[0]; } catch {}

        hits.push({
          source: 'cache',
          project: projName,
          date: mtime || f.replace('.md', ''),
          score: matchCount,
          snippet: snippet.trim(),
        });
      }
    }
  } catch (err) {
    process.stderr.write(`[secretary] cache search error: ${err.message}\n`);
  }

  // Sort by match score desc, then date desc
  hits.sort((a, b) => (b.score - a.score) || b.date.localeCompare(a.date));

  // Always keep room for verbatim hits. The cache holds LLM-written summaries, which
  // paraphrase; the turns hold what was actually said. Letting the cache fill every
  // slot meant a question about a literal phrase was answered entirely from summaries
  // that had already dropped that phrase — and the verbatim stage never even ran.
  const CACHE_MAX = Math.max(1, Math.floor(maxHits / 2));
  if (hits.length > CACHE_MAX) hits.length = CACHE_MAX;

  // ── 2. Verbatim turns (FTS5) ──
  // Runs before the summary fallback: a recall question usually quotes what was said,
  // and the raw turn keeps that wording where the summary paraphrased it away.
  try {
    const db = openDb(cwd);
    if (db) {
      try {
        // Literal and semantic lists are FUSED, not chained. As a fallback that ran
        // only when FTS came up short, vectors never ran at all: an OR query over a
        // 10k-turn index always fills every slot, so "the site similar to X" returned
        // rows that merely shared a word and never the one that said "a site like X".
        // Reciprocal rank fusion puts a row that ranks well in both first.
        const match = buildMatchQuery(terms);
        const fused = new Map(); // rowid -> { row, score, literal }
        const RRF_K = 60;
        if (match) {
          // bm25 alone rewards a short row holding ONE rare word, so a filler term
          // ("mencioné") outranked rows matching the real subjects. Rank by how many
          // distinct query terms a row covers first; bm25 only breaks ties.
          const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
          const folded = terms.map(fold);
          db.prepare(`
            SELECT rowid AS rid, body, role, project_dir, created_at, bm25(turns) AS rank
            FROM turns
            WHERE turns MATCH ? ${bounds ? 'AND created_at >= ? AND created_at < ?' : ''}
            ORDER BY rank
            LIMIT 500
          `).all(match, ...(bounds ? bounds.turns : []))
            .map(r => ({ ...r, cover: folded.filter(t => fold(r.body || '').includes(t)).length }))
            .sort((a, b) => (b.cover - a.cover) || (a.rank - b.rank))
            .slice(0, 50)
            .forEach((row, i) => fused.set(row.rid, {
              row, score: 1 / (RRF_K + i), literal: true, exact: row.cover === folded.length,
            }));
        }
        // Vectors cannot filter by date: fetch wider, keep the rows in the span.
        vectorSearch(db, words, range ? 200 : 50).filter(inRange).slice(0, 50).forEach((row, i) => {
          const hit = fused.get(row.rid);
          if (hit) hit.score += 1 / (RRF_K + i);
          else fused.set(row.rid, { row, score: 1 / (RRF_K + i), literal: false, exact: false });
        });

        // A row holding EVERY query term is the literal answer (an identifier, a
        // quoted phrase) — vectors recover ~0% of those, so they never outrank it.
        // A message sent twice (a retried prompt) is one answer, not two slots.
        const seenBodies = new Set();
        const ranked = [...fused.values()]
          .sort((a, b) => (b.exact - a.exact) || (b.score - a.score))
          .filter(({ row }) => !seenBodies.has(row.body) && seenBodies.add(row.body))
          .slice(0, maxHits - hits.length);
        if (process.env.SECRETARY_DEBUG) {
          process.stderr.write(`[search] terms=${JSON.stringify(terms)} fts=${[...fused.values()].filter(h => h.literal).length} fused=${fused.size}\n`);
          [...fused.values()].sort((a, b) => b.score - a.score).slice(0, 15).forEach((h, i) =>
            process.stderr.write(`[search] #${i} rid=${h.row.rid} score=${h.score.toFixed(4)} lit=${h.literal} cover=${h.row.cover ?? '-'} sim=${h.row.sim?.toFixed(3) ?? '-'} ${(h.row.body || '').slice(0, 60).replace(/\n/g, ' ')}\n`));
        }
        for (const { row, literal } of ranked) {
          const body = row.body || '';
          const lower = body.toLowerCase();
          const firstTerm = terms.find(t => lower.includes(t.toLowerCase()));
          const idx = firstTerm ? lower.indexOf(firstTerm.toLowerCase()) : 0;
          const start = Math.max(0, idx - 120);
          const end = Math.min(body.length, idx + snippetChars);
          const snippet = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
          // A row only the vectors found is `approx`: close in meaning, never proof
          // that something was actually said.
          hits.push({
            source: (row.role === 'user' ? 'said' : 'turn') + (literal ? '' : '~'),
            approx: !literal,
            project: basename(row.project_dir || '') || 'unknown',
            date: (row.created_at || '').split('T')[0],
            score: 0,
            snippet: snippet.trim(),
          });
        }
      } catch { /* no FTS table yet (older DB) — fall through to summaries */ }
      finally { db.close(); }
    }
  } catch (err) {
    process.stderr.write(`[secretary] fts search error: ${err.message}\n`);
  }

  if (hits.length >= maxHits) return hits.slice(0, maxHits);

  // ── 3. DB fallback (summaries table) ──
  try {
    const db = openDb(cwd);
    if (db) {
      try {
        // Rank by how many terms match, like the cache and FTS stages do, instead
        // of requiring ALL of them: an ANDed LIKE hid any row that matched 4 of 5
        // terms, so an item was reachable only by a query whose every word it
        // happened to contain. Items written by `inject` live only in this table
        // (no transcript backs them, so FTS never sees them), which made them look
        // unsearchable when the real cause was the stricter matching here.
        const scoreExpr = terms.map(() => '(summary LIKE ?)').join(' + ');
        const params = terms.map((t) => `%${t}%`);
        const rows = db.prepare(`
          SELECT project_dir, summary, created_at, ${scoreExpr} AS matches
          FROM all_items
          WHERE matches > 0 ${bounds ? 'AND created_at >= ? AND created_at < ?' : ''}
          ORDER BY matches DESC, created_at DESC
          LIMIT ?
        `).all(...params, ...(bounds ? bounds.summaries : []), maxHits - hits.length);

        for (const row of rows) {
          const lower = row.summary.toLowerCase();
          const firstTerm = terms.find((t) => lower.includes(t.toLowerCase())) || terms[0];
          const idx = lower.indexOf(firstTerm.toLowerCase());
          const start = Math.max(0, idx - 120);
          const end = Math.min(row.summary.length, idx + snippetChars);
          const snippet = (start > 0 ? '…' : '') + row.summary.slice(start, end) + (end < row.summary.length ? '…' : '');
          hits.push({
            source: 'db',
            project: basename(row.project_dir || '') || 'unknown',
            date: (row.created_at || '').split(' ')[0],
            score: row.matches || 0,
            snippet: snippet.trim(),
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    process.stderr.write(`[secretary] db search error: ${err.message}\n`);
  }

  return hits.slice(0, maxHits);
}

/**
 * CLI command: search <query…> — prints matching context to stdout.
 */
/**
 * CLI command: index-turns — backfill the FTS index from transcripts already on disk.
 *
 * Claude Code keeps every session at ~/.claude/projects/<slug>/<session-id>.jsonl, where
 * the slug is the project path with separators replaced by '-'. Sessions that ended
 * before this index existed are only reachable this way; live sessions self-index via
 * the PostToolUse hook.
 */
/**
 * CLI command: index-vectors — build the semantic index over turns already in FTS.
 *
 * Separate from index-turns on purpose: FTS indexing is free and runs on every hook,
 * while this loads a 600 MB model and takes ~50 s per 2k turns. It is an explicit,
 * occasional operation. Re-running it only embeds turns that are not in vturns yet.
 */
/**
 * CLI command: sync — keep both indexes current, in the background.
 *
 * Wired to SessionStart. Indexing must never delay the prompt, so this only
 * spawns a detached worker and returns; the work happens in `_bg_sync`.
 *
 * Without this the indexes only ever grew when someone remembered to run the
 * commands by hand, so a project drifted further behind with every session.
 */
async function cmdSync({ vectors = true } = {}) {
  const cwd = process.cwd();
  if (!canSpawnBgWorkerForProject(cwd)) return;

  const { spawn } = await import('child_process');
  const child = spawn('node', [
    new URL(import.meta.url).pathname, '_bg_sync', cwd, vectors ? '1' : '0',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  registerBgWorkerForProject(cwd, child.pid);
}

async function cmdIndexVectors() {
  const cwd = process.cwd();
  if (!semanticAvailable()) {
    process.stdout.write('Semantic index unavailable: needs sqlite-vec (npm) and the embedding venv.\n');
    process.stdout.write(`Expected helper at ${EMBED_SCRIPT} and python at ${embedPython()}\n`);
    return;
  }

  const db = openDb(cwd);
  if (!db) { process.stderr.write('[secretary] could not open DB\n'); return; }

  try {
    if (!loadVecExtension(db)) { process.stdout.write('sqlite-vec failed to load.\n'); return; }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vturns USING vec0(embedding float[${VEC_DIM}])`);

    const pending = db.prepare(`
      SELECT rowid AS rid, body FROM turns
      WHERE length(body) >= 30 AND rowid NOT IN (SELECT rowid FROM vturns)
    `).all();

    if (!pending.length) {
      const n = db.prepare('SELECT count(*) n FROM vturns').get()?.n ?? 0;
      process.stdout.write(`Semantic index already current (${n} vectors).\n`);
      return;
    }

    process.stdout.write(`Embedding ${pending.length} turn(s)…\n`);
    // vec0 enforces its primary key before SQLite's conflict clause runs, so
    // `INSERT OR IGNORE` still throws — the duplicate has to be filtered out in JS.
    // This matters because a run killed mid-batch leaves rows committed that the next
    // run may still read as pending; without the guard the whole batch would die on
    // the first repeat.
    const insert = db.prepare('INSERT INTO vturns(rowid, embedding) VALUES (?, ?)');
    const alreadyIndexed = db.prepare('SELECT 1 FROM vturns WHERE rowid = ?');
    let done = 0;
    const BATCH = 128;
    if (!acquireGpuLock()) {
      process.stderr.write('[secretary] index-vectors: GPU busy, try again later\n');
      return;
    }
    try {
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const vecs = embedTexts(slice.map(r => r.body));
      if (!vecs) { process.stderr.write('[secretary] embedding failed — stopping\n'); break; }
      const tx = db.transaction((rows) => {
        rows.forEach((r, k) => {
          if (alreadyIndexed.get(r.rid)) return;
          insert.run(BigInt(r.rid), vecs[k]);
        });
      });
      tx(slice);
      done += slice.length;
      process.stdout.write(`  ${done}/${pending.length}\n`);
    }
    } finally { releaseGpuLock(); }
    const total = db.prepare('SELECT count(*) n FROM vturns').get()?.n ?? 0;
    process.stdout.write(`Semantic index: ${done} new vector(s). Total: ${total}\n`);
  } catch (err) {
    process.stderr.write(`[secretary] index-vectors error: ${err.message}\n`);
  } finally {
    db.close();
  }
}

/**
 * Whole history of a trimmed session in one temp file: `<transcript>.bak`
 * (the lines trims dropped, in order) followed by the live file's lines not
 * already there. Returns { path, liveLines }.
 */
function mergeTrimmedTranscript(path) {
  const uuidOf = (l) => l.match(/"uuid":"([^"]+)"/)?.[1];
  const bak = readFileSync(`${path}.bak`, 'utf-8').split('\n').filter((l) => l.trim());
  const live = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim());
  const saved = new Set(bak.map(uuidOf).filter(Boolean));
  const merged = [...bak, ...live.filter((l) => !saved.has(uuidOf(l)))];
  const out = join(tmpdir(), `secretary-merged-${basename(path)}`);
  writeFileSync(out, merged.join('\n') + '\n');
  return { path: out, liveLines: live.length };
}

async function cmdIndexTurns() {
  const cwd = process.cwd();
  // Claude Code slugifies the project path by replacing every non-alphanumeric run
  // (separators, dots, spaces) with a single dash: /Users/x/Code/LAB.Foo -> -Users-x-Code-LAB-Foo
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectsDir = join(homedir(), '.claude', 'projects', slug);

  if (!existsSync(projectsDir)) {
    process.stdout.write(`No transcripts found for this project (${projectsDir})\n`);
    return;
  }

  const db = openDb(cwd);
  if (!db) {
    process.stderr.write('[secretary] could not open DB\n');
    return;
  }

  // --rebuild re-reads every transcript still on disk from line 0: it fills the
  // gaps the old offset-coupled indexer left and replaces turns cut at 3000 chars.
  // Sessions whose transcript Claude Code already deleted keep their rows — the
  // index is by then their only copy. Vectors of replaced rows go too, or their
  // rowids would be reused by the new rows and point at the wrong text.
  const rebuild = process.argv.includes('--rebuild');
  let hasVectors = false;
  if (rebuild) {
    hasVectors = !!db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'vturns'").get()?.n;
    if (hasVectors && !loadVecExtension(db)) {
      process.stderr.write('[secretary] --rebuild needs sqlite-vec to drop stale vectors; aborting\n');
      db.close();
      return;
    }
  }

  let files = 0, indexed = 0;
  try {
    const only = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : null;
    for (const f of readdirSync(projectsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.replace(/\.jsonl$/, '');
      if (only && sessionId !== only) continue;
      const path = join(projectsDir, f);
      // A trimmed session (see trimSession) keeps its older lines in `.bak`:
      // a rebuild reads both, or it would replace the history with the tail.
      const full = rebuild && existsSync(`${path}.bak`) ? mergeTrimmedTranscript(path) : null;
      if (rebuild) {
        db.transaction(() => {
          if (hasVectors) db.prepare('DELETE FROM vturns WHERE rowid IN (SELECT rowid FROM turns WHERE session_id = ?)').run(sessionId);
          db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
          db.prepare('DELETE FROM state WHERE key = ?').run(`fts-line:${sessionId}`);
        })();
      }
      let n = 0;
      try {
        n = indexTranscript(db, full?.path ?? path, { session_id: sessionId, cwd });
        if (full) {
          // The merged file ends with every line of the live one: all indexed.
          db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
            .run(`fts-line:${sessionId}`, String(full.liveLines - 1));
          rmSync(full.path, { force: true });
        }
      } catch { continue; } // one unreadable transcript must not abort the rest
      files++;
      indexed += n;
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM turns').get()?.n ?? 0;
    process.stdout.write(`Indexed ${indexed} new turn(s) from ${files} transcript(s). Total in index: ${total}\n`);
  } catch (err) {
    process.stderr.write(`[secretary] index-turns error: ${err.message}\n`);
  } finally {
    db.close();
  }
}

async function cmdSearch() {
  const query = process.argv.slice(3).join(' ');
  if (!query) {
    process.stderr.write('Usage: summarize.mjs search <query>\n');
    return;
  }
  const hits = await searchContext(query);
  if (hits.length === 0) {
    process.stdout.write(`No se encontró contexto para: "${query}"\n`);
    return;
  }
  process.stdout.write(`# Resultados para "${query}" (${hits.length})\n\n`);
  for (const h of hits) {
    process.stdout.write(`## [${h.source}] ${h.project} · ${h.date}\n\n${h.snippet}\n\n---\n\n`);
  }
}

/**
 * UserPromptSubmit hook: if the user's prompt looks like a recall question,
 * inject matching context so Claude sees it before answering.
 *
 * Input: JSON on stdin with { prompt, cwd, session_id }
 * Output to stdout is added to the conversation as additional context.
 */
async function userPromptHook(hookInput) {
  const prompt = hookInput.prompt || hookInput.user_prompt || '';

  // ── Context past the clear threshold, run under the `secretary` launcher ──
  // Trim, hold the prompt and have the launcher reopen the session with it.
  // Only a cut made now reopens: the reopened session's file is already short.
  const launcher = Number(process.env.SECRETARY_LAUNCHER_PID);
  const tokens = contextTokens(hookInput.transcript_path);
  const trim = tokens >= config.context_clear_tokens && trimSession(hookInput);
  if (launcher && trim === 'trimmed') {
    const dir = join(homedir(), '.claude', 'the-secretary', 'relaunch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${launcher}.json`), JSON.stringify({ session_id: hookInput.session_id, prompt }));
    process.stdout.write(JSON.stringify({ decision: 'block', reason: 'The Secretary: reabriendo la sesión recortada…' }));
    process.kill(launcher, 'SIGUSR2');
    return;
  }

  // ── Recall question → load the skill, said in the turn it applies to ──
  // The CLAUDE.md rule is read once at session start. By the time the question
  // arrives the handoff already sits in context, and answering straight from it
  // skips the skill. Written before every other branch so none of them drops it.
  if (isRecallQuery(prompt)) {
    process.stdout.write(
      `## ⛔ The Secretary: pregunta de memoria\n\n` +
      `Tu PRIMERA llamada a herramienta en este turno es \`Skill\` con \`skill: "secretary"\`, ` +
      `aunque el contexto ya esté inyectado. No respondas antes de cargarlo.\n\n`
    );
  }

  // ── Context past the clear threshold ──
  // Every turn resends the whole context, so a long session costs more per
  // turn the longer it runs. The handoff makes /clear cheap; say when to do it.
  // Under the launcher the reopen above does it, and a file already short was
  // just reopened (its last usage predates the cut); an uncuttable one still asks.
  if (tokens >= config.context_clear_tokens && !(launcher && trim)) {
    const howTo = trim
      ?`dale en un bloque de código el comando que retoma esta misma sesión, ya recortada a los últimos mensajes: ` +
        `\`/resume ${hookInput.session_id}\``
      : `dile que haga \`/clear\` (el handoff conserva el hilo)`;
    process.stdout.write(
      `## 🧹 The Secretary: contexto en ${Math.round(tokens / 1000)}k tokens\n\n` +
      `Termina la tarea en curso y, al acabar, ${howTo}. No lo repitas si ya lo dijiste en este contexto.\n\n`
    );
  }

  // ── Previous session still being summarized (typically right after /clear) ──
  // The context SessionStart restored predates that summary. Blocking the prompt
  // until it lands stalls the user, so hand Claude a background command instead:
  // it exits when the summarizer does and prints what it wrote, and its
  // completion notice wakes Claude with the fresh context.
  const { session_id, cwd } = hookInput;
  if (session_id && cwd && previousHandoffPid(cwd, session_id)) {
    const cmd = `echo '${JSON.stringify({ cwd, session_id })}' | node ~/.claude/the-secretary/summarize.mjs await-handoff`;
    process.stdout.write(
      `## ⏳ The Secretary: el resumen de la sesión anterior todavía se está generando\n\n` +
      `El contexto restaurado al inicio es anterior a ese resumen. Lanza YA este comando con Bash ` +
      `\`run_in_background: true\`; termina cuando llega el resumen e imprime su contenido:\n\n` +
      `\`\`\`bash\n${cmd}\n\`\`\`\n\n` +
      `Si la petición depende de la sesión anterior ("por dónde vamos", "sigue con…"), dile al usuario ` +
      `en una línea que estás esperando el resumen y respóndele cuando llegue el aviso. Si no depende, sigue con ella.\n\n`
    );
    return;
  }

  // ── Fresh-context watermark check ──
  // If summaries landed AFTER the session's restore (e.g. previous session's
  // tail finished summarizing post-/clear), inject a notice with the new content
  // so Claude is aware of context it couldn't see at session start.
  try {
    await checkFreshContextWatermark(hookInput);
  } catch (err) {
    process.stderr.write(`[secretary] fresh-context check failed: ${err.message}\n`);
  }

  if (!isRecallQuery(prompt)) return;

  const query = extractSearchQuery(prompt);
  if (query.length < 3) return;

  const hits = await searchContext(query, { maxHits: 5, snippetChars: 500, cwd: hookInput.cwd || process.cwd() });
  if (hits.length === 0) return;

  process.stdout.write(`## 🧠 The Secretary: contexto encontrado para "${query}"\n\n`);
  process.stdout.write(`_(${hits.length} coincidencia${hits.length > 1 ? 's' : ''} en sesiones previas — usa esto para responder antes de buscar más)_\n\n`);
  for (const h of hits) {
    process.stdout.write(`### [${h.source}] ${h.project} · ${h.date}\n\n${h.snippet}\n\n---\n\n`);
  }
}

/**
 * Fresh-context watermark check.
 *
 * On SessionStart (restore), we save a watermark file with max(created_at) of
 * summaries visible at that moment. If the previous session's summarizer was
 * still running when the user hit /clear, its new summaries land AFTER the
 * watermark. On the next user prompt we detect that, inject a system reminder
 * with the new content, and advance the watermark so we only notify once.
 */
const WATERMARKS_DIR = join(homedir(), '.claude', 'the-secretary', 'watermarks');

function watermarkFilePath(sessionId) {
  return join(WATERMARKS_DIR, `${sessionId}.json`);
}

async function checkFreshContextWatermark(hookInput, { snippetChars = 400 } = {}) {
  const { session_id, cwd } = hookInput;
  if (!session_id || !cwd) return;

  const wmFile = watermarkFilePath(session_id);
  if (!existsSync(wmFile)) return;

  let wm;
  try {
    wm = JSON.parse(readFileSync(wmFile, 'utf8'));
  } catch { return; }

  const db = openDb(cwd);
  if (!db) return;

  try {
    const rows = db.prepare(`
      SELECT summary, created_at, session_id, chunk_index FROM all_items
      WHERE (src = 'p' OR project_dir = '__global__')
        AND created_at > ?
        AND session_id != ?
      ORDER BY created_at ASC
      LIMIT 20
    `).all(wm.max_at, session_id);

    if (rows.length === 0) return;

    const newMax = rows[rows.length - 1].created_at;
    try {
      writeFileSync(wmFile, JSON.stringify({ ...wm, max_at: newMax, last_notified_at: new Date().toISOString() }));
    } catch { /* best-effort */ }

    const MAX_SHOW = 5;
    const SNIP = snippetChars;
    const shown = rows.slice(-MAX_SHOW);

    let out = `\n## 📥 The Secretary: contexto nuevo disponible\n\n`;
    out += `_${rows.length} resumen${rows.length > 1 ? 'es' : ''} añadido${rows.length > 1 ? 's' : ''} desde el inicio de esta sesión (probablemente el summarizer de la sesión previa terminó después del \`/clear\`)._\n\n`;
    for (const r of shown) {
      const clean = (r.summary || '').replace(/^\[RAW-TAIL\]\s*/i, '').trim();
      const snippet = clean.length > SNIP ? clean.slice(0, SNIP) + '…' : clean;
      out += `### ${r.created_at}\n\n${snippet}\n\n---\n\n`;
    }
    process.stdout.write(out);
    return true;
  } finally {
    db.close();
  }
}

const HANDOFF_WAITING_MESSAGE = '⏳ The Secretary: waiting for the previous handoff';
// One frame per status line refresh (`refreshInterval: 1` → one per second).
const HANDOFF_WAITING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * handoff-status: `statusLine` command. The async `await-handoff --rewake`
 * SessionStart hook stays silent until the summary lands, and a SessionStart
 * systemMessage is only painted when the transcript next renders — after
 * /clear that is when the handoff has already landed — so the wait itself is
 * shown here: the status line prints the message while the previous session's
 * handoff is being written and goes blank once it is done. It also shows the
 * context size (`ctx 92k`): dim, amber past `context_warn_tokens`, red with a
 * /clear hint past `context_clear_tokens`.
 */
function handoffStatus(statusInput) {
  const { session_id, transcript_path } = statusInput;
  const cwd = statusInput.cwd || statusInput.workspace?.current_dir;
  const parts = [];
  // Debug: `touch ~/.claude/the-secretary/debug-status` dumps what Claude Code sends.
  const debugPath = join(homedir(), '.claude', 'the-secretary', 'debug-status');
  if (existsSync(debugPath)) writeFileSync(debugPath, JSON.stringify(statusInput, null, 2));
  // Claude Code's own live count when it sends one: right after a /resume the
  // transcript's last `usage` still belongs to the context before the resume.
  const live = statusInput.context_window?.current_usage;
  const tokens = live
    ? (live.input_tokens || 0) + (live.cache_read_input_tokens || 0) + (live.cache_creation_input_tokens || 0)
    : contextTokens(transcript_path);
  if (tokens) {
    const warn = config.context_warn_tokens, clear = config.context_clear_tokens;
    const color = tokens >= clear ? '31' : tokens >= warn ? '33' : '2';
    const hint = tokens < clear ? '' : process.env.SECRETARY_LAUNCHER_PID ? ' ↻ al enviar' : ` /resume ${session_id}`;
    // Bar spans the model's whole context window; a mark sits at the clear threshold.
    const windowSize = statusInput.context_window?.context_window_size || 200000;
    const CELLS = 30;
    const filled = Math.min(CELLS, Math.round((tokens / windowSize) * CELLS));
    const mark = Math.min(CELLS - 1, Math.round((clear / windowSize) * CELLS));
    const cells = Array.from({ length: CELLS }, (_, i) => (i < filled ? '█' : '░'));
    const bar = `\x1b[${color}m${cells.slice(0, mark).join('')}\x1b[0m\x1b[1m│\x1b[0m\x1b[${color}m${cells.slice(mark).join('')}`;
    const account = sessionAccountName();
    parts.push(`${bar} ${Math.round(tokens / 1000)}k${account ? ` ${account}` : ''}${hint}\x1b[0m`);
  }
  if (session_id && cwd && previousHandoffPid(cwd, session_id)) {
    const frame = HANDOFF_WAITING_FRAMES[Math.floor(Date.now() / 1000) % HANDOFF_WAITING_FRAMES.length];
    parts.push(`${HANDOFF_WAITING_MESSAGE} ${frame}`);
  }
  if (parts.length) process.stdout.write(parts.join('  ·  ') + '\n');
}

/**
 * Trims the session transcript IN PLACE to its tail, so `/resume <same id>`
 * reopens the conversation with a small context. (A SessionStart "resume"
 * hook cannot do it: it runs after the transcript is already loaded.) The
 * running session keeps appending to the file and keeps its context in memory.
 * The parent chain is walked back from the last message; the cut lands on the
 * earliest user prompt whose tail stays under `trim_keep_tokens`, measured
 * from the `usage` the transcript records for each request. Everything from the cut on is kept in file order (parallel tool
 * results hang on sibling branches), minus sidechains and tool calls still
 * waiting for a result. Every dropped line is first appended to
 * `<transcript>.bak`, which so keeps the whole history. Returns 'trimmed' when
 * the file was just cut, 'short' when it already was, false otherwise.
 */
function trimSession({ transcript_path: transcriptPath, session_id, cwd }) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    // Same line numbering as parseTranscript: the stored read positions count these.
    const rawLines = raw.split('\n').filter((l) => l.trim());
    const parsed = rawLines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const lines = parsed.filter(Boolean);
    const CHAIN = new Set(['user', 'assistant', 'attachment', 'system']);
    const byUuid = new Map(lines.filter((l) => l.uuid && CHAIN.has(l.type)).map((l) => [l.uuid, l]));
    const leaf = [...lines].reverse().find((l) => l.uuid && CHAIN.has(l.type) && !l.isSidechain);
    const chain = [];
    for (let n = leaf; n; n = n.parentUuid ? byUuid.get(n.parentUuid) : null) chain.unshift(n);

    // A prompt the user typed: system-made user entries (task notifications,
    // command output) are meta or start with a tag.
    const isPrompt = (l) => l.type === 'user' && !l.isMeta && typeof l.message?.content === 'string' && !l.message.content.startsWith('<');
    // Tokens a tail adds, measured from the `usage` of each request: the sum of
    // the growths between consecutive requests after the cut. A drop (an
    // earlier resume or compaction restarted the context) adds nothing.
    // (Estimating from content chars missed ~3x: images and hook text count.)
    const contextOf = (l) => {
      const u = l.type === 'assistant' && l.message?.usage;
      return u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
    };
    let cut = -1;
    let tail = 0;
    let next = null; // context of the closest request after i
    for (let i = chain.length - 1; i >= 0; i--) {
      const own = contextOf(chain[i]);
      if (own != null) {
        if (next != null) tail += Math.max(0, next - own);
        next = own;
      }
      if (tail > config.trim_keep_tokens) break;
      if (isPrompt(chain[i])) cut = i;
    }
    if (cut < 0) return false;
    if (cut === 0) return 'short';

    const start = lines.indexOf(chain[cut]);
    let kept = lines.slice(start).filter((l) => l.uuid && CHAIN.has(l.type) && !l.isSidechain);
    const blocks = (l) => (Array.isArray(l.message?.content) ? l.message.content : []);
    const answered = new Set(kept.flatMap((l) => blocks(l).filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id)));
    kept = kept.filter((l) => !(l.type === 'assistant' && blocks(l).some((c) => c.type === 'tool_use' && !answered.has(c.id))));
    const keptLines = new Set(kept.map((l) => parsed.indexOf(l)));
    kept[0] = { ...kept[0], parentUuid: null };

    const bakPath = `${transcriptPath}.bak`;
    const saved = new Set();
    if (existsSync(bakPath)) {
      for (const l of readFileSync(bakPath, 'utf-8').split('\n')) {
        const m = l.match(/"uuid":"([^"]+)"/);
        if (m) saved.add(m[1]);
      }
    }
    const dropped = rawLines.filter((l, i) => !keptLines.has(i) && !(parsed[i]?.uuid && saved.has(parsed[i].uuid)));
    if (dropped.length) appendFileSync(bakPath, dropped.join('\n') + '\n');

    // Claude Code appends to this file while it runs: carry over whatever
    // landed after the read so no line is lost.
    const late = readFileSync(transcriptPath, 'utf-8').slice(raw.length);
    writeFileSync(transcriptPath, kept.map((l) => JSON.stringify(l)).join('\n') + '\n' + late);
    remapReadPositions(cwd, session_id, keptLines, rawLines.length);
    return 'trimmed';
  } catch (err) {
    process.stderr.write(`[secretary] trim error: ${err.message}\n`);
    return false;
  }
}

/**
 * After a trim, moves the summarizer's and the turn index's read positions
 * (line numbers into the transcript) onto the trimmed file, so neither skips
 * the lines written next. `keptLines`: old numbers of the lines kept, which
 * become lines 0..n-1; lines past `oldCount` arrived during the trim and follow.
 */
function remapReadPositions(cwd, sessionId, keptLines, oldCount) {
  if (!sessionId) return;
  const db = openDb(cwd);
  if (!db) return;
  try {
    const kept = [...keptLines].sort((a, b) => a - b);
    // Number of lines that end up before old line `n` in the new file.
    const before = (n) => kept.filter((i) => i < n).length + Math.max(0, n - oldCount);
    const read = (key) => db.prepare('SELECT value FROM state WHERE key = ?').get(key)?.value;
    const write = db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
    const next = read(`offset:${sessionId}`); // next line to read
    if (next != null) write.run(`offset:${sessionId}`, String(before(parseInt(next, 10))));
    const last = read(`fts-line:${sessionId}`); // last line indexed
    if (last != null) write.run(`fts-line:${sessionId}`, String(before(parseInt(last, 10) + 1) - 1));
  } finally {
    db.close();
  }
}

/**
 * Trims the transcript when the context is past `context_clear_tokens`.
 * Run on every prompt and at the end of every turn, so whenever the status
 * line shows `/resume`, the file it reopens is already short.
 */
function trimIfOverLimit(hookInput) {
  if (contextTokens(hookInput.transcript_path) < config.context_clear_tokens) return false;
  return trimSession(hookInput);
}

/**
 * Context size of the session's last main-thread request, from the `usage`
 * the transcript records for it: everything sent (fresh + cache read + cache
 * write). Reads only the transcript's tail, since the status line runs every
 * second. Returns 0 when unknown.
 */
function contextTokens(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const u = entry.message?.usage;
      if (!u || entry.isSidechain) continue;
      return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * await-handoff: run by Claude in the background when the user-prompt hook
 * reports that the previous session's handoff is still being written. Exits
 * once that summarizer does and prints what it stored — the task's completion
 * notice is how the fresh context reaches Claude.
 *
 * With `rewake` it runs as an async SessionStart hook (`asyncRewake`) instead:
 * exit code 2 is what wakes Claude with what was printed, so the user does
 * not have to type anything after /clear. It wakes even when nothing new
 * landed (a short session's handoff is discarded as NOTHING TO REPORT), so
 * every /clear ends with a visible answer instead of silence.
 */
async function awaitHandoff(hookInput, { rewake = false } = {}) {
  const { session_id, cwd } = hookInput;
  if (!session_id || !cwd) {
    process.stderr.write('[secretary] await-handoff needs {"cwd","session_id"} on stdin\n');
    process.exit(1);
  }
  if (rewake) {
    // `restore` runs as a sibling SessionStart hook: the watermark it writes is
    // what the check below compares against, so let it land first.
    for (let i = 0; i < 120 && !existsSync(watermarkFilePath(session_id)); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await waitForPreviousHandoff(cwd, session_id);
  const fresh = await checkFreshContextWatermark(hookInput, { snippetChars: Infinity });
  if (!fresh) {
    process.stdout.write('## 📥 The Secretary: el resumen de la sesión anterior terminó sin añadir contexto nuevo\n');
  }
  if (rewake) {
    notifyMemoryRecovered(cwd, fresh ? 'Previous session handoff included' : 'No new context from the previous session');
    process.exitCode = 2;
  }
}

// ═══════════════════ BACKEND SWITCH ═══════════════════

// Which AI writes the summaries. Each name is just a pair of config.json keys.
const BACKENDS = {
  local: { provider: 'local', local_backend: 'mlx' },
  apple: { provider: 'local', local_backend: 'apple' },
  claude: { provider: 'claude_cli' },
};

function backendName(cfg) {
  if (cfg.provider === 'claude_cli') return 'claude';
  return cfg.local_backend === 'apple' ? 'apple' : 'local';
}

// Every Claude account on this machine: the default one (~/.claude.json, no
// CLAUDE_CONFIG_DIR) plus each ~/.<folder> holding its own .claude.json.
// `value` is what claude_config_dir stores.
function emailOf(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')).oauthAccount?.emailAddress || ''; } catch { return ''; }
}

// Account this session runs as: the launcher's profile name (CLAUDE_PROFILE),
// else the user part of the account's email.
function sessionAccountName() {
  if (process.env.CLAUDE_PROFILE) return process.env.CLAUDE_PROFILE;
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return emailOf(dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json')).split('@')[0];
}

function listClaudeAccounts() {
  const accounts = [{ value: 'default', folder: 'default', email: emailOf(join(homedir(), '.claude.json')) }];
  for (const entry of readdirSync(homedir())) {
    const file = join(homedir(), entry, '.claude.json');
    if (entry.startsWith('.') && existsSync(file)) {
      accounts.push({ value: join(homedir(), entry), folder: entry.slice(1), email: emailOf(file) });
    }
  }
  return accounts;
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const isSubsequence = (needle, hay) => { let i = 0; for (const c of hay) if (c === needle[i]) i++; return i === needle.length; };

// An account is named by its folder, its email (with or without @ and dots),
// the email's user or the email's domain. Tighter tests win: exact, prefix,
// substring, then letters in order ("wrk" → work). A tie is no answer.
function resolveClaudeAccount(query) {
  const q = squash(basename(query));
  const accounts = listClaudeAccounts();
  const keys = (a) => {
    const [user, domain = ''] = a.email.split('@');
    return [a.folder, a.email, user, domain.split('.')[0]].filter(Boolean).map(squash);
  };
  const tests = [(k) => k === q, (k) => k.startsWith(q), (k) => k.includes(q), (k) => isSubsequence(q, k)];
  for (const test of tests) {
    const hits = accounts.filter(a => keys(a).some(test));
    if (hits.length) return { account: hits.length === 1 ? hits[0] : null, accounts };
  }
  return { account: null, accounts };
}

function accountLabel(value) {
  if (!value) return 'same as session';
  const account = listClaudeAccounts().find(a => a.value === value.replace(/^~/, homedir()));
  return account ? `${account.email || account.folder} (${account.folder})` : value;
}

function backendLabel(cfg) {
  const name = backendName(cfg);
  if (name === 'claude') return `claude (${cfg.claude_model}, account: ${accountLabel(cfg.claude_config_dir)})`;
  if (name === 'apple') return 'apple (on-device)';
  return `local (${cfg.model})`;
}

// `backend` shows the current one; `backend <local|apple|claude> [claude model] [--account <name|email|folder>]` switches.
function cmdBackend(args) {
  const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : {};
  const current = { ...config, ...raw };
  const at = args.indexOf('--account');
  const account = at >= 0 ? args[at + 1] : undefined;
  const [name, model] = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  if (!name) {
    process.stdout.write(`The Secretary backend: ${backendLabel(current)}\nOptions: ${Object.keys(BACKENDS).join(' | ')} (claude takes an optional model, e.g. sonnet, and --account <name | email | folder>)\nAccounts: ${listClaudeAccounts().map(a => `${a.folder} <${a.email || '?'}>`).join(', ')}\n`);
    return;
  }
  if (!BACKENDS[name]) {
    process.stdout.write(`Unknown backend "${name}". Options: ${Object.keys(BACKENDS).join(' | ')}\n`);
    process.exitCode = 1;
    return;
  }
  const next = { ...raw, ...BACKENDS[name] };
  if (name === 'claude' && model) next.claude_model = model;
  if (name === 'claude' && account) {
    const { account: hit, accounts } = resolveClaudeAccount(account);
    if (!hit) {
      const list = accounts.map(a => `${a.folder} <${a.email || '?'}>`).join(', ');
      process.stdout.write(`No single account matches "${account}". Accounts: ${list}\n`);
      process.exitCode = 1;
      return;
    }
    next.claude_config_dir = hit.value;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  // A running local server keeps serving the old model; stop it so the next summary starts the new one.
  if (backendName(current) !== name) {
    try { execFileSync('bash', [join(SECRETARY_DIR, 'start-llm.sh'), 'stop'], { stdio: 'ignore' }); } catch { /* not running */ }
  }
  process.stdout.write(`The Secretary backend: ${backendLabel({ ...config, ...next })} (was ${backendLabel(current)})\n`);
}

// ═══════════════════ MAIN ═══════════════════

async function main() {
  const command = process.argv[2];

  // Background summarization worker (forked child process)
  if (command === '_bg_summarize') {
    const [, , , sessionId, cwd, messageCount, tmpFile, ...flags] = process.argv;
    try {
      // Stop hook implies "session is closing" → write a richer handoff
      // brief instead of the regular incremental summary.
      await bgSummarize(sessionId, cwd, messageCount, tmpFile, {
        notify: flags.includes('--notify'),
        isHandoff: flags.includes('--stop-llm'),
      });
    } catch (err) {
      process.stderr.write(`[secretary-bg] ${err.message}\n`);
    }
    // Release locks so the next incremental() can spawn
    clearBgWorker(sessionId);
    clearBgWorkerForProject(cwd);
    process.exit(0);
  }

  // Background cache bootstrap — if bullets.md doesn't exist yet for this
  // project but the DB has summaries, distill them into bullets so the
  // next SessionStart gets the new cache format without blocking.
  // Background index sync (spawned by `sync` at SessionStart).
  if (command === '_bg_sync') {
    const [, , , cwd, withVectors] = process.argv;
    try {
      process.chdir(cwd);
      await cmdIndexTurns();
      // Vectors are optional and slow; skip silently when the stack is absent.
      if (withVectors === '1' && semanticAvailable()) await cmdIndexVectors();
    } catch (err) {
      process.stderr.write(`[secretary-bg-sync] ${err.message}\n`);
    }
    clearBgWorkerForProject(cwd);
    process.exit(0);
  }

  if (command === '_bg_regenerate') {
    const [, , , cwd, sessionId] = process.argv;
    try {
      if (!(await ensureLLMRunning())) process.exit(0);
      const db = openDb(cwd);
      if (!db) process.exit(0);
      try {
        await bootstrapBulletsFromDb(db, cwd);
      } finally {
        db.close();
      }
    } catch (err) {
      process.stderr.write(`[secretary-bg-regen] ${err.message}\n`);
    }
    clearBgWorkerForProject(cwd);
    process.exit(0);
  }

  // Background deletion worker (forked child process for FORGET)
  if (command === '_bg_delete') {
    const [, , , cwd, actionsJson] = process.argv;
    try {
      const actions = JSON.parse(actionsJson);
      const db = openDb(cwd);
      if (!db) process.exit(1);
      try {
        const llmAvailable = await isLLMAvailable();
        for (const { intent, content } of actions) {
          switch (intent) {
            case 'FORGET':
              await actionForget(content, db, cwd, llmAvailable);
              break;
          }
        }
      } finally {
        db.close();
      }
    } catch (err) {
      process.stderr.write(`[secretary-bg] delete error: ${err.message}\n`);
    }
    clearBgWorkerForProject(cwd);
    process.exit(0);
  }

  const validCommands = ['incremental', 'compact', 'restore', 'force', 'inject', 'recall', 'search', 'index-turns', 'index-vectors', 'sync', 'user-prompt', 'handoff-status', 'await-handoff', 'drain-global'];

  if (command === 'drain-global') {
    cmdDrainGlobal(process.argv.includes('--dry-run'));
    return;
  }

  if (command === 'backend') {
    cmdBackend(process.argv.slice(3));
    return;
  }

  if (command === 'search') {
    await cmdSearch();
    return;
  }

  if (command === 'index-turns') {
    await cmdIndexTurns();
    return;
  }

  if (command === 'index-vectors') {
    await cmdIndexVectors();
    return;
  }

  if (command === 'sync') {
    await cmdSync({ vectors: !process.argv.includes('--no-vectors') });
    return;
  }

  if (!command || !validCommands.includes(command)) {
    process.stderr.write('The Secretary — AI-powered context persistence for Claude Code\n\n');
    process.stderr.write('Usage: summarize.mjs <command>\n');
    process.stderr.write('  incremental       Periodic summary (PostToolUse hook)\n');
    process.stderr.write('  compact           Pre-compaction summary + warning (PreCompact hook)\n');
    process.stderr.write('  restore           Inject context into new session (SessionStart hook)\n');
    process.stderr.write('  force             Force immediate summary (Stop hook or manual)\n');
    process.stderr.write('  inject            Inject manual text: --text "your context"\n');
    process.stderr.write('  recall            Show the whole index: saved items + context\n');
    process.stderr.write('  search <query>    Search cache + DB for a query\n');
    process.stderr.write('  backend [name]    Show or switch the summarizing AI: local | apple | claude [model] [--account <name|email|folder>]\n');
    process.stderr.write('  index-turns       Backfill the verbatim FTS index from transcripts on disk\n');
    process.stderr.write('  index-vectors     Build the semantic index (optional; needs embedding venv)\n');
    process.stderr.write('  sync              Refresh both indexes in the background (SessionStart hook)\n');
    process.stderr.write('  user-prompt       UserPromptSubmit hook: auto-inject context on recall-style prompts\n');
    process.stderr.write('  handoff-status    Tell the user the previous session\'s handoff is still being written (statusLine command)\n');
    process.stderr.write('  await-handoff     Wait for the previous session\'s handoff summary, then print it\n');
    process.exit(1);
  }

  let hookInput = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) hookInput = JSON.parse(raw);
  } catch { /* no stdin or invalid JSON */ }

  try {
    switch (command) {
      case 'incremental': await incremental(hookInput); break;
      case 'compact': await compact(hookInput); break;
      case 'restore': await restore(hookInput); break;
      case 'force':
        await force(hookInput, { stopLlm: process.argv.includes('--stop-llm'), notify: process.argv.includes('--notify') });
        // After the handoff has read the full transcript. Under the launcher the
        // next prompt trims, so that cut is the one that reopens the session.
        if (!process.env.SECRETARY_LAUNCHER_PID) trimIfOverLimit(hookInput);
        break;
      case 'inject': await inject(hookInput); break;
      case 'recall': await recall(hookInput); break;
      case 'user-prompt': await userPromptHook(hookInput); break;
      case 'handoff-status': handoffStatus(hookInput); break;
      case 'await-handoff': await awaitHandoff(hookInput, { rewake: process.argv.includes('--rewake') }); break;
    }
  } catch (err) {
    process.stderr.write(`[secretary] ${err.message}\n`);
  }
}

main();
