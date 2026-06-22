#!/usr/bin/env node
// CodeIndex SessionStart hook.
//
// Fires when a Claude Code session starts. Runs an incremental reindex of the current
// project so the symbol DB is fresh before Claude does any work, then prints a one-line
// summary to stdout (surfaced to Claude as session context).
//
// Designed to be cheap and non-blocking-on-failure: if universal-ctags is missing or the
// project is huge, it degrades gracefully and never aborts the session.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, 'codeindex.mjs');

try {
  const out = execFileSync(process.execPath, [engine, 'index', '-v'], {
    encoding: 'utf-8',
    cwd: process.cwd(),
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  }
} catch (e) {
  // Most common cause: universal-ctags not installed. Don't break the session.
  const msg = (e.stderr || e.message || '').toString().split('\n')[0];
  if (/universal-ctags not found/.test(e.stderr || '')) {
    console.log('🔎 CodeIndex: universal-ctags not installed — run `brew install universal-ctags` to enable the symbol index.');
  } else if (msg) {
    console.log(`🔎 CodeIndex: skipped (${msg})`);
  }
}
