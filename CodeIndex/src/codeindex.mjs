#!/usr/bin/env node
// CodeIndex — incremental symbol index for a codebase, backed by SQLite + universal-ctags.
//
// Purpose: give Claude a fast shortcut to "where is symbol X?" and "what references it?"
// without reading thousands of files. The index is per-project (scoped to the git root or
// cwd), updated incrementally (only files whose content hash changed), and queried in ms.
//
// Storage: <project-root>/.claude/codeindex.db  (SQLite, via the built-in node:sqlite module).
//
// Commands:
//   index            Incremental reindex: rescan changed/added/removed files only.
//   index --full     Drop everything and reindex from scratch.
//   index -v         Verbose: list each added/changed/removed file as it's indexed.
//   where <name>     Print definitions of a symbol  ->  file:line  signature  (kind) + doc.
//   refs <name>      Print every line that mentions a symbol (definitions + plain references).
//   file <path>      List all symbols defined in one file.
//   grep <pattern>   Fuzzy symbol search (LIKE) — useful when you don't know the exact name.
//   stats            Index summary: files, symbols, languages, freshness.
//   --help
//
// Requires: universal-ctags (NOT the BSD ctags shipped with macOS) and node >= 22 (node:sqlite).

import { DatabaseSync } from 'node:sqlite';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

// ─── Project root resolution ─────────────────────────────────────
// Climb to the git root so the index is stable regardless of cwd inside the repo.
// Falls back to cwd when not in a git repo.
function projectRoot() {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (root) return root;
  } catch { /* not a git repo */ }
  return process.cwd();
}

const ROOT = projectRoot();
const DB_DIR = join(ROOT, '.claude');
const DB_PATH = join(DB_DIR, 'codeindex.db');

// The index DB lives inside the project — keep it out of version control.
// Idempotent: only appends the entry if a .gitignore exists and lacks it.
function ensureGitignored() {
  const giPath = join(ROOT, '.gitignore');
  const entry = '.claude/codeindex.db';
  let body = '';
  if (existsSync(giPath)) {
    body = readFileSync(giPath, 'utf-8');
    // Skip if already covered — by the exact entry OR by an existing glob/dir rule
    // that already matches the DB (e.g. `*.db`, `.claude/`, `.claude/*`).
    const covered = body.split('\n').map((l) => l.trim()).some((l) =>
      l === entry || l === '/' + entry ||
      l === '*.db' || l === '*.db*' ||
      l === '.claude/' || l === '.claude' || l === '.claude/*'
    );
    if (covered) return;
  } else {
    return; // no .gitignore — don't create one, the project may not be a repo
  }
  const sep = body.endsWith('\n') || body === '' ? '' : '\n';
  writeFileSync(giPath, body + sep + entry + '\n');
}

// ─── ctags discovery ─────────────────────────────────────────────
// macOS ships a BSD ctags at /usr/bin/ctags that does NOT support --output-format=json
// nor modern languages. We must use universal-ctags. Detect it explicitly.
function findUniversalCtags() {
  const candidates = ['ctags', 'universal-ctags', '/opt/homebrew/bin/ctags', '/usr/local/bin/ctags'];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Universal Ctags/i.test(out)) return bin;
    } catch { /* not this one */ }
  }
  return null;
}

const CTAGS = findUniversalCtags();

function requireCtags() {
  if (!CTAGS) {
    console.error('[CodeIndex] universal-ctags not found.');
    console.error('  macOS ships an incompatible BSD ctags. Install universal-ctags:');
    console.error('    brew install universal-ctags          (macOS)');
    console.error('    apt-get install universal-ctags       (Debian/Ubuntu)');
    process.exit(2);
  }
}

