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
 *   recall       - Show all stored memories, notes, reminders and context
 *   recall-notes - Show only notes
 *   recall-reminders - Show only reminders
 *
 * Reads hook JSON from stdin.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import http from 'http';

// ═══════════════════ CONFIG ═══════════════════

const SUMMARIZER_DIR = join(homedir(), '.claude', 'summarizer');
const CONFIG_PATH = join(SUMMARIZER_DIR, 'config.json');

function loadConfig() {
  const defaults = {
    llm_url: 'http://localhost:8922/v1/chat/completions',
    model: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    summarize_every_n: 15,
    min_new_chars: 2000,
    max_summary_tokens: 1500,
    db_path: join(SUMMARIZER_DIR, 'summaries.db'),
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

// ═══════════════════ CACHE (per-project pre-generated summaries) ═══════════════════

const CACHE_DIR = join(SUMMARIZER_DIR, 'cache');
const CACHE_MAX_AGE_DAYS = 30;
const CACHE_MAX_FILES_PER_PROJECT = 10;

function projectFolderName(cwd) {
  if (!cwd) return '__unknown__';
  const base = basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '_') || '_';
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function cacheDirForProject(cwd) {
  return join(CACHE_DIR, projectFolderName(cwd));
}

function ensureCacheDir(cwd) {
  const dir = cacheDirForProject(cwd);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function isoStampForFile() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function writeCacheFile(cwd, content, metadata = {}) {
  try {
    const dir = ensureCacheDir(cwd);
    const stamp = isoStampForFile();
    const file = join(dir, `${stamp}.md`);
    const header =
      `---\n` +
      `generated_at: ${new Date().toISOString()}\n` +
      `project_dir: ${cwd || ''}\n` +
      (metadata.session_id ? `session_id: ${metadata.session_id}\n` : '') +
      (metadata.chunks_included != null ? `chunks_included: ${metadata.chunks_included}\n` : '') +
      `---\n\n`;
    writeFileSync(file, header + content, 'utf-8');
    pruneOldCaches(cwd);
    return file;
  } catch {
    return null;
  }
}

function listCacheFiles(cwd) {
  const dir = cacheDirForProject(cwd);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const full = join(dir, f);
        const st = statSync(full);
        return { file: full, name: f, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function readLatestCacheFile(cwd) {
  const files = listCacheFiles(cwd);
  if (files.length === 0) return null;
  const latest = files[0];
  try {
    const raw = readFileSync(latest.file, 'utf-8');
    let meta = {};
    let body = raw;
    const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?/);
    if (m) {
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2];
      }
      body = raw.slice(m[0].length);
    }
    return { file: latest.file, mtimeMs: latest.mtimeMs, meta, body };
  } catch {
    return null;
  }
}

function pruneOldCaches(cwd) {
  try {
    const files = listCacheFiles(cwd);
    const now = Date.now();
    const maxAgeMs = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (let i = 0; i < files.length; i++) {
      const tooOld = (now - files[i].mtimeMs) > maxAgeMs;
      const overLimit = i >= CACHE_MAX_FILES_PER_PROJECT;
      if (tooOld || overLimit) {
        try { unlinkSync(files[i].file); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ═══════════════════ DATABASE ═══════════════════

let Database;
try {
  const require = createRequire(import.meta.url);
  try {
    Database = require('better-sqlite3');
  } catch {
    const globalPaths = [
      join(homedir(), '.claude', 'summarizer', 'node_modules', 'better-sqlite3'),
      join(SUMMARIZER_DIR, 'node_modules', 'better-sqlite3'),
    ];
    for (const p of globalPaths) {
      try { Database = require(p); break; } catch { /* continue */ }
    }
  }
} catch { /* will be checked later */ }

function openDb() {
  if (!Database) return null;
  try {
    const db = new Database(config.db_path);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        chunk_index INTEGER DEFAULT 0,
        summary TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Schema migration: add columns for The Secretary features
    try { db.exec(`ALTER TABLE summaries ADD COLUMN due_at TEXT DEFAULT NULL`); } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE summaries ADD COLUMN status TEXT DEFAULT 'active'`); } catch { /* already exists */ }
    return db;
  } catch {
    return null;
  }
}

// ═══════════════════ LLM ═══════════════════

function callLLM(prompt, maxTokens = 1500) {
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

function isLLMAvailable() {
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
  if (await isLLMAvailable()) return true;
  const startScript = join(SUMMARIZER_DIR, 'start-llm.sh');
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

// ═══════════════════ NOTIFICATIONS ═══════════════════

function notify(title, message) {
  try {
    execSync(`osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`, { timeout: 3000, stdio: 'ignore' });
  } catch { /* silent */ }
}

// ═══════════════════ TRANSCRIPT PARSING ═══════════════════

function parseTranscript(transcriptPath, fromOffset = 0) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { messages: [], rawLength: 0 };

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];

  for (let i = fromOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = entry.message || entry;
      const role = msg.role || entry.type;

      if (!role) continue;

      const content = msg.content;
      let text = '';

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            text += block.text + '\n';
          } else if (block.type === 'tool_use') {
            text += `[Tool: ${block.name}] ${JSON.stringify(block.input || {}).slice(0, 500)}\n`;
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            text += `[Result] ${resultText.slice(0, 500)}\n`;
          }
        }
      }

      if (entry.toolUseResult?.stdout) {
        text += entry.toolUseResult.stdout.slice(0, 500) + '\n';
      }

      text = text.trim();
      if (text.length > 10) {
        const mappedRole = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'tool';
        messages.push({ role: mappedRole, text: text.slice(0, 3000), line: i });
      }
    } catch { /* skip malformed lines */ }
  }

  return { messages, rawLength: lines.length };
}

function messagesToText(messages, maxChars = 8000) {
  let text = '';
  for (const m of messages) {
    const prefix = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL';
    const line = `[${prefix}]: ${m.text}\n\n`;
    if (text.length + line.length > maxChars) break;
    text += line;
  }
  return text;
}

// ═══════════════════ DATE PARSING ═══════════════════

/**
 * Parse a due date from natural language text.
 * Returns ISO date string (YYYY-MM-DD) or null if no date found.
 */
function parseDueDate(text) {
  const lower = text.toLowerCase();
  const now = new Date();

  // ISO format: 2026-04-15
  let m = lower.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];

  // "mañana" / "tomorrow"
  if (/\bma[nñ]ana\b/.test(lower) || /\btomorrow\b/.test(lower)) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  // "pasado mañana" / "day after tomorrow"
  if (/\bpasado\s+ma[nñ]ana\b/.test(lower) || /\bday\s+after\s+tomorrow\b/.test(lower)) {
    const d = new Date(now); d.setDate(d.getDate() + 2);
    return d.toISOString().split('T')[0];
  }

  // "hoy" / "today"
  if (/\bhoy\b/.test(lower) || /\btoday\b/.test(lower)) {
    return now.toISOString().split('T')[0];
  }

  // Day of week
  const days = {
    lunes: 1, monday: 1, martes: 2, tuesday: 2, miercoles: 3, 'miércoles': 3, wednesday: 3,
    jueves: 4, thursday: 4, viernes: 5, friday: 5, sabado: 6, 'sábado': 6, saturday: 6,
    domingo: 0, sunday: 0
  };
  for (const [name, dayNum] of Object.entries(days)) {
    if (lower.includes(name)) {
      const d = new Date(now);
      const diff = (dayNum - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().split('T')[0];
    }
  }

  // "en N días/semanas" / "in N days/weeks"
  m = lower.match(/(?:en|in)\s+(\d+)\s+(?:d[ií]as?|days?)/);
  if (m) {
    const d = new Date(now); d.setDate(d.getDate() + parseInt(m[1]));
    return d.toISOString().split('T')[0];
  }
  m = lower.match(/(?:en|in)\s+(\d+)\s+(?:semanas?|weeks?)/);
  if (m) {
    const d = new Date(now); d.setDate(d.getDate() + parseInt(m[1]) * 7);
    return d.toISOString().split('T')[0];
  }

  // "el N de MES" / Spanish date
  const months = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };
  for (const [mName, mNum] of Object.entries(months)) {
    const re = new RegExp(`(?:el\\s+)?(\\d{1,2})\\s+(?:de\\s+)?${mName}`, 'i');
    const mx = lower.match(re);
    if (mx) {
      const d = new Date(now.getFullYear(), mNum, parseInt(mx[1]));
      if (d < now) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString().split('T')[0];
    }
    // Also match "april 15" format
    const re2 = new RegExp(`${mName}\\s+(\\d{1,2})`, 'i');
    const mx2 = lower.match(re2);
    if (mx2) {
      const d = new Date(now.getFullYear(), mNum, parseInt(mx2[1]));
      if (d < now) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString().split('T')[0];
    }
  }

  return null;
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
  if (/\[REMINDER\]/i.test(line)) return true;        // stored reminder
  if (/\[Tool:|^\[Result\]/i.test(line)) return true; // tool markers
  if (/\[secretary\]/i.test(line)) return true;        // secretary log output
  if (/^\{.*\}$/.test(line.trim())) return true;       // JSON objects
  if (/intent:|content:/.test(line)) return true;      // classification output
  if (/REMEMBER\||FORGET\||NOTE\||REMINDER\||NONE\|/.test(line)) return true; // LLM classification output
  if (/^\s*→\s/.test(line)) return true;               // arrow output from tests
  return false;
}

/**
 * Use the local LLM to classify a user line into an intent.
 * Returns: { intent, content, dueDate? }
 *
 * Intents: REMEMBER, FORGET, NOTE, NOTE_DELETE, REMINDER, REMINDER_DONE, NONE
 */
async function classifyIntent(line) {
  const prompt = `Classify this user message into exactly ONE intent. The user is talking to an AI coding assistant and wants to manage their personal notes, memories, or reminders.

USER MESSAGE: "${line}"

INTENTS:
- REMEMBER: User wants to save a PERMANENT FACT about themselves, their identity, or preferences. Key signals: "recuerda que" (followed by a fact), "soy...", "mi nombre es...", "prefiero...", "I am...", "my name is...", "I prefer...". These are FACTS, not tasks.
- FORGET: User wants to delete a previously saved memory/fact. Key signals: "olvida que...", "forget that...", "ya no soy...", "borra la memoria de..."
- NOTE: User wants to save a note/observation about something. Key signals: "toma nota", "anota", "apunta", "nota:", "note:", "note down". These are observations or info to keep track of.
- NOTE_DELETE: User wants to delete a note. Key signals: "borra la nota", "delete the note", "quita la nota"
- REMINDER: User wants to be REMINDED about a FUTURE TASK or event, usually with a time reference. Key signals: "avísame", "recuérdame" (remind ME), "remind me", "set a reminder", "recordatorio". These are TASKS with deadlines, not facts.
- REMINDER_DONE: User wants to mark a reminder as done or cancel it. Key signals: "ya hice...", "cancela el recordatorio", "mark done", "dismiss"
- NONE: Not a secretary order, just regular conversation

CRITICAL DISTINCTION:
- "recuerda que soy developer" = REMEMBER (it's a fact about identity)
- "recuérdame hacer deploy" = REMINDER (it's a future task)
- "recuerda que mi editor es neovim" = REMEMBER (it's a preference/fact)
- "recuérdame actualizar el README" = REMINDER (it's a task to do)

RESPOND WITH ONLY ONE LINE in this exact format:
INTENT|content text here

Where INTENT is one of: REMEMBER, FORGET, NOTE, NOTE_DELETE, REMINDER, REMINDER_DONE, NONE
And content is the extracted core content (what to remember/note/remind, without the command words).
For NONE, content can be empty.

Examples:
- "recuerda que soy developer senior" → REMEMBER|soy developer senior
- "olvida lo del mono" → FORGET|lo del mono
- "toma nota: el servidor se cae los martes" → NOTE|el servidor se cae los martes
- "borra la nota del servidor" → NOTE_DELETE|del servidor
- "avísame el viernes que hay deploy" → REMINDER|hay deploy el viernes
- "ya hice el deploy" → REMINDER_DONE|el deploy
- "cambia el color del botón a rojo" → NONE|`;

  try {
    const response = await callLLM(prompt, 50);
    const cleaned = response.trim().split('\n')[0]; // take first line only
    const pipeIdx = cleaned.indexOf('|');
    if (pipeIdx === -1) return { intent: 'NONE', content: '' };

    const intent = cleaned.slice(0, pipeIdx).trim().toUpperCase();
    const content = cleaned.slice(pipeIdx + 1).trim();

    const validIntents = ['REMEMBER', 'FORGET', 'NOTE', 'NOTE_DELETE', 'REMINDER', 'REMINDER_DONE', 'NONE'];
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

  // REMEMBER (detect "global" modifier: "recuerda global que...", "remember global that...")
  if (/(?:recuerda\s+global\s+que|remember\s+global\s+that)\s+(.+)/i.test(t)) return { intent: 'REMEMBER', content: t, global: true };
  if (/(?:recuerda\s+que|no\s+olvides\s+que|remember\s+that|don'?t\s+forget\s+that)\s+(.+)/i.test(t)) return { intent: 'REMEMBER', content: t };
  if (/^(?:recuerda|remember)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'REMEMBER', content: t, global: true };
  if (/^(?:recuerda|remember)[:\s]+(.+)/i.test(t)) return { intent: 'REMEMBER', content: t };
  if (/(?:^|\.\s*)(?:yo\s+)?soy\s+(?:un[ao]?\s+)?(.+)/i.test(t)) return { intent: 'REMEMBER', content: t };
  if (/(?:^|\.\s*)(?:i\s+am|i'm)\s+(?:a\s+)?(.+)/i.test(t)) return { intent: 'REMEMBER', content: t };
  if (/(?:mi\s+nombre\s+es|me\s+llamo|my\s+name\s+is)\s+(.+)/i.test(t)) return { intent: 'REMEMBER', content: t };
  if (/(?:prefiero|i\s+prefer|me\s+gusta\s+(?:más|mas))\s+(.+)/i.test(t)) return { intent: 'REMEMBER', content: t };

  // FORGET
  if (/(?:olvida|forget|olvidar)\s+/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:borra|elimina|delete|remove)\s+(?:la\s+)?(?:memoria|memory|recuerdo)/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:no\s+recuerdes|don'?t\s+remember)\s+/i.test(t)) return { intent: 'FORGET', content: t };
  if (/(?:ya\s+no\s+soy|i'?m\s+no\s+longer)\s+/i.test(t)) return { intent: 'FORGET', content: t };

  // NOTE (detect "global" modifier: "anota global que...", "nota global: ...")
  if (/^(?:toma\s+nota|anota|apunta|nota|take\s+(?:a\s+)?note|note\s+(?:down|this)|note)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'NOTE', content: RegExp.$1, global: true };
  if (/^(?:toma\s+nota|anota|apunta|nota|take\s+(?:a\s+)?note|note\s+(?:down|this)|note)[:\s]+(.+)/i.test(t)) return { intent: 'NOTE', content: RegExp.$1 };

  // NOTE_DELETE
  if (/(?:borra|elimina|delete|remove|quita|tacha)\s+(?:la\s+)?(?:nota|note)/i.test(t)) return { intent: 'NOTE_DELETE', content: t };

  // REMINDER (detect "global" modifier)
  if (/^(?:av[ií]same|recuerd[ae]me|remind\s+me)\s+global\s+(.+)/i.test(t)) return { intent: 'REMINDER', content: RegExp.$1, global: true };
  if (/^(?:av[ií]same|recuerd[ae]me|remind\s+me)\s+(.+)/i.test(t)) return { intent: 'REMINDER', content: RegExp.$1 };
  if (/^(?:pon(?:me)?\s+(?:un\s+)?recordatorio|set\s+(?:a\s+)?reminder)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'REMINDER', content: RegExp.$1, global: true };
  if (/^(?:pon(?:me)?\s+(?:un\s+)?recordatorio|set\s+(?:a\s+)?reminder)[:\s]+(.+)/i.test(t)) return { intent: 'REMINDER', content: RegExp.$1 };
  if (/^(?:reminder|recordatorio)\s+global[:\s]+(.+)/i.test(t)) return { intent: 'REMINDER', content: RegExp.$1, global: true };
  if (/^(?:reminder|recordatorio)[:\s]+(.+)/i.test(t)) return { intent: 'REMINDER', content: RegExp.$1 };

  // REMINDER_DONE
  if (/(?:ya\s+(?:hice|hiciste|hicimos)|(?:marca|mark)\s+(?:como\s+)?(?:hecho|done|listo|completed?))/i.test(t)) return { intent: 'REMINDER_DONE', content: t };
  if (/(?:borra|elimina|delete|remove|cancela?|cancel)\s+(?:el\s+)?(?:recordatorio|reminder)/i.test(t)) return { intent: 'REMINDER_DONE', content: t };
  if (/(?:dismiss|descartar?)\s+(?:el\s+)?(?:recordatorio|reminder)/i.test(t)) return { intent: 'REMINDER_DONE', content: t };

  return { intent: 'NONE', content: '' };
}

// ═══════════════════ SECRETARY ACTIONS ═══════════════════

/**
 * Process all user messages: detect orders via regex classification,
 * then execute the appropriate action. LLM is used only for flexible
 * matching in deletion/completion actions (forget, note_delete, reminder_done).
 */
async function processSecretaryOrders(messages, db, cwd) {
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
      // Sync actions (SQLite only, instant):
      case 'REMEMBER':
        await actionRemember(classification.content || line, db, effectiveCwd);
        break;
      case 'NOTE':
        await actionNote(classification.content || line, db, effectiveCwd);
        break;
      case 'REMINDER':
        await actionReminder(classification.content || line, db, effectiveCwd);
        break;
      // LLM-dependent actions — queue for background:
      case 'FORGET':
      case 'NOTE_DELETE':
      case 'REMINDER_DONE':
        bgDeletions.push({ intent: classification.intent, content: classification.content || line });
        break;
    }
  }

  // Launch LLM-dependent deletions in background (don't block the hook)
  if (bgDeletions.length > 0) {
    const { spawn } = await import('child_process');
    const child = spawn('node', [new URL(import.meta.url).pathname,
      '_bg_delete', cwd || '', JSON.stringify(bgDeletions)
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.stderr.write(`[secretary] Deletions launched in background (${bgDeletions.length} action(s))\n`);
  }
}

// ── REMEMBER ──

async function actionRemember(content, db, cwd) {
  const existingManual = db.prepare(`
    SELECT summary FROM summaries
    WHERE project_dir IN (?, '__global__') AND session_id = 'manual' AND status = 'active'
  `).all(cwd || '').map(r => r.summary.toLowerCase());

  const normalized = content.toLowerCase();
  const isDuplicate = existingManual.some(existing =>
    existing.includes(normalized) || normalized.includes(existing.replace('[remember] ', ''))
  );

  if (!isDuplicate) {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get('manual');
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;
    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      'manual', cwd || '', chunkIndex, `[REMEMBER] ${content}`, 0
    );
    process.stderr.write(`[secretary] 💾 Memory saved: "${content.slice(0, 80)}"\n`);
  }
}

// ── FORGET ──

async function actionForget(content, db, cwd, llmAvailable) {
  const manualEntries = db.prepare(`
    SELECT id, summary FROM summaries
    WHERE project_dir IN (?, '__global__') AND session_id = 'manual' AND status = 'active'
  `).all(cwd || '');

  if (manualEntries.length === 0) return;

  const idsToDelete = await matchItemsForDeletion(content, manualEntries, 'memories', llmAvailable);

  for (const id of idsToDelete) {
    const entry = manualEntries.find(e => e.id === id);
    db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
    process.stderr.write(`[secretary] 🗑️ Memory deleted: "${(entry?.summary || id).toString().slice(0, 80)}"\n`);
  }
}

// ── NOTE ──

async function actionNote(content, db, cwd) {
  const existingNotes = db.prepare(`
    SELECT summary FROM summaries
    WHERE project_dir IN (?, '__global__') AND session_id = 'notes' AND status = 'active'
  `).all(cwd || '').map(r => r.summary.toLowerCase());

  const normalized = content.toLowerCase();
  const isDuplicate = existingNotes.some(existing =>
    existing.includes(normalized) || normalized.includes(existing.replace('[note] ', ''))
  );

  if (!isDuplicate) {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get('notes');
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;
    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      'notes', cwd || '', chunkIndex, `[NOTE] ${content}`, 0
    );
    process.stderr.write(`[secretary] 📝 Note saved: "${content.slice(0, 80)}"\n`);
  }
}

// ── NOTE DELETE ──

async function actionNoteDelete(content, db, cwd, llmAvailable) {
  const noteEntries = db.prepare(`
    SELECT id, summary FROM summaries
    WHERE project_dir IN (?, '__global__') AND session_id = 'notes' AND status = 'active'
  `).all(cwd || '');

  if (noteEntries.length === 0) return;

  const idsToDelete = await matchItemsForDeletion(content, noteEntries, 'notes', llmAvailable);

  for (const id of idsToDelete) {
    const entry = noteEntries.find(e => e.id === id);
    db.prepare('DELETE FROM summaries WHERE id = ?').run(id);
    process.stderr.write(`[secretary] 🗑️ Note deleted: "${(entry?.summary || id).toString().slice(0, 80)}"\n`);
  }
}

// ── REMINDER ──

async function actionReminder(content, db, cwd) {
  // Dedup: check if a similar reminder already exists
  const existingReminders = db.prepare(`
    SELECT summary FROM summaries
    WHERE project_dir IN (?, '__global__') AND session_id = 'reminders' AND status = 'active'
  `).all(cwd || '').map(r => r.summary.toLowerCase());

  const normalized = content.toLowerCase();
  const isDuplicate = existingReminders.some(existing =>
    existing.includes(normalized) || normalized.includes(existing.replace('[reminder] ', ''))
  );

  if (isDuplicate) return;

  const dueDate = parseDueDate(content);

  const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get('reminders');
  const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;
  db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count, due_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'reminders', cwd || '', chunkIndex, `[REMINDER] ${content}`, 0, dueDate
  );

  const dateStr = dueDate ? ` (due: ${dueDate})` : ' (no date)';
  process.stderr.write(`[secretary] ⏰ Reminder saved: "${content.slice(0, 80)}"${dateStr}\n`);
}

// ── REMINDER DONE ──

async function actionReminderDone(content, db, cwd, llmAvailable) {
  const reminderEntries = db.prepare(`
    SELECT id, summary FROM summaries
    WHERE project_dir IN (?, '__global__') AND session_id = 'reminders' AND status = 'active'
  `).all(cwd || '');

  if (reminderEntries.length === 0) return;

  const idsToUpdate = await matchItemsForDeletion(content, reminderEntries, 'reminders', llmAvailable);

  for (const id of idsToUpdate) {
    const entry = reminderEntries.find(e => e.id === id);
    db.prepare("UPDATE summaries SET status = 'done' WHERE id = ?").run(id);
    process.stderr.write(`[secretary] ✅ Reminder done: "${(entry?.summary || id).toString().slice(0, 80)}"\n`);
  }
}

// ── SHARED: LLM-based matching for deletion/completion ──

async function matchItemsForDeletion(userRequest, entries, category, llmAvailable) {
  const entriesList = entries.map(e => `[ID:${e.id}] ${e.summary}`).join('\n');

  let idsToMatch = [];

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
        idsToMatch = cleaned.split(/[,\s]+/)
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n));

        const validIds = new Set(entries.map(e => e.id));
        idsToMatch = idsToMatch.filter(id => validIds.has(id));
      }
    } catch (err) {
      process.stderr.write(`[secretary] LLM matching failed: ${err.message}, falling back to keyword match\n`);
      idsToMatch = [];
    }
  }

  // Fallback: keyword matching
  if (idsToMatch.length === 0) {
    const keyword = userRequest.toLowerCase();
    for (const entry of entries) {
      const cleanEntry = entry.summary.toLowerCase()
        .replace(/^\[(?:remember|manual|note|reminder)\]\s*/gi, '')
        .trim();
      if (cleanEntry.includes(keyword) || keyword.includes(cleanEntry)) {
        idsToMatch.push(entry.id);
      }
    }
  }

  return idsToMatch;
}

// ═══════════════════ COMMANDS ═══════════════════

async function incremental(hookInput) {
  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) return;

  const db = openDb();
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
    await processSecretaryOrders(messages, db, cwd);

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
    if (!canSpawnBgWorker(session_id)) {
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
    process.stderr.write(`[secretary] Summarization launched in background (counter=${counter})\n`);

  } finally {
    db.close();
  }
}

/**
 * Build a consolidated summary of all chunks for a project and write it
 * to the per-project cache as a dated .md. Called after every background
 * summarization so SessionStart can read the cache instead of calling the LLM.
 */
async function regenerateProjectCache(db, cwd, sessionId) {
  if (!cwd || !db) return;

  const lastSessionRow = db.prepare(`
    SELECT session_id FROM summaries
    WHERE project_dir = ? AND session_id NOT IN ('manual', 'notes', 'reminders')
    ORDER BY created_at DESC LIMIT 1
  `).get(cwd);
  const lastSessionId = lastSessionRow?.session_id || sessionId;
  if (!lastSessionId) return;

  let summaries = db.prepare(`
    SELECT summary, chunk_index, created_at, session_id FROM summaries
    WHERE session_id = ? ORDER BY chunk_index ASC
  `).all(lastSessionId);

  const MIN_CHUNKS = 10;
  if (summaries.length < MIN_CHUNKS) {
    const needed = MIN_CHUNKS - summaries.length;
    const backfill = db.prepare(`
      SELECT summary, chunk_index, created_at, session_id FROM summaries
      WHERE project_dir = ? AND session_id != ? AND session_id NOT IN ('manual', 'notes', 'reminders')
      ORDER BY created_at DESC LIMIT ?
    `).all(cwd, lastSessionId, needed);
    backfill.reverse();
    summaries = [...backfill, ...summaries];
  }

  if (summaries.length === 0) return;

  let finalSummary = '';
  if (await isLLMAvailable()) {
    const allSummaries = summaries.map((s, i) => `--- Chunk ${i + 1} (${s.created_at}) ---\n${s.summary}`).join('\n\n');
    const prompt = `Merge these ${summaries.length} incremental conversation summaries into ONE consolidated summary. This will be injected into a NEW conversation so the AI can continue where it left off.

CRITICAL PRIORITIES (in order):
1. CURRENT STATE: What task is in progress? What are the immediate next steps?
2. KEY DECISIONS: Architectural choices, design patterns chosen, constraints agreed upon
3. IMPORTANT CHANGES: Files modified with specific paths and what changed
4. UNRESOLVED PROBLEMS: Bugs, errors, or blockers still pending
5. ERROR SOLUTIONS: How specific errors were fixed (exact fix, not just "fixed it")

RULES:
- Remove duplicates and superseded information
- Most recent chunks are MORE important than older ones
- Include specific file paths, function names, variable names
- Keep it under 2000 tokens. Be specific and actionable.
- Format with clear **SECTION** headers

SUMMARIES (oldest to newest):
${allSummaries}`;

    try {
      finalSummary = await callLLM(prompt, 2000);
    } catch {
      finalSummary = summaries.map(s => s.summary).join('\n\n---\n\n');
    }
  } else {
    finalSummary = summaries.map(s => s.summary).join('\n\n---\n\n');
  }

  if (finalSummary.length > 4000) {
    if (await isLLMAvailable()) {
      try {
        const compactPrompt = `This summary is too long (${finalSummary.length} chars). Compress it to under 3500 characters while keeping all critical information.\n\nSUMMARY:\n${finalSummary}`;
        const compressed = await callLLM(compactPrompt, 1500);
        if (compressed && compressed.length >= 50) finalSummary = compressed;
      } catch { /* keep original */ }
    }
    if (finalSummary.length > 4000) {
      finalSummary = finalSummary.slice(0, 3950) + '\n\n[...truncated]';
    }
  }

  if (!finalSummary || finalSummary.length < 50) return;

  const file = writeCacheFile(cwd, finalSummary, {
    session_id: lastSessionId,
    chunks_included: summaries.length,
  });
  if (file) process.stderr.write(`[secretary] Cache written: ${file}\n`);
}

/**
 * Background summarization worker — called as a forked child process.
 * Args: _bg_summarize <session_id> <cwd> <message_count> <tmpFile>
 */
async function bgSummarize(sessionId, cwd, messageCount, tmpFile, { notify: shouldNotify = false } = {}) {
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

  const prompt = `Summarize this coding conversation segment. Extract:

- DECISIONS: What was decided and why (max 3)
- CHANGES: Files modified and how (max 5)
- PROBLEMS: Errors encountered and their solutions (max 3)
- STATE: Current task status and next steps

Be specific: include file paths, function names, error messages.
Keep each item to 1-2 sentences.

CONVERSATION:
${text}`;

  const summary = await callLLM(prompt);
  if (!summary || summary.length < 50) {
    process.exit(0);
  }

  const db = openDb();
  if (!db) process.exit(1);

  try {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get(sessionId);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      sessionId, cwd, chunkIndex, summary, parseInt(messageCount, 10)
    );

    try { await regenerateProjectCache(db, cwd, sessionId); } catch { /* cache failure must not break summarization */ }
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
    const db = openDb();
    if (db) {
      try {
        const stateKey = `offset:${session_id}`;
        const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
        const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;

        const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);

        await processSecretaryOrders(messages, db, cwd);

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

CONVERSATION:
${text}`;

            const summary = await callLLM(prompt);
            if (summary && summary.length >= 50) {
              const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get(session_id);
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

  const db2 = openDb();
  const hasSummaries = db2 ? (() => {
    try {
      const row = db2.prepare('SELECT COUNT(*) as count FROM summaries WHERE session_id = ?').get(session_id);
      return row?.count > 0;
    } finally {
      db2.close();
    }
  })() : false;

  const msg = hasSummaries
    ? `Context is about to be compacted. You have saved summaries from this session (including a fresh one just captured). Type /clear now to use local LLM summaries instead of Claude's compaction.`
    : `Context is about to be compacted. The local summarizer has no saved summaries for this session yet. Compaction will proceed with Claude's built-in summarization.`;

  process.stderr.write(msg);
  process.exit(2);
}

async function restore(hookInput) {
  const { session_id, cwd } = hookInput;

  const db = openDb();
  if (!db) {
    process.stdout.write(`⚠️ **The Secretary: No se pudo abrir la base de datos.** Ejecuta manualmente:\n\`\`\`bash\nbash ~/.claude/summarizer/start-llm.sh start\necho '{"cwd":"${cwd || ''}"}' | node ~/.claude/summarizer/summarize.mjs recall\n\`\`\`\n`);
    return;
  }

  try {
    // ── Gather all data ──
    const specialSessions = ['manual', 'notes', 'reminders'];

    const lastSessionRow = cwd
      ? db.prepare(`
          SELECT session_id FROM summaries
          WHERE project_dir = ? AND session_id NOT IN ('manual', 'notes', 'reminders')
          ORDER BY created_at DESC LIMIT 1
        `).get(cwd)
      : db.prepare(`
          SELECT session_id FROM summaries
          WHERE session_id NOT IN ('manual', 'notes', 'reminders')
          ORDER BY created_at DESC LIMIT 1
        `).get();

    const lastSessionId = lastSessionRow?.session_id;

    // Fetch all categories
    const manualEntries = cwd ? db.prepare(`
      SELECT summary, created_at FROM summaries
      WHERE project_dir IN (?, '__global__') AND session_id = 'manual' AND status = 'active'
      ORDER BY created_at ASC
    `).all(cwd) : [];

    const noteEntries = cwd ? db.prepare(`
      SELECT summary, created_at FROM summaries
      WHERE project_dir IN (?, '__global__') AND session_id = 'notes' AND status = 'active'
      ORDER BY created_at ASC
    `).all(cwd) : [];

    const today = new Date().toISOString().split('T')[0];
    const overdueReminders = cwd ? db.prepare(`
      SELECT summary, due_at FROM summaries
      WHERE project_dir IN (?, '__global__') AND session_id = 'reminders' AND status = 'active'
        AND due_at IS NOT NULL AND due_at <= ?
      ORDER BY due_at ASC
    `).all(cwd, today) : [];

    const upcomingReminders = cwd ? db.prepare(`
      SELECT summary, due_at FROM summaries
      WHERE project_dir IN (?, '__global__') AND session_id = 'reminders' AND status = 'active'
        AND (due_at IS NULL OR due_at > ?)
      ORDER BY due_at ASC
      LIMIT 10
    `).all(cwd, today) : [];

    // Get conversation summaries
    let summaries = [];
    if (lastSessionId) {
      summaries = db.prepare(`
        SELECT summary, chunk_index, created_at, session_id FROM summaries
        WHERE session_id = ? ORDER BY chunk_index ASC
      `).all(lastSessionId);

      const MIN_CHUNKS = 10;
      if (summaries.length < MIN_CHUNKS && cwd) {
        const needed = MIN_CHUNKS - summaries.length;
        const backfill = db.prepare(`
          SELECT summary, chunk_index, created_at, session_id FROM summaries
          WHERE project_dir = ? AND session_id != ? AND session_id NOT IN ('manual', 'notes', 'reminders')
          ORDER BY created_at DESC LIMIT ?
        `).all(cwd, lastSessionId, needed);
        backfill.reverse();
        summaries = [...backfill, ...summaries];
      }
    }

    const hasAnything = summaries.length > 0 || manualEntries.length > 0 || noteEntries.length > 0 || overdueReminders.length > 0 || upcomingReminders.length > 0;
    if (!hasAnything) {
      process.stderr.write('☑ Session memory: no previous context found\n');
      return;
    }

    // ── Build output ──
    let output = '';

    // 1. OVERDUE/TODAY REMINDERS (highest priority — shown first)
    if (overdueReminders.length > 0) {
      output += `## ⏰ PENDING REMINDERS\n`;
      for (const r of overdueReminders) {
        const clean = r.summary.replace(/^\[REMINDER\]\s*/i, '');
        const isToday = r.due_at === today;
        const label = isToday ? 'DUE TODAY' : `OVERDUE since ${r.due_at}`;
        output += `- **[${label}]** ${clean}\n`;
      }
      output += '\n';
    }

    // 2. Consolidated conversation summary
    //    Fast path: try to read a pre-generated cache file for this project.
    //    The cache is invalidated if any chunk in SQLite is newer than the cache.
    let finalSummary = '';
    let cacheHit = false;
    let cacheGeneratedAt = null;

    if (cwd && summaries.length > 0) {
      const cached = readLatestCacheFile(cwd);
      if (cached && cached.body && cached.body.trim().length > 50) {
        const cacheTime = cached.meta.generated_at ? Date.parse(cached.meta.generated_at) : cached.mtimeMs;
        const newestChunkTime = Math.max(...summaries.map(s => Date.parse((s.created_at || '') + 'Z') || 0));
        if (cacheTime && newestChunkTime && cacheTime >= newestChunkTime) {
          finalSummary = cached.body.trim();
          cacheHit = true;
          cacheGeneratedAt = cached.meta.generated_at || new Date(cached.mtimeMs).toISOString();
          process.stderr.write(`[secretary] Cache hit: ${cached.file}\n`);
        }
      }
    }

    if (summaries.length === 0) {
      finalSummary = '(No conversation summaries available)';
    } else if (!cacheHit) {
      // Never block SessionStart on the LLM — it can take 20s+ on small
      // machines and the hook will time out. Fall back to raw concatenation
      // of chunks (recent last) and fire a background regenerator so the
      // next session gets a proper LLM-merged cache.
      const ordered = [...summaries].sort((a, b) => (a.chunk_index || 0) - (b.chunk_index || 0));
      finalSummary = ordered.map(s => s.summary).join('\n\n---\n\n');
      if (finalSummary.length > 4000) {
        finalSummary = finalSummary.slice(-3950) + '\n\n[...older chunks truncated]';
      }

      if (cwd && lastSessionId) {
        try {
          const { spawn } = await import('child_process');
          const child = spawn('node', [
            new URL(import.meta.url).pathname, '_bg_regenerate', cwd, lastSessionId,
          ], { detached: true, stdio: 'ignore' });
          child.unref();
          process.stderr.write('[secretary] Cache regeneration spawned in background\n');
        } catch { /* best effort */ }
      }
    }

    const cacheLabel = cacheHit && cacheGeneratedAt
      ? ` _(cached ${new Date(cacheGeneratedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})_`
      : '';
    output += `## Context from Previous Conversation (auto-injected by The Secretary)${cacheLabel}\n\n${finalSummary}\n`;

    // 3. User Memories
    if (manualEntries.length > 0) {
      output += `\n## User Memories (NEVER ignore these)\n`;
      for (const e of manualEntries) {
        output += `- ${e.summary}\n`;
      }
    }

    // 4. Notes
    if (noteEntries.length > 0) {
      output += `\n## Notes\n`;
      for (const e of noteEntries) {
        const clean = e.summary.replace(/^\[NOTE\]\s*/i, '');
        const date = e.created_at ? new Date(e.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '';
        output += `- ${clean}${date ? ` _(${date})_` : ''}\n`;
      }
    }

    // 5. Upcoming Reminders
    if (upcomingReminders.length > 0) {
      output += `\n## Upcoming Reminders\n`;
      for (const r of upcomingReminders) {
        const clean = r.summary.replace(/^\[REMINDER\]\s*/i, '');
        const dateLabel = r.due_at || 'no date';
        output += `- [${dateLabel}] ${clean}\n`;
      }
    }

    // ── Final output ──
    const totalItems = summaries.length + manualEntries.length + noteEntries.length + overdueReminders.length + upcomingReminders.length;

    if (totalItems === 0) {
      process.stdout.write(`⚠️ **The Secretary: No hay contexto previo para este proyecto.** Si crees que debería haberlo, ejecuta:\n\`\`\`bash\nbash ~/.claude/summarizer/start-llm.sh start\necho '{"cwd":"${cwd || ''}"}' | node ~/.claude/summarizer/summarize.mjs recall\n\`\`\`\n`);
      return;
    }

    output += `\n---\n*${totalItems} items restored by The Secretary.*`;

    const allDates = [...summaries, ...manualEntries, ...noteEntries].map(e => e.created_at).filter(Boolean);
    const lastDate = allDates[allDates.length - 1] || 'unknown';
    const formattedDate = lastDate !== 'unknown' ? new Date(lastDate + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : lastDate;

    process.stdout.write(output + `\n\n☑ Session memory recovered from ${formattedDate} (${totalItems} items restored)`);
    notify('The Secretary', `Memory recovered from ${formattedDate} (${totalItems} items)`);

  } finally {
    db.close();
  }
}

async function force(hookInput, { stopLlm = false, notify: shouldNotify = false } = {}) {
  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) return;

  const db = openDb();
  if (!db) return;

  try {
    const stateKey = `offset:${session_id}`;
    const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
    const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;

    const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);

    await processSecretaryOrders(messages, db, cwd);

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
    if (!stopLlm && !canSpawnBgWorker(session_id)) {
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

  const db = openDb();
  if (!db) {
    process.stderr.write('[secretary] Cannot open database.\n');
    return;
  }

  try {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get(session_id);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      session_id, cwd, chunkIndex, `[MANUAL] ${text}`, 0
    );

    process.stderr.write(`[secretary] Injected manual context (chunk ${chunkIndex}).\n`);
  } finally {
    db.close();
  }
}

async function recall(hookInput, filter = 'all') {
  const cwd = hookInput.cwd || process.argv[3] || process.cwd();

  const db = openDb();
  if (!db) {
    process.stdout.write('No database available.\n');
    return;
  }

  try {
    let output = '';

    // Memories
    if (filter === 'all' || filter === 'memories') {
      const entries = db.prepare(`
        SELECT id, summary, created_at, project_dir FROM summaries
        WHERE project_dir IN (?, '__global__') AND session_id = 'manual' AND status = 'active'
        ORDER BY created_at ASC
      `).all(cwd);

      if (entries.length > 0) {
        output += `## Memorias del usuario (${entries.length})\n\n`;
        for (const e of entries) {
          const clean = e.summary.replace(/^\[(?:REMEMBER|MANUAL)\]\s*/i, '');
          const date = e.created_at ? new Date(e.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
          const globalTag = e.project_dir === '__global__' ? ' [global]' : '';
          output += `- ${clean}${date ? ` _(${date})_` : ''}${globalTag}\n`;
        }
        output += '\n';
      }
    }

    // Notes
    if (filter === 'all' || filter === 'notes') {
      const entries = db.prepare(`
        SELECT id, summary, created_at, project_dir FROM summaries
        WHERE project_dir IN (?, '__global__') AND session_id = 'notes' AND status = 'active'
        ORDER BY created_at ASC
      `).all(cwd);

      if (entries.length > 0) {
        output += `## Notas (${entries.length})\n\n`;
        for (const e of entries) {
          const clean = e.summary.replace(/^\[NOTE\]\s*/i, '');
          const date = e.created_at ? new Date(e.created_at + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
          const globalTag = e.project_dir === '__global__' ? ' [global]' : '';
          output += `- ${clean}${date ? ` _(${date})_` : ''}${globalTag}\n`;
        }
        output += '\n';
      }
    }

    // Reminders
    if (filter === 'all' || filter === 'reminders') {
      const active = db.prepare(`
        SELECT id, summary, due_at, created_at FROM summaries
        WHERE project_dir IN (?, '__global__') AND session_id = 'reminders' AND status = 'active'
        ORDER BY due_at ASC, created_at ASC
      `).all(cwd);

      const done = db.prepare(`
        SELECT id, summary, due_at, created_at FROM summaries
        WHERE project_dir IN (?, '__global__') AND session_id = 'reminders' AND status = 'done'
        ORDER BY created_at DESC LIMIT 10
      `).all(cwd);

      if (active.length > 0) {
        const today = new Date().toISOString().split('T')[0];
        output += `## Recordatorios activos (${active.length})\n\n`;
        for (const r of active) {
          const clean = r.summary.replace(/^\[REMINDER\]\s*/i, '');
          const isOverdue = r.due_at && r.due_at <= today;
          const prefix = isOverdue ? '**[OVERDUE]** ' : r.due_at ? `[${r.due_at}] ` : '[sin fecha] ';
          output += `- ${prefix}${clean}\n`;
        }
        output += '\n';
      }

      if (done.length > 0) {
        output += `## Recordatorios completados (últimos ${done.length})\n\n`;
        for (const r of done) {
          const clean = r.summary.replace(/^\[REMINDER\]\s*/i, '');
          output += `- ~~${clean}~~\n`;
        }
        output += '\n';
      }
    }

    // Context summaries (only in 'all' mode)
    if (filter === 'all') {
      const lastSessionRow = db.prepare(`
        SELECT session_id FROM summaries
        WHERE project_dir = ? AND session_id NOT IN ('manual', 'notes', 'reminders')
        ORDER BY created_at DESC LIMIT 1
      `).get(cwd);

      if (lastSessionRow) {
        const summaries = db.prepare(`
          SELECT summary, created_at FROM summaries
          WHERE session_id = ? ORDER BY chunk_index ASC
        `).all(lastSessionRow.session_id);

        if (summaries.length > 0) {
          output += `## Contexto de conversaciones anteriores (${summaries.length} chunks)\n\n`;

          if (await isLLMAvailable()) {
            const allSummaries = summaries.map((s, i) => `--- Chunk ${i + 1} (${s.created_at}) ---\n${s.summary}`).join('\n\n');
            try {
              const prompt = `Merge these ${summaries.length} conversation summaries into ONE readable summary in Spanish. Be concise but include key decisions, files changed, and current state. Use markdown formatting.\n\nSUMMARIES:\n${allSummaries}`;
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
  return RECALL_TRIGGERS.some((rx) => rx.test(prompt));
}

/**
 * Search for `query` across cache .md files (fast) and DB summaries (fallback).
 * Returns an array of hits: { source, project, date, snippet }.
 */
async function searchContext(query, { maxHits = 5, snippetChars = 400 } = {}) {
  const q = (query || '').trim();
  if (q.length < 3) return [];

  const terms = q.split(/\s+/).filter((t) => t.length >= 3).slice(0, 5);
  if (terms.length === 0) return [];

  const hits = [];

  // ── 1. Cache .md files ──
  try {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const projectDirs = readdirSync(CACHE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const proj of projectDirs) {
      const projPath = join(CACHE_DIR, proj);
      let files = [];
      try {
        files = readdirSync(projPath).filter((f) => f.endsWith('.md'));
      } catch { continue; }

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
          project: proj,
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

  if (hits.length >= maxHits) return hits.slice(0, maxHits);

  // ── 2. DB fallback (summaries table) ──
  try {
    const db = openDb();
    if (db) {
      try {
        const likeClauses = terms.map(() => 'summary LIKE ?').join(' AND ');
        const params = terms.map((t) => `%${t}%`);
        const rows = db.prepare(`
          SELECT project_dir, summary, created_at
          FROM summaries
          WHERE session_id NOT IN ('manual', 'notes', 'reminders')
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
  if (!isRecallQuery(prompt)) return;

  const query = extractSearchQuery(prompt);
  if (query.length < 3) return;

  const hits = await searchContext(query, { maxHits: 5, snippetChars: 500 });
  if (hits.length === 0) return;

  process.stdout.write(`## 🧠 The Secretary: contexto encontrado para "${query}"\n\n`);
  process.stdout.write(`_(${hits.length} coincidencia${hits.length > 1 ? 's' : ''} en sesiones previas — usa esto para responder antes de buscar más)_\n\n`);
  for (const h of hits) {
    process.stdout.write(`### [${h.source}] ${h.project} · ${h.date}\n\n${h.snippet}\n\n---\n\n`);
  }
}

// ═══════════════════ MAIN ═══════════════════

async function main() {
  const command = process.argv[2];

  // Background summarization worker (forked child process)
  if (command === '_bg_summarize') {
    const [, , , sessionId, cwd, messageCount, tmpFile, ...flags] = process.argv;
    try {
      await bgSummarize(sessionId, cwd, messageCount, tmpFile, { notify: flags.includes('--notify') });
    } catch (err) {
      process.stderr.write(`[secretary-bg] ${err.message}\n`);
    }
    // Release lock so the next incremental() can spawn
    clearBgWorker(sessionId);
    // If called with --stop-llm, shut down the LLM server after summarizing
    if (flags.includes('--stop-llm')) {
      try {
        execSync('bash ~/.claude/summarizer/start-llm.sh stop > /dev/null 2>&1');
      } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // Background cache regenerator — rebuilds the consolidated project cache
  // so the next SessionStart gets an LLM-quality summary without blocking.
  if (command === '_bg_regenerate') {
    const [, , , cwd, sessionId] = process.argv;
    try {
      if (!(await ensureLLMRunning())) process.exit(0);
      const db = openDb();
      if (!db) process.exit(0);
      try {
        await regenerateProjectCache(db, cwd, sessionId);
      } finally {
        db.close();
      }
    } catch (err) {
      process.stderr.write(`[secretary-bg-regen] ${err.message}\n`);
    }
    process.exit(0);
  }

  // Background deletion worker (forked child process for FORGET/NOTE_DELETE/REMINDER_DONE)
  if (command === '_bg_delete') {
    const [, , , cwd, actionsJson] = process.argv;
    try {
      const actions = JSON.parse(actionsJson);
      const db = openDb();
      if (!db) process.exit(1);
      try {
        const llmAvailable = await isLLMAvailable();
        for (const { intent, content } of actions) {
          switch (intent) {
            case 'FORGET':
              await actionForget(content, db, cwd, llmAvailable);
              break;
            case 'NOTE_DELETE':
              await actionNoteDelete(content, db, cwd, llmAvailable);
              break;
            case 'REMINDER_DONE':
              await actionReminderDone(content, db, cwd, llmAvailable);
              break;
          }
        }
      } finally {
        db.close();
      }
    } catch (err) {
      process.stderr.write(`[secretary-bg] delete error: ${err.message}\n`);
    }
    process.exit(0);
  }

  const validCommands = ['incremental', 'compact', 'restore', 'force', 'inject', 'recall', 'recall-notes', 'recall-reminders', 'search', 'user-prompt'];

  if (command === 'search') {
    await cmdSearch();
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
    process.stderr.write('  recall            Show all: memories, notes, reminders, context\n');
    process.stderr.write('  recall-notes      Show only notes\n');
    process.stderr.write('  recall-reminders  Show only reminders\n');
    process.stderr.write('  search <query>    Search cache + DB for a query\n');
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
      case 'recall': await recall(hookInput, 'all'); break;
      case 'recall-notes': await recall(hookInput, 'notes'); break;
      case 'recall-reminders': await recall(hookInput, 'reminders'); break;
      case 'user-prompt': await userPromptHook(hookInput); break;
    }
  } catch (err) {
    process.stderr.write(`[secretary] ${err.message}\n`);
  }
}

main();
