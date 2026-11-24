#!/usr/bin/env node
// CodeIndex Stop hook: the structure lint after a piece of work, not after every edit.
//
// Fires when Claude finishes a turn. If that turn edited files (Edit / Write / MultiEdit /
// NotebookEdit since the user's last prompt), it runs `lint --new`: only the structural
// problems the previous whole-project lint did not have. When there are some, it hands
// them back to Claude (decision "block") so they are fixed or reported before the turn
// ends; the lint has already remembered them, so the same problem is never raised twice.
// A turn without edits costs nothing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TIMEOUT_MS = 60000;
const engine = join(dirname(fileURLToPath(import.meta.url)), 'codeindex.mjs');

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }

// (did the turn since the user's last prompt edit a file? Walks the transcript backwards
// until an entry the user typed — one that is not only tool results)
function turnEdited(transcriptPath) {
  let entries;
  try { entries = readFileSync(transcriptPath, 'utf-8').split('\n'); } catch { return false; }
  for (let i = entries.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(entries[i]); } catch { continue; }
    const content = e.message?.content;
    if (e.type === 'user') {
      if (typeof content === 'string' || (Array.isArray(content) && content.some((c) => c.type !== 'tool_result'))) return false;
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      if (content.some((c) => c.type === 'tool_use' && EDIT_TOOLS.has(c.name))) return true;
    }
  }
  return false;
}

if (!input.transcript_path || !turnEdited(input.transcript_path)) process.exit(0);

let out = '';
try {
  out = execFileSync(process.execPath, ['--no-warnings', engine, 'lint', '--new'], {
    cwd: input.cwd || process.cwd(), encoding: 'utf-8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) {
  out = e.stdout || ''; // exit 1 = problems found; a timeout or crash leaves nothing to say
}
if (!out.trim()) process.exit(0);

console.log(JSON.stringify({
  decision: 'block',
  reason: `CodeIndex lint — structural problems that are new since the last lint:\n${out.trim()}\n\n` +
    'If this turn\'s change introduced them, fix them now from first principles (code-index skill, "Lint" section). ' +
    'Otherwise tell the user in one line. They will not be raised again.',
}));
