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

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { execSync, execFile, execFileSync } from 'child_process';
import http from 'http';

// ═══════════════════ CONFIG ═══════════════════

const SECRETARY_DIR = join(homedir(), '.claude', 'the-secretary');
const CONFIG_PATH = join(SECRETARY_DIR, 'config.json');

function loadConfig() {
  const defaults = {
    provider: 'claude_cli',
    claude_bin: '/opt/homebrew/bin/claude',
    claude_model: 'claude-haiku-4-5',
    llm_url: 'http://localhost:8922/v1/chat/completions',
    model: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    summarize_every_n: 15,
    min_new_chars: 2000,
    max_summary_tokens: 1500,
    restore_recent_items: 15,
    db_path: join(SECRETARY_DIR, 'summaries.db'),
  };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    const merged = { ...defaults, ...raw };
    merged.db_path = merged.db_path.replace(/^~/, homedir());
    return merged;
  } catch {
    return defaults;
  }
}

const config = loadConfig();

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
  // Personal monorepo-of-projects buckets that group unrelated skills/apps.
  'AI.SKILLS',
]);

function parentDir(p) {
  const i = p.lastIndexOf('/');
  if (i <= 0) return null;
  return p.slice(0, i);
}

const PROJECT_DATA_SUBDIR = join('.claude', 'the-secretary');

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

