#!/usr/bin/env node
// CodeIndex SessionStart hook.
//
// Fires when a Claude Code session starts. Runs an incremental reindex of the current
// project and prints a one-line summary to stdout (surfaced to Claude as session context).
//
// The reindex runs as a detached child writing to a log file, never killed by this hook:
// the index commits in one transaction, so killing a slow run threw all its work away and
// every session start repeated it. The hook waits up to WAIT_MS; a longer run finishes in
// the background and the session starts without it.

import { spawn } from 'node:child_process';
import { openSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const WAIT_MS = 5000;
const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, 'codeindex.mjs');
const key = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
const logPath = join(tmpdir(), `codeindex-${key}.log`);
const fd = openSync(logPath, 'w');

const child = spawn(process.execPath, [engine, 'index', '-v'], {
  cwd: process.cwd(),
  detached: true,
  stdio: ['ignore', fd, fd],
});

let timer;
const exited = new Promise((resolve) => child.on('exit', () => resolve(true)));
const done = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r(false), WAIT_MS); })]);
clearTimeout(timer);

if (!done) {
  child.unref();
  console.log(`🔎 CodeIndex: reindexing in the background (log: ${logPath}); results may be stale until it finishes.`);
  process.exit(0);
}

const out = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
const lines = out.split('\n');
const summary = lines.find((l) => l.includes('[CodeIndex]'));
// Per-file detail lines emitted by `index -v`: "  + path (N symbols)", "  ~ …", "  - …".
const detail = lines.filter((l) => /^\s+[+~-]\s/.test(l));
if (summary) {
  console.log(`🔎 ${summary.replace('[CodeIndex] ', 'CodeIndex: ')}`);
  // Show what changed, capped so a big reindex doesn't flood session start.
  const MAX = 20;
  for (const l of detail.slice(0, MAX)) console.log(`  ${l.trim()}`);
  if (detail.length > MAX) console.log(`   … and ${detail.length - MAX} more`);
  console.log('   Query symbols fast: node ~/.claude/codeindex/codeindex.mjs where <Name>  (also: refs, file, grep, stats)');
} else if (/universal-ctags not found/.test(out)) {
  // Most common failure: universal-ctags not installed. Don't break the session.
  console.log('🔎 CodeIndex: universal-ctags not installed — run `brew install universal-ctags` to enable the symbol index.');
} else {
  const msg = lines.find((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l));
  if (msg) console.log(`🔎 CodeIndex: skipped (${msg.trim()})`);
}
