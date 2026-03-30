#!/usr/bin/env node

/**
 * Context Summarizer for Claude Code
 *
 * Uses a local LLM (llama-server) to incrementally summarize conversations
 * and inject compressed context when /clear is used or compaction happens.
 *
 * Commands:
 *   incremental  - Summarize new conversation since last checkpoint (PostToolUse hook)
 *   compact      - Warn user that compaction is about to happen (PreCompact hook)
 *   restore      - Inject saved summaries after /clear (SessionStart:clear hook)
 *   force        - Force an immediate summary regardless of counter/threshold (Stop hook or manual)
 *   inject       - Inject arbitrary text as a summary entry (manual use)
 *
 * Reads hook JSON from stdin.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
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

// ═══════════════════ DATABASE ═══════════════════

let Database;
try {
  // Try better-sqlite3 from various locations
  const require = createRequire(import.meta.url);
  try {
    Database = require('better-sqlite3');
  } catch {
    // Try from the summarizer install directory
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
      model: config.model,
      messages: [
        { role: 'system', content: 'You are a precise technical summarizer. Output concise structured summaries.' },
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
      headers: { 'Content-Type': 'application/json' },
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
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function ensureLLMRunning() {
  if (await isLLMAvailable()) return true;
  // Try to start the LLM server
  const startScript = join(SUMMARIZER_DIR, 'start-llm.sh');
  if (!existsSync(startScript)) return false;
  try {
    execSync(`bash "${startScript}" start`, { timeout: 30000, stdio: 'ignore' });
    return await isLLMAvailable();
  } catch {
    return false;
  }
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
      // Claude Code transcript format: { type, message: { role, content } }
      const msg = entry.message || entry;
      const role = msg.role || entry.type;

      if (!role) continue;

      // Extract text content
      const content = msg.content;
      let text = '';

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // Handle content blocks: text, tool_use, tool_result
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

      // Also check toolUseResult for tool output entries
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

// ═══════════════════ COMMANDS ═══════════════════

async function incremental(hookInput) {
  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) return;

  const db = openDb();
  if (!db) return;

  try {
    // Get last offset for this session
    const stateKey = `offset:${session_id}`;
    const counterKey = `counter:${session_id}`;

    const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
    const counterRow = db.prepare('SELECT value FROM state WHERE key = ?').get(counterKey);

    const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;
    const counter = counterRow ? parseInt(counterRow.value, 10) + 1 : 1;

    // Update counter
    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(counterKey, String(counter));

    // Only summarize every N tool calls
    if (counter % config.summarize_every_n !== 0) return;

    // Ensure LLM is running (auto-start if needed)
    if (!(await ensureLLMRunning())) return;

    // Parse new messages
    const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);
    const text = messagesToText(messages);

    if (text.length < config.min_new_chars) return;

    // Summarize
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
    if (!summary || summary.length < 50) return;

    // Get chunk index
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get(session_id);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    // Save
    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      session_id, cwd || '', chunkIndex, summary, messages.length
    );

    // Update offset
    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(stateKey, String(rawLength));

  } finally {
    db.close();
  }
}

async function compact(hookInput) {
  // PreCompact hook: force a final summary, then warn user and suggest /clear
  const { session_id, transcript_path, cwd } = hookInput;

  // Force one last incremental summary before blocking compaction
  // This captures everything since the last periodic summary
  if (session_id && transcript_path) {
    const db = openDb();
    if (db) {
      try {
        const stateKey = `offset:${session_id}`;
        const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
        const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;

        const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);
        const text = messagesToText(messages);

        // Only summarize if there's meaningful new content (lower threshold than periodic)
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

              process.stderr.write('[summarizer] Final pre-compaction summary saved.\n');
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[summarizer] Pre-compaction summary failed: ${err.message}\n`);
      } finally {
        db.close();
      }
    }
  }

  // Now check if we have summaries (including the one we just saved)
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
  // Exit 2 to block compaction and show message to user
  process.exit(2);
}

async function restore(hookInput) {
  // SessionStart:clear hook: inject saved summaries
  const { session_id, cwd } = hookInput;

  const db = openDb();
  if (!db) return;

  try {
    // Find summaries from the most recent session for this project
    // First try current session, then fall back to most recent
    let summaries = db.prepare(`
      SELECT summary, chunk_index, created_at
      FROM summaries
      WHERE session_id = ?
      ORDER BY chunk_index ASC
    `).all(session_id);

    // If no summaries for this session, get from most recent session in this project
    if (summaries.length === 0 && cwd) {
      summaries = db.prepare(`
        SELECT summary, chunk_index, created_at
        FROM summaries
        WHERE project_dir = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).all(cwd);
      summaries.reverse(); // chronological order
    }

    if (summaries.length === 0) {
      process.stderr.write('☑ Summarizer activated (no previous context)\n');
      return;
    }

    // If LLM is available and we have multiple chunks, consolidate
    let finalSummary;
    if (summaries.length > 2 && await isLLMAvailable()) {
      const allSummaries = summaries.map((s, i) => `--- Chunk ${i + 1} (${s.created_at}) ---\n${s.summary}`).join('\n\n');

      const prompt = `Merge these incremental conversation summaries into one consolidated summary. Remove duplicates. Prioritize:
- Decisions that affect future work
- Error solutions (exact fix, not just "fixed it")
- Current task state and next steps
- File paths and changes made

Keep it under 2000 tokens. Be specific and actionable.

SUMMARIES:
${allSummaries}`;

      try {
        finalSummary = await callLLM(prompt, 2000);
      } catch {
        // Fallback: concatenate
        finalSummary = summaries.map(s => s.summary).join('\n\n---\n\n');
      }
    } else {
      finalSummary = summaries.map(s => s.summary).join('\n\n---\n\n');
    }

    // Output to stdout - this gets injected as context after /clear
    const output = `## Context from Previous Conversation (auto-injected by local summarizer)

The following is a summary of the conversation before /clear was used. This was generated by a local LLM to preserve context:

${finalSummary}

---
*${summaries.length} conversation chunks summarized. Use the project's memory system for persistent facts.*`;

    process.stdout.write(output);
    process.stderr.write(`☑ Summarizer activated (${summaries.length} chunks restored)\n`);

  } finally {
    db.close();
  }
}

async function force(hookInput) {
  // Force an immediate summary, ignoring counter and min_new_chars threshold
  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) return;

  const db = openDb();
  if (!db) return;

  try {
    if (!(await ensureLLMRunning())) {
      process.stderr.write('[summarizer] LLM not available, cannot force summary.\n');
      return;
    }

    const stateKey = `offset:${session_id}`;
    const stateRow = db.prepare('SELECT value FROM state WHERE key = ?').get(stateKey);
    const lastOffset = stateRow ? parseInt(stateRow.value, 10) : 0;

    const { messages, rawLength } = parseTranscript(transcript_path, lastOffset);
    const text = messagesToText(messages);

    if (text.length < 100) {
      process.stderr.write('[summarizer] Not enough new content to summarize.\n');
      return;
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
      process.stderr.write('[summarizer] LLM returned insufficient summary.\n');
      return;
    }

    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get(session_id);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      session_id, cwd || '', chunkIndex, summary, messages.length
    );
    db.prepare(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(stateKey, String(rawLength));

    process.stderr.write(`[summarizer] Forced summary saved (chunk ${chunkIndex}, ${messages.length} messages).\n`);
  } finally {
    db.close();
  }
}

async function inject(hookInput) {
  // Inject arbitrary text as a summary entry
  // Text comes from: --text "..." argument, or stdin if no hookInput
  const session_id = hookInput.session_id || 'manual';
  const cwd = hookInput.cwd || process.cwd();

  // Get text from --text argument or from the remaining args
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
    process.stderr.write('[summarizer] Cannot open database.\n');
    return;
  }

  try {
    const chunkRow = db.prepare('SELECT MAX(chunk_index) as max_idx FROM summaries WHERE session_id = ?').get(session_id);
    const chunkIndex = (chunkRow?.max_idx ?? -1) + 1;

    db.prepare('INSERT INTO summaries (session_id, project_dir, chunk_index, summary, message_count) VALUES (?, ?, ?, ?, ?)').run(
      session_id, cwd, chunkIndex, `[MANUAL] ${text}`, 0
    );

    process.stderr.write(`[summarizer] Injected manual context (chunk ${chunkIndex}).\n`);
  } finally {
    db.close();
  }
}

// ═══════════════════ MAIN ═══════════════════

async function main() {
  const command = process.argv[2];
  if (!command || !['incremental', 'compact', 'restore', 'force', 'inject'].includes(command)) {
    process.stderr.write('Usage: summarize.mjs <incremental|compact|restore|force|inject>\n');
    process.stderr.write('  incremental  Periodic summary (PostToolUse hook)\n');
    process.stderr.write('  compact      Pre-compaction summary + warning (PreCompact hook)\n');
    process.stderr.write('  restore      Inject summaries into new session (SessionStart hook)\n');
    process.stderr.write('  force        Force immediate summary (Stop hook or manual)\n');
    process.stderr.write('  inject       Inject manual text: --text "your context"\n');
    process.exit(1);
  }

  // Read hook input from stdin
  let hookInput = {};
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) hookInput = JSON.parse(raw);
  } catch { /* no stdin or invalid JSON — ok for manual testing */ }

  try {
    switch (command) {
      case 'incremental': await incremental(hookInput); break;
      case 'compact': await compact(hookInput); break;
      case 'restore': await restore(hookInput); break;
      case 'force': await force(hookInput); break;
      case 'inject': await inject(hookInput); break;
    }
  } catch (err) {
    // Silent failure — never break Claude Code
    process.stderr.write(`[summarizer] ${err.message}\n`);
  }
}

main();