// ─── DB schema ───────────────────────────────────────────────────
function openDb() {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path  TEXT PRIMARY KEY,   -- relative to project root
      hash  TEXT NOT NULL,      -- sha1 of contents at last index
      mtime INTEGER NOT NULL    -- mtimeMs, used as a cheap pre-filter
    );
    CREATE TABLE IF NOT EXISTS symbols (
      name  TEXT NOT NULL,
      kind  TEXT,               -- class, function, method, variable, …
      path  TEXT NOT NULL,
      line  INTEGER NOT NULL,
      scope TEXT,               -- enclosing class/namespace, if any
      lang  TEXT,
      sig   TEXT,               -- signature (params/types), from ctags
      doc   TEXT                -- one-line intent: leading comment/docstring above the symbol
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

// ─── File enumeration (git-aware, respects .gitignore) ───────────
function listFiles() {
  // git ls-files gives tracked + cached files and honors .gitignore for free.
  // Fall back to a find sweep when not in a repo.
  try {
    const out = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    const out = execSync(
      `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*'`,
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
    );
    return out.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
  }
}

// ─── Docstring / leading-comment extraction ──────────────────────
// Given the file's lines and a symbol's 1-based line, return the one-line
// intent that the author already wrote: the comment block immediately above
// the symbol, or a same-line trailing comment. Language-agnostic — handles
// //, #, /* */, """ """, and JSDoc/banner styles. Returns null when none.
function leadingDoc(lines, defLine) {
  const trailing = lines[defLine - 1] || '';
  // Same-line trailing comment:  const X = 1  // does the thing
  const tm = trailing.match(/(?:\/\/|#)\s?(.+)$/);

  // Strip comment markers from a line, leaving only its prose.
  const strip = (l) => l
    .replace(/^\s*(\/\*\*?|\*\/|\*|\/\/|#|"""|''')?/, '')
    .replace(/(\*\/|"""|''')\s*$/, '')
    .trim();
  // A section banner is decorative, not a docstring: either a pure rule
  // (── ── , ====, ####) with no prose once stripped, or a centered label
  // wrapped in run-of-divider chars on at least one side (── DB schema ──).
  const isDivider = (l) => {
    const s = strip(l);
    if (!/[\p{L}\p{N}]/u.test(s)) return true;  // pure rule: no letters/digits at all
    // Wrapped label: a run of 2+ non-alphanumeric, non-space chars (any box-drawing
    // glyph: ─ ═ ━ = # * ~ …) hugging the start or end → it's a section banner.
    return /^[^\p{L}\p{N}\s]{2,}/u.test(s) || /[^\p{L}\p{N}\s]{2,}$/u.test(s);
  };

  // Walk upward over a contiguous comment block directly above the symbol.
  const collected = [];
  let i = defLine - 2; // 0-based index of the line just above the definition
  // Skip a single blank line between comment and symbol (common in Python).
  if (i >= 0 && lines[i].trim() === '') i--;

  // Block comment closing on the line above:  …  */  or  …  """
  if (i >= 0 && /(\*\/|"""|''')\s*$/.test(lines[i])) {
    while (i >= 0) {
      collected.unshift(lines[i]);
      if (/(^|\s)(\/\*\*?|"""|''')/.test(lines[i])) break;
      i--;
    }
  } else {
    // Line-comment block:  consecutive //, #, or * (JSDoc continuation) lines.
    // Stop at a divider so a section banner above the doc isn't absorbed.
    while (i >= 0 && /^\s*(\/\/|#|\*)/.test(lines[i]) && !isDivider(lines[i])) {
      collected.unshift(lines[i]);
      i--;
    }
  }

  const fromBlock = collected
    .map(strip)
    .filter((l) => l && !isDivider(l))  // drop blank and divider lines inside the block
    .join(' ')
    .trim();

  const doc = fromBlock || (tm ? tm[1].trim() : '');
  if (!doc) return null;
  // Keep it a single concise line.
  return doc.replace(/\s+/g, ' ').slice(0, 200);
}

// ─── ctags extraction for a single file ──────────────────────────
// Returns an array of {name, kind, line, scope, lang, sig, doc}.
// `lines` is the file split into lines (passed in to avoid a second read).
function extractSymbols(relPath, lines) {
  const abs = join(ROOT, relPath);
  let raw;
  try {
    raw = execFileSync(
      CTAGS,
      ['--output-format=json', '--fields=+nKlS', '-f', '-', abs],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return []; // unsupported language / parse error — skip silently
  }
  const out = [];
  for (const lineStr of raw.split('\n')) {
    if (!lineStr) continue;
    let t;
    try { t = JSON.parse(lineStr); } catch { continue; }
    if (t._type !== 'tag' || !t.name || !t.line) continue;
    out.push({
      name: t.name,
      kind: t.kind || null,
      line: t.line,
      scope: t.scope || null,
      lang: t.language || null,
      sig: t.signature || null,
      doc: leadingDoc(lines, t.line),
    });
  }
  return out;
}

// ─── Incremental index ───────────────────────────────────────────
function doIndex({ full = false, verbose = false } = {}) {
  requireCtags();
  ensureGitignored();
  const db = openDb();

  if (full) {
    db.exec('DELETE FROM files; DELETE FROM symbols;');
  }

  const known = new Map(); // path -> {hash, mtime}
  for (const row of db.prepare('SELECT path, hash, mtime FROM files').all()) {
    known.set(row.path, { hash: row.hash, mtime: row.mtime });
  }

  const current = listFiles();
  const currentSet = new Set(current);

  const insSym = db.prepare('INSERT INTO symbols (name, kind, path, line, scope, lang, sig, doc) VALUES (?,?,?,?,?,?,?,?)');
  const delSym = db.prepare('DELETE FROM symbols WHERE path = ?');
  const upFile = db.prepare('INSERT OR REPLACE INTO files (path, hash, mtime) VALUES (?,?,?)');
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');

  let changed = 0, added = 0, removed = 0, skipped = 0;

  db.exec('BEGIN');
  try {
    // Removed files: in DB but no longer on disk.
    for (const path of known.keys()) {
      if (!currentSet.has(path)) {
        delSym.run(path);
        delFile.run(path);
        removed++;
        if (verbose) console.log(`  - ${path}`);
      }
    }

    for (const path of current) {
      const abs = join(ROOT, path);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) { skipped++; continue; } // skip huge/binary-ish

      const prev = known.get(path);
      // Cheap pre-filter on mtime, then confirm with hash to avoid false reindex.
      if (prev && prev.mtime === Math.floor(st.mtimeMs)) { skipped++; continue; }

      // Read once: reuse the same buffer for the content hash and for
      // deriving each symbol's leading-comment doc (avoids a second read).
      let buf;
      try { buf = readFileSync(abs); } catch { continue; }
      const hash = createHash('sha1').update(buf).digest('hex');
      if (prev && prev.hash === hash) {
        // Content unchanged but mtime moved — refresh mtime only.
        upFile.run(path, hash, Math.floor(st.mtimeMs));
        skipped++;
        continue;
      }

      const lines = buf.toString('utf-8').split('\n');
      const syms = extractSymbols(path, lines);
      delSym.run(path);
      for (const s of syms) insSym.run(s.name, s.kind, path, s.line, s.scope, s.lang, s.sig, s.doc);
      upFile.run(path, hash, Math.floor(st.mtimeMs));
      if (prev) changed++; else added++;
      if (verbose) console.log(`  ${prev ? '~' : '+'} ${path}  (${syms.length} symbols)`);
    }

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)')
      .run('last_indexed', String(Math.floor(Date.now() / 1000)));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  db.close();
  return { added, changed, removed, skipped, total: current.length };
}

// ─── Queries ─────────────────────────────────────────────────────
function openDbReadonly() {
  if (!existsSync(DB_PATH)) {
    console.error('[CodeIndex] no index yet — run:  node codeindex.mjs index');
    process.exit(3);
  }
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function where(name) {
  const db = openDbReadonly();
  const rows = db.prepare(
    'SELECT path, line, kind, scope, lang, sig, doc FROM symbols WHERE name = ? ORDER BY path, line'
  ).all(name);
  if (!rows.length) {
    console.log(`No symbol named "${name}". Try:  grep ${name}`);
  } else {
    for (const r of rows) {
      const scope = r.scope ? `  in ${r.scope}` : '';
      console.log(`${r.path}:${r.line}\t${name}${r.sig || ''}\t(${r.kind || '?'})${scope}`);
      if (r.doc) console.log(`    ${r.doc}`);
    }
  }
  db.close();
}

function grep(pattern) {
  const db = openDbReadonly();
  const rows = db.prepare(
    'SELECT DISTINCT name, kind, path, line, sig, doc FROM symbols WHERE name LIKE ? ORDER BY name LIMIT 100'
  ).all(`%${pattern}%`);
  if (!rows.length) console.log(`No symbol matching "*${pattern}*".`);
  else for (const r of rows) {
    console.log(`${r.name}${r.sig || ''}\t${r.path}:${r.line}\t(${r.kind || '?'})`);
    if (r.doc) console.log(`    ${r.doc}`);
  }
  db.close();
}

function fileSymbols(path) {
  const db = openDbReadonly();
  const rel = relative(ROOT, resolve(path));
  const key = existsSync(join(ROOT, path)) ? path : rel;
  const rows = db.prepare(
    'SELECT name, kind, line, scope, sig, doc FROM symbols WHERE path = ? ORDER BY line'
  ).all(key);
  if (!rows.length) console.log(`No symbols indexed for "${key}".`);
  else for (const r of rows) {
    const scope = r.scope ? `  in ${r.scope}` : '';
    console.log(`${r.line}\t${r.name}${r.sig || ''}\t(${r.kind || '?'})${scope}`);
    if (r.doc) console.log(`    \t${r.doc}`);
  }
  db.close();
}

// refs: definitions from the index + plain textual references via ripgrep/grep.
function refs(name) {
  const db = openDbReadonly();
  const defs = db.prepare('SELECT path, line, kind FROM symbols WHERE name = ?').all(name);
  console.log('— definitions —');
  if (!defs.length) console.log('  (none indexed)');
  else for (const r of defs) console.log(`  ${r.path}:${r.line}\t(${r.kind || '?'})`);
  db.close();

  console.log('— references —');
  const rg = (() => { try { execSync('command -v rg', { stdio: 'ignore' }); return true; } catch { return false; } })();
  try {
    const cmd = rg
      ? ['rg', '--no-heading', '-n', '-w', name, ROOT]
      : ['grep', '-rnw', '--exclude-dir=.git', '--exclude-dir=node_modules', name, ROOT];
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    const lines = out.split('\n').filter(Boolean).slice(0, 200);
    for (const l of lines) console.log('  ' + l.replace(ROOT + '/', ''));
    if (out.split('\n').filter(Boolean).length > 200) console.log('  … (truncated at 200)');
  } catch {
    console.log('  (no textual references found)');
  }
}

function stats() {
  const db = openDbReadonly();
  const files = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  const syms = db.prepare('SELECT COUNT(*) c FROM symbols').get().c;
  const langs = db.prepare(
    'SELECT lang, COUNT(*) c FROM symbols WHERE lang IS NOT NULL GROUP BY lang ORDER BY c DESC'
  ).all();
  const kinds = db.prepare(
    'SELECT kind, COUNT(*) c FROM symbols WHERE kind IS NOT NULL GROUP BY kind ORDER BY c DESC LIMIT 10'
  ).all();
  const last = db.prepare("SELECT value FROM meta WHERE key='last_indexed'").get();
  db.close();

  console.log(`Project:      ${ROOT}`);
  console.log(`Index DB:     ${DB_PATH}`);
  console.log(`Files:        ${files}`);
  console.log(`Symbols:      ${syms}`);
  if (last) {
    const ageMin = Math.floor((Date.now() / 1000 - Number(last.value)) / 60);
    console.log(`Last indexed: ${ageMin} min ago`);
  }
  if (langs.length) console.log('Languages:    ' + langs.map((l) => `${l.lang}(${l.c})`).join(' '));
  if (kinds.length) console.log('Kinds:        ' + kinds.map((k) => `${k.kind}(${k.c})`).join(' '));
}

// ─── CLI ─────────────────────────────────────────────────────────
function help() {
  console.log(`CodeIndex — fast symbol index for this project (SQLite + universal-ctags)

Usage: node codeindex.mjs <command> [arg]

  index              Incremental reindex (only changed files)
  index --full       Full rebuild from scratch
  index -v           Verbose: print each added/changed/removed file
  where <name>       Definitions of a symbol  ->  file:line (kind)
  refs <name>        Definitions + every textual reference
  file <path>        All symbols defined in one file
  grep <pattern>     Fuzzy symbol search (substring match)
  stats              Index summary and freshness
  --help

Index lives at: <project-root>/.claude/codeindex.db`);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'index': {
    const verbose = rest.includes('-v') || rest.includes('--verbose');
    const r = doIndex({ full: rest.includes('--full'), verbose });
    console.log(`[CodeIndex] indexed: +${r.added} new, ~${r.changed} changed, -${r.removed} removed, ${r.skipped} unchanged (of ${r.total} files)`);
    break;
  }
  case 'where':  if (!rest[0]) { help(); process.exit(1); } where(rest[0]); break;
  case 'refs':   if (!rest[0]) { help(); process.exit(1); } refs(rest[0]); break;
  case 'file':   if (!rest[0]) { help(); process.exit(1); } fileSymbols(rest[0]); break;
  case 'grep':   if (!rest[0]) { help(); process.exit(1); } grep(rest[0]); break;
  case 'stats':  stats(); break;
  case '--help':
  case '-h':
  case undefined: help(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