// One-time seed of a freshly created project DB: copy this project's rows out
// of the old global DB so existing memory shows up in the new per-project
// storage. The global DB is left untouched (non-destructive); reads only look
// at the project DB + '__global__' rows, so nothing is duplicated.
function migrateFromGlobalDb(db, root) {
  try {
    if (db.prepare('SELECT 1 FROM main.summaries LIMIT 1').get()) return;
    const { clause, params } = projectTreeClause(root);
    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM g.summaries WHERE ${clause} AND project_dir != '__global__'`
    ).get(...params)?.c || 0;
    if (!count) return;
    db.prepare(`
      INSERT INTO main.summaries (${ITEM_COLS})
      SELECT ${ITEM_COLS}
      FROM g.summaries WHERE ${clause} AND project_dir != '__global__'
    `).run(...params);
    process.stderr.write(`[secretary] Migrated ${count} item(s) from the global DB into ${projectDbPath(root)}\n`);
  } catch { /* best effort */ }
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

function callLLM(prompt, maxTokens = 1500) {
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
    return { fails: parsed.fails | 0, degradedUntil: parsed.degradedUntil | 0 };
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

function callClaudeCLI(prompt, maxTokens = 1500) {
  return new Promise((resolve, reject) => {
    if (isClaudeDegraded()) {
      return reject(new Error('claude CLI provider is degraded (cooling down after repeated failures)'));
    }
    const bin = config.claude_bin;
    const model = config.claude_model;
    const args = ['-p', '--model', model, '--output-format', 'json'];
    const child = execFile(bin, args, {
      timeout: 45000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
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
            if (parsed.data?.[0]?.id) detectedModel = parsed.data[0].id;
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

async function ensureLLMRunning() {
  if (config.provider === 'claude_cli') {
    if (isClaudeDegraded()) return false;
    return existsSync(config.claude_bin);
  }
  if (await isLLMAvailable()) return true;
  const startScript = join(SECRETARY_DIR, 'start-llm.sh');
  if (!existsSync(startScript)) return false;
  try {
    execSync(`bash "${startScript}" start`, { timeout: 30000, stdio: 'ignore' });
    return await isLLMAvailable();
  } catch {
    return false;
  }
}

// ═══════════════════ BG WORKER LOCK + DEBOUNCE ═══════════════════
//
// Prevents a flood of concurrent _bg_summarize processes from queuing up on
// slower machines. If a worker is still alive, skip spawning a new one.
// Also enforces a minimum gap between launches (debounce).

const BG_DEBOUNCE_MS = 30_000;

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

// ═══════════════════ NOTIFICATIONS ═══════════════════

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

function parseTranscript(transcriptPath, fromOffset = 0) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { messages: [], rawLength: 0 };

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];

  for (let i = fromOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
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

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            text += block.text + '\n';
          } else if (block.type === 'tool_use') {
            toolText += `[Tool: ${block.name}] ${JSON.stringify(block.input || {}).slice(0, 200)}\n`;
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

      if (text.length > 10 && !FILLER_RE.test(text)) {
        messages.push({ role: mappedRole, kind: 'talk', text: text.slice(0, 3000), line: i, ts });
      } else if (toolText.trim().length > 10) {
        messages.push({ role: 'tool', kind: 'tool', text: toolText.trim().slice(0, 1000), line: i, ts });
      }
    } catch { /* skip malformed lines */ }
  }

  return { messages, rawLength: lines.length };
}

/**
 * Build the summarizer input under a char budget.
 *
 * Two rules, both learned the hard way from transcripts where the summary came out
 * describing tool output instead of the work:
 *  - User turns state the intent and the constraints, so they are admitted first and
 *    only then assistant turns; tool traffic fills whatever is left, if anything.
 *  - Selection walks BACKWARDS. The end of a session holds its current state, which is
 *    what a handoff needs; truncating from the front kept only the stale opening.
 * Emitted output is restored to chronological order so the model reads a conversation.
 */
function messagesToText(messages, maxChars = 8000) {
  const budget = { used: 0 };
  const picked = new Set();

  const admit = (list) => {
    for (const m of list) {
      const cost = m.text.length + 16;
      if (budget.used + cost > maxChars) continue;
      budget.used += cost;
      picked.add(m);
    }
  };

  const recentFirst = [...messages].reverse();
  admit(recentFirst.filter(m => m.kind === 'talk' && m.role === 'user'));
  admit(recentFirst.filter(m => m.kind === 'talk' && m.role === 'assistant'));
  admit(recentFirst.filter(m => m.kind === 'tool'));

  let text = '';
  for (const m of messages) {
    if (!picked.has(m)) continue;
    const prefix = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL';
    text += `[${prefix}]: ${m.text}\n\n`;
  }
  return text;
}

/**
 * Store conversation turns verbatim in the FTS index.
 *
 * Only `talk` turns are kept — tool traffic is machine chatter nobody recalls in words.
 * The transcript offset already advances per hook call, so each turn is seen once; a
 * line-keyed guard in `state` makes re-processing (a replayed hook, a resumed session)
 * idempotent anyway.
 */
function indexTurns(db, messages, { session_id, cwd }) {
  if (!db || !messages?.length) return 0;

  const talk = messages.filter(m => m.kind === 'talk' && m.text.length >= 20);
  if (!talk.length) return 0;

  const guardKey = `fts-line:${session_id}`;
  let lastLine = -1;
  try {
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(guardKey);
    if (row) lastLine = parseInt(row.value, 10);
  } catch { return 0; }

  const fresh = talk.filter(m => m.line > lastLine);
  if (!fresh.length) return 0;

  try {
    const insert = db.prepare(
      'INSERT INTO turns (body, role, session_id, project_dir, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    // Prefer the turn's own timestamp; fall back to now only for entries that lack one
    // (older transcript formats). Indexing time is not conversation time: a backfill
    // would otherwise stamp thousands of turns with one identical instant.
    const now = new Date().toISOString();
    const run = db.transaction((rows) => {
      for (const m of rows) insert.run(m.text, m.role, session_id, cwd || '', m.ts || now);
    });
    run(fresh);

    const maxLine = fresh.reduce((a, m) => Math.max(a, m.line), lastLine);
    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
      .run(guardKey, String(maxLine));
    return fresh.length;
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
const VEC_MIN_SIM = 0.62;
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

/** Embed texts via the helper process. Returns Float32Array[] or null on any failure. */
function embedTexts(texts) {
  if (!texts?.length || !semanticAvailable()) return null;
  try {
    const out = execFileSync(embedPython(), [EMBED_SCRIPT], {
      input: JSON.stringify({ texts }),
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    if (parsed.error || !parsed.vectors?.length) return null;
    return parsed.vectors.map(v => new Float32Array(v));
  } catch { return null; }
}

/** Nearest turns by cosine similarity. Returns [] whenever the stack is unavailable. */
function vectorSearch(db, query, limit) {
  if (!semanticAvailable()) return [];
  try {
    if (!loadVecExtension(db)) return [];
    const has = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'vturns'").get()?.n;
    if (!has) return [];
    const [qv] = embedTexts([query]) || [];
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
      const t = db.prepare('SELECT body, role, project_dir, created_at FROM turns WHERE rowid = ?').get(r.rid);
      if (t) out.push({ ...t, sim });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// ═══════════════════ DATE PARSING ═══════════════════


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

    const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);

    // Process secretary orders on EVERY call (no counter gate) — fast regex, sync
    await processSecretaryOrders(messages, db, cwd, session_id);

    // Index verbatim turns on EVERY call too: the summary gate below runs once every
    // N calls, and turns skipped here would never be searchable.
    indexTurns(db, messages, { session_id, cwd });

    // Only do full LLM summary every N tool calls
    if (counter % config.summarize_every_n !== 0) return;

    const text = messagesToText(messages);
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
      const raw = await callLLM(prompt, 300);
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
    const raw = await callLLM(prompt, 1200);
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

  if (!(await ensureLLMRunning())) {
    process.exit(1);
  }

  // Two prompt flavours:
  //   - Incremental (every N tool calls): bullet-list of decisions/changes/
  //     problems/state. Useful for in-session recall.
  //   - Handoff (Stop hook — session is closing): a denser brief written so
  //     the next session can resume WITHOUT the user re-explaining anything.
  //     Mirrors the manual context the user used to inject by hand.
  const incrementalPrompt = `Summarize this coding conversation segment. Extract:

- DECISIONS: What was decided and why (max 3)
- CHANGES: Files modified and how (max 5)
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

  const handoffPrompt = `You are writing a session handoff so the NEXT session can resume this work WITHOUT the user explaining anything again. The reader will be a fresh assistant with no memory of what just happened.

Output Markdown with these sections (skip a section only if truly nothing applies):

## What was accomplished
2-5 bullets. Concrete: feature names, file paths, what now works that didn't before.

## Current state
Where things stand at session close. What's running, what's broken, what's untested. Mention the active branch, server URL, or any process worth knowing.

## Next step
The single most likely first action when the user returns. Be specific (a file to open, a function to write, a bug to verify).

## Open questions / decisions pending
Things the user has not decided yet that would block progress.

## Don't break / hard rules
Constraints repeated by the user this session: backups required, naming conventions, "never revert without permission", language rules, etc. Anything that, if forgotten, would frustrate the user.

## Backups
Paths of any backup folders created this session.

## Key files touched
File paths + one-line description of what changed in each.

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
  // Handoffs benefit from a higher token budget so all sections fit.
  const summary = await callLLM(prompt, isHandoff ? 1500 : undefined);
  if (!summary || summary.length < 50) {
    process.exit(0);
  }

  const db = openDb(cwd);
  if (!db) process.exit(1);

  try {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM all_items WHERE session_id = ?').get(sessionId);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    // Tag handoff entries with a [HANDOFF] prefix so the SessionStart hook
    // can surface them prominently. Plain summaries stay untagged.
    const summaryRow = isHandoff ? `[HANDOFF] ${summary}` : summary;
    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      sessionId, cwd, chunkIndex, summaryRow, parseInt(messageCount, 10)
    );

    try { await updateBulletsCache(db, cwd, sessionId, summary); } catch { /* cache failure must not break summarization */ }
  } finally {
    db.close();
  }

  if (shouldNotify) {
    let blurb = '';
    try {
      const blurbPrompt = `From this coding session summary, write ONE short sentence in ENGLISH (max 90 characters, no quotes, no markdown) describing what was accomplished or the current state. Be concrete — mention the main thing done. Output only the sentence, nothing else.\n\nSUMMARY:\n${summary}`;
      const raw = await callLLM(blurbPrompt, 60);
      blurb = (raw || '').replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
      if (blurb.length > 120) blurb = blurb.slice(0, 117) + '...';
    } catch { /* notify without blurb */ }
    notify('Claude Code — Session saved', blurb || 'Context stored by The Secretary');
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

        const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);

        await processSecretaryOrders(messages, db, cwd, session_id);

        const text = messagesToText(messages);

        if (text.length >= 500) {
          if (await ensureLLMRunning()) {
            const prompt = `Summarize this coding conversation segment. Extract:

- DECISIONS: What was decided and why (max 3)
- CHANGES: Files modified and how (max 5)
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

            const summary = await callLLM(prompt);
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
  const { session_id, cwd } = hookInput;

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
      const handoffRow = db.prepare(`
        SELECT summary, created_at, session_id FROM all_items
        WHERE ${tree.clause}
          AND summary LIKE '[HANDOFF]%'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(...tree.params);
      if (handoffRow) {
        const body = (handoffRow.summary || '').replace(/^\[HANDOFF\]\s*/i, '').trim();
        const when = handoffRow.created_at
          ? new Date(handoffRow.created_at + 'Z').toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '';
        handoffBrief = `## 📋 Session handoff — resume here\n\n_Written at the end of the previous session (${when}). Read this first; the older bullet summaries below are background._\n\n${body}\n`;
        output += handoffBrief + '\n';
      }
    }

    // 2b. Latest raw items across the WHOLE project tree, newest-first. This is
    //     the literal "what happened most recently in the DB" view the user
    //     asked for — independent of session grouping or bullet caching, so it
    //     can never go stale relative to a handoff written under a sibling path.
    if (cwd) {
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

    const cacheLabel = cacheHit ? ` _(bullets cache)_` : '';
    const ctxLabel = handoffBrief ? '## Background — older session bullets' : '## Context from Previous Conversation (auto-injected by The Secretary)';
    output += `${ctxLabel}${cacheLabel}\n\n${finalSummary}\n`;

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
    notify('The Secretary', `Memory recovered from ${formattedDate} (${totalItems} items)`);

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
        const wmDir = join(homedir(), '.claude', 'the-secretary', 'watermarks');
        mkdirSync(wmDir, { recursive: true });
        writeFileSync(join(wmDir, `${session_id}.json`), JSON.stringify(watermark));
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

    const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);

    await processSecretaryOrders(messages, db, cwd, session_id);

    const text = messagesToText(messages);

    if (text.length < 100) {
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
      stdio: 'ignore',
    });
    child.unref();
    registerBgWorker(session_id, child.pid);
    registerBgWorkerForProject(cwd, child.pid);
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
            AND summary LIKE '[HANDOFF]%'
          ORDER BY created_at DESC LIMIT 2
        `).all(lastSessionRow.session_id);

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
              const consolidated = await callLLM(prompt, 2000);
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

  // "Where were we?" is a question about time, not about words — answer it from the
  // tail of the conversation. Keyword ranking would surface any old turn that merely
  // repeats the phrasing. Regex first (instant, covers the common phrasings); the local
  // model is consulted only when it misses, since phrasing is open-ended.
  if (isTemporalQuery(q) || await isTemporalQueryLLM(q)) {
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
  let terms = q.split(/\s+/)
    .map((t) => t.replace(/[.,;:!?()"']/g, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  // If the query was ALL stopwords, fall back to the original tokens rather
  // than returning nothing.
  if (terms.length === 0) terms = q.split(/\s+/).filter((t) => t.length >= 3);
  terms = terms.slice(0, 5);
  if (terms.length === 0) return [];

  const hits = [];

  // ── 1. Cache .md files (this project only) ──
  try {
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
        const match = buildMatchQuery(terms);
        if (match) {
          const rows = db.prepare(`
            SELECT body, role, project_dir, created_at, bm25(turns) AS rank
            FROM turns
            WHERE turns MATCH ?
            ORDER BY rank
            LIMIT ?
          `).all(match, maxHits - hits.length);

          for (const row of rows) {
            const body = row.body || '';
            const lower = body.toLowerCase();
            const firstTerm = terms.find(t => lower.includes(t.toLowerCase())) || terms[0];
            const idx = Math.max(0, lower.indexOf(firstTerm.toLowerCase()));
            const start = Math.max(0, idx - 120);
            const end = Math.min(body.length, idx + snippetChars);
            const snippet = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
            hits.push({
              source: row.role === 'user' ? 'said' : 'turn',
              project: basename(row.project_dir || '') || 'unknown',
              date: (row.created_at || '').split('T')[0],
              score: 0,
              snippet: snippet.trim(),
            });
          }
        }
        // ── 2b. Semantic fallback ──
        // Only when the literal pass came up short. Tagged `approx` so the caller can
        // show these as "close in meaning", never as something that was actually said.
        if (hits.length < maxHits) {
          for (const row of vectorSearch(db, q, maxHits - hits.length)) {
            hits.push({
              source: row.role === 'user' ? 'said~' : 'turn~',
              approx: true,
              project: basename(row.project_dir || '') || 'unknown',
              date: (row.created_at || '').split('T')[0],
              score: 0,
              snippet: (row.body || '').slice(0, snippetChars).trim(),
            });
          }
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
        const likeClauses = terms.map(() => 'summary LIKE ?').join(' AND ');
        const params = terms.map((t) => `%${t}%`);
        const rows = db.prepare(`
          SELECT project_dir, summary, created_at
          FROM all_items
          WHERE 1=1
            AND ${likeClauses}
          ORDER BY created_at DESC
          LIMIT ?
        `).all(...params, maxHits - hits.length);

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
            score: 0,
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
    const insert = db.prepare('INSERT INTO vturns(rowid, embedding) VALUES (?, ?)');
    let done = 0;
    const BATCH = 128;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const vecs = embedTexts(slice.map(r => r.body));
      if (!vecs) { process.stderr.write('[secretary] embedding failed — stopping\n'); break; }
      const tx = db.transaction((rows) => {
        rows.forEach((r, k) => insert.run(BigInt(r.rid), vecs[k]));
      });
      tx(slice);
      done += slice.length;
      process.stdout.write(`  ${done}/${pending.length}\n`);
    }
    const total = db.prepare('SELECT count(*) n FROM vturns').get()?.n ?? 0;
    process.stdout.write(`Semantic index: ${done} new vector(s). Total: ${total}\n`);
  } catch (err) {
    process.stderr.write(`[secretary] index-vectors error: ${err.message}\n`);
  } finally {
    db.close();
  }
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

  let files = 0, indexed = 0;
  try {
    for (const f of readdirSync(projectsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.replace(/\.jsonl$/, '');
      let messages;
      try {
        ({ messages } = parseTranscript(join(projectsDir, f)));
      } catch { continue; } // one unreadable transcript must not abort the rest
      if (!messages.length) continue;
      files++;
      indexed += indexTurns(db, messages, { session_id: sessionId, cwd });
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
async function checkFreshContextWatermark(hookInput) {
  const { session_id, cwd } = hookInput;
  if (!session_id || !cwd) return;

  const wmFile = join(homedir(), '.claude', 'the-secretary', 'watermarks', `${session_id}.json`);
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
    const SNIP = 400;
    const shown = rows.slice(-MAX_SHOW);

    let out = `\n## 📥 The Secretary: contexto nuevo disponible\n\n`;
    out += `_${rows.length} resumen${rows.length > 1 ? 'es' : ''} añadido${rows.length > 1 ? 's' : ''} desde el inicio de esta sesión (probablemente el summarizer de la sesión previa terminó después del \`/clear\`)._\n\n`;
    for (const r of shown) {
      const clean = (r.summary || '').replace(/^\[RAW-TAIL\]\s*/i, '').trim();
      const snippet = clean.length > SNIP ? clean.slice(0, SNIP) + '…' : clean;
      out += `### ${r.created_at}\n\n${snippet}\n\n---\n\n`;
    }
    process.stdout.write(out);
  } finally {
    db.close();
  }
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
    // If called with --stop-llm, shut down the LLM server after summarizing
    if (flags.includes('--stop-llm')) {
      try {
        execSync('bash ~/.claude/the-secretary/start-llm.sh stop > /dev/null 2>&1');
      } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // Background cache bootstrap — if bullets.md doesn't exist yet for this
  // project but the DB has summaries, distill them into bullets so the
  // next SessionStart gets the new cache format without blocking.
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

  const validCommands = ['incremental', 'compact', 'restore', 'force', 'inject', 'recall', 'search', 'index-turns', 'index-vectors', 'user-prompt'];

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
    process.stderr.write('  index-turns       Backfill the verbatim FTS index from transcripts on disk\n');
    process.stderr.write('  index-vectors     Build the semantic index (optional; needs embedding venv)\n');
    process.stderr.write('  user-prompt       UserPromptSubmit hook: auto-inject context on recall-style prompts\n');
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
      case 'force': await force(hookInput, { stopLlm: process.argv.includes('--stop-llm'), notify: process.argv.includes('--notify') }); break;
      case 'inject': await inject(hookInput); break;
      case 'recall': await recall(hookInput); break;
      case 'user-prompt': await userPromptHook(hookInput); break;
    }
  } catch (err) {
    process.stderr.write(`[secretary] ${err.message}\n`);
  }
}

main();
