#!/usr/bin/env node
// CodeIndex Stop hook: the structure lint after a piece of work, not after every edit.
//
// Fires when Claude finishes a turn. If that turn edited files (Edit / Write / MultiEdit /
// NotebookEdit since the user's last prompt), it starts `lint --new` with the rules that
// almost never cry wolf (HOOK_RULES) in the background, so the turn ends at once. The
// worker (this same file with `--worker <cwd>`) writes the problems new or worse than the
// last lint to a report file; the next Stop in that project hands them to Claude (decision
// "block") so they are fixed or reported. The lint has already remembered them, so the same
// problem is raised again only if it grows. field-leak, shallow-module and hidden-modules
// are judgment calls: they run at session start and on demand, not here. A turn without
// edits, with no report waiting, costs nothing.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TIMEOUT_MS = 120000;
const HOOK_RULES = ['module-cycle', 'tangle'];
const self = fileURLToPath(import.meta.url);
const engine = join(dirname(self), 'codeindex.mjs');

// (the report and running-worker files of one project, keyed by its directory)
function lintFiles(cwd) {
  const base = join(tmpdir(), `codeindex-lint-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`);
  return { report: `${base}.txt`, running: `${base}.pid` };
}

// (is the process that wrote this pid file still alive?)
function workerAlive(pidFile) {
  try { process.kill(Number(readFileSync(pidFile, 'utf-8')), 0); return true; } catch { return false; }
}

if (process.argv[2] === '--worker') {
  const cwd = process.argv[3];
  const { report, running } = lintFiles(cwd);
  writeFileSync(running, String(process.pid));
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--no-warnings', engine, 'lint', '--new', ...HOOK_RULES], {
      cwd, encoding: 'utf-8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    out = e.stdout || ''; // exit 1 = problems found; a timeout or crash leaves nothing to say
  }
  if (out.trim()) {
    // (appended to a report not yet delivered; renamed into place so a reader never sees half)
    const previous = existsSync(report) ? readFileSync(report, 'utf-8') : '';
    writeFileSync(`${report}.tmp`, previous + out);
    renameSync(`${report}.tmp`, report);
  }
  try { unlinkSync(running); } catch {}
  process.exit(0);
}

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

const cwd = input.cwd || process.cwd();
const { report, running } = lintFiles(cwd);

if (input.transcript_path && turnEdited(input.transcript_path) && !workerAlive(running)) {
  spawn(process.execPath, ['--no-warnings', self, '--worker', cwd], { detached: true, stdio: 'ignore' }).unref();
}

let out = '';
try { out = readFileSync(report, 'utf-8'); unlinkSync(report); } catch {}
if (!out.trim()) process.exit(0);

console.log(JSON.stringify({
  decision: 'block',
  reason: `CodeIndex lint (ran in the background after an earlier turn) — structural problems that are new or worse since the last lint:\n${out.trim()}\n\n` +
    'If a recent change introduced them, fix them now from first principles (code-index skill, "Lint" section). ' +
    'Otherwise tell the user in one line. They are raised again only if they get worse.',
}));
