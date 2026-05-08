#!/usr/bin/env node
/**
 * safe-edit — replacement for `sed -i` and friends.
 *
 * Literal string replacement by default. Regex is opt-in. Dry-run by default;
 * --apply must be passed explicitly to write. Always backs up modified files
 * to a timestamped batch directory under .safe-edit-backups/ at the project
 * root, then prunes old batches by age and count.
 *
 * Usage:
 *   safe-edit replace --find "FOO" --with "BAR" --files "src/**\/*.ts"
 *   safe-edit replace --regex --find "v\\d+" --with "vNEXT" --files "**\/*.md"
 *   safe-edit replace --find "x" --with "y" --files "a.txt" --apply
 *
 * Flags:
 *   --find <str>          required. Pattern to search for.
 *   --with <str>          required. Replacement (use $1, $2 in regex mode).
 *   --files <glob>        required. One or more globs (repeatable).
 *   --regex               treat --find as a JS regex (default: literal).
 *   --flags <str>         regex flags (default: "g"). Ignored without --regex.
 *   --apply               actually write changes (default is dry-run).
 *   --no-backup           skip backups (only with --apply).
 *   --keep-days <n>       prune batches older than n days (default: 7, 0=off).
 *   --keep-batches <n>    keep at most n batches (default: 20, 0=off).
 *   --root <dir>          project root for backups (default: cwd).
 *   --quiet               suppress per-file headers; only show summary.
 *
 * Exit codes: 0 = success (or no matches), 1 = usage/IO error.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync, existsSync, copyFileSync } from 'fs';
import { join, dirname, relative, resolve, sep } from 'path';
import { glob } from 'glob';

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

if (cmd !== 'replace') {
  process.stderr.write(`safe-edit: unknown command "${cmd}". Try --help.\n`);
  process.exit(1);
}

const opts = parseFlags(args.slice(1));

if (!opts.find) fail('--find is required');
if (opts.with === undefined) fail('--with is required (use --with "" for empty)');
if (opts.files.length === 0) fail('--files is required (one or more globs)');

const root = resolve(opts.root || process.cwd());
const apply = !!opts.apply;
const useBackup = apply && !opts.noBackup;
const keepDays = opts.keepDays ?? parseInt(process.env.SAFE_EDIT_KEEP_DAYS ?? '7', 10);
const keepBatches = opts.keepBatches ?? parseInt(process.env.SAFE_EDIT_KEEP_BATCHES ?? '20', 10);

const matcher = opts.regex
  ? new RegExp(opts.find, opts.flags ?? 'g')
  : null;

const files = await resolveFiles(opts.files, root);
if (files.length === 0) {
  process.stderr.write('safe-edit: no files matched the given globs\n');
  process.exit(0);
}

let batchDir = null;
if (useBackup) {
  pruneBackups(root, keepDays, keepBatches);
  batchDir = join(root, '.safe-edit-backups', timestamp());
}

let changedFiles = 0;
let totalReplacements = 0;

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  const { next, count } = doReplace(original, opts.find, opts.with, matcher);
  if (count === 0) continue;

  changedFiles++;
  totalReplacements += count;

  if (!opts.quiet) {
    const rel = relative(root, file) || file;
    process.stdout.write(`\n── ${rel}  (${count} replacement${count === 1 ? '' : 's'})\n`);
    process.stdout.write(unifiedDiff(original, next, rel));
  }

  if (apply) {
    if (useBackup) {
      const dest = join(batchDir, relative(root, file));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(file, dest);
    }
    writeFileSync(file, next, 'utf8');
  }
}

const verb = apply ? 'changed' : 'would change';
const tail = apply
  ? (useBackup && batchDir && changedFiles > 0
      ? ` · backups: ${relative(root, batchDir) || batchDir}`
      : (changedFiles > 0 ? ' · no backup (--no-backup)' : ''))
  : ' · re-run with --apply to write';
process.stdout.write(`\n${verb} ${changedFiles} file${changedFiles === 1 ? '' : 's'} (${totalReplacements} replacement${totalReplacements === 1 ? '' : 's'})${tail}\n`);

// ─────────────────────────────────────────────────────────────────

function parseFlags(rest) {
  const o = { files: [], find: undefined, with: undefined, regex: false, flags: undefined, apply: false, noBackup: false, keepDays: undefined, keepBatches: undefined, root: undefined, quiet: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    switch (a) {
      case '--find': o.find = next(); break;
      case '--with': o.with = next(); break;
      case '--files': o.files.push(next()); break;
      case '--regex': o.regex = true; break;
      case '--flags': o.flags = next(); break;
      case '--apply': o.apply = true; break;
      case '--no-backup': o.noBackup = true; break;
      case '--keep-days': o.keepDays = parseInt(next(), 10); break;
      case '--keep-batches': o.keepBatches = parseInt(next(), 10); break;
      case '--root': o.root = next(); break;
      case '--quiet': o.quiet = true; break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default: fail(`unknown flag: ${a}`);
    }
  }
  return o;
}

async function resolveFiles(globs, root) {
  const out = new Set();
  for (const g of globs) {
    const matches = await glob(g, { cwd: root, absolute: true, nodir: true, dot: false });
    for (const m of matches) out.add(m);
  }
  return [...out].sort();
}

function doReplace(input, find, replacement, matcher) {
  if (matcher) {
    let count = 0;
    const next = input.replace(matcher, (...m) => { count++; return applyBackrefs(replacement, m); });
    return { next, count };
  }
  if (find.length === 0) return { next: input, count: 0 };
  let count = 0;
  let i = 0;
  let out = '';
  while (i < input.length) {
    const idx = input.indexOf(find, i);
    if (idx === -1) { out += input.slice(i); break; }
    out += input.slice(i, idx) + replacement;
    i = idx + find.length;
    count++;
  }
  return { next: out, count };
}

function applyBackrefs(template, matchArgs) {
  return template.replace(/\$(\d+|&)/g, (_, k) => {
    if (k === '&') return matchArgs[0];
    const n = parseInt(k, 10);
    return matchArgs[n] !== undefined ? matchArgs[n] : '';
  });
}

function unifiedDiff(a, b, label) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const lcs = lcsTable(al, bl);
  const ops = backtrack(lcs, al, bl, al.length, bl.length, []);
  const hunks = groupHunks(ops, 3);
  if (hunks.length === 0) return '';
  let out = '';
  for (const h of hunks) {
    out += `@@ -${h.aStart + 1},${h.aLen} +${h.bStart + 1},${h.bLen} @@\n`;
    for (const line of h.lines) out += line + '\n';
  }
  return out;
}

function lcsTable(a, b) {
  const m = a.length, n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
    }
  }
  return t;
}

function backtrack(t, a, b, i, j, acc) {
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { acc.push({ tag: '=', a: i - 1, b: j - 1, line: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || t[i][j - 1] >= t[i - 1][j])) { acc.push({ tag: '+', a: i, b: j - 1, line: b[j - 1] }); j--; }
    else { acc.push({ tag: '-', a: i - 1, b: j, line: a[i - 1] }); i--; }
  }
  return acc.reverse();
}

function groupHunks(ops, ctx) {
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].tag === '=') { i++; continue; }
    let start = Math.max(0, i - ctx);
    let end = i;
    while (end < ops.length) {
      if (ops[end].tag !== '=') { end++; continue; }
      let run = 0;
      while (end + run < ops.length && ops[end + run].tag === '=') run++;
      if (run > ctx * 2 || end + run === ops.length) { end += Math.min(ctx, run); break; }
      end += run;
    }
    const slice = ops.slice(start, end);
    const aStart = slice.find(o => o.a !== undefined)?.a ?? 0;
    const bStart = slice.find(o => o.b !== undefined)?.b ?? 0;
    let aLen = 0, bLen = 0;
    const lines = [];
    for (const op of slice) {
      if (op.tag === '=') { lines.push(' ' + op.line); aLen++; bLen++; }
      else if (op.tag === '-') { lines.push('-' + op.line); aLen++; }
      else { lines.push('+' + op.line); bLen++; }
    }
    hunks.push({ aStart, bStart, aLen, bLen, lines });
    i = end;
  }
  return hunks;
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pruneBackups(root, days, batches) {
  const dir = join(root, '.safe-edit-backups');
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: join(dir, e.name), mtime: statSync(join(dir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return; }

  const now = Date.now();
  const cutoff = days > 0 ? now - days * 86400_000 : -Infinity;
  const toDelete = new Set();

  if (days > 0) {
    for (const e of entries) if (e.mtime < cutoff) toDelete.add(e.path);
  }
  if (batches > 0 && entries.length > batches) {
    for (const e of entries.slice(batches)) toDelete.add(e.path);
  }
  for (const p of toDelete) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function fail(msg) {
  process.stderr.write(`safe-edit: ${msg}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write(`safe-edit — safer replacement for sed -i / perl -i / awk -i inplace

USAGE
  safe-edit replace --find <str> --with <str> --files <glob> [...] [flags]

FLAGS
  --find <str>         required. Pattern to search for.
  --with <str>         required. Replacement (\\$1, \\$2, \\$& in regex mode).
  --files <glob>       required. Repeatable.
  --regex              treat --find as a JS regex (default: literal).
  --flags <str>        regex flags (default: "g").
  --apply              actually write changes (default: dry-run with diff).
  --no-backup          skip backups when applying.
  --keep-days <n>      prune backup batches older than n days (default: 7, 0=off).
  --keep-batches <n>   keep at most n backup batches (default: 20, 0=off).
  --root <dir>         project root for backup location (default: cwd).
  --quiet              only print the summary line.
  -h, --help           show this help.

ENV
  SAFE_EDIT_KEEP_DAYS, SAFE_EDIT_KEEP_BATCHES   override defaults.

EXAMPLES
  # Preview a literal rename across TS files
  safe-edit replace --find "OldName" --with "NewName" --files "src/**/*.ts"

  # Apply a regex with backrefs
  safe-edit replace --regex --find "v(\\d+)" --with "v\\$1.0" --files "**/*.md" --apply

  # Multiple globs, no backup
  safe-edit replace --find "x" --with "y" --files "a/*.js" --files "b/*.js" --apply --no-backup
`);
}
