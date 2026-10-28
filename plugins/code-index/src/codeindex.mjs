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
//   stats            Index summary: files, symbols, edges, languages, freshness.
//   callers <name>   Relational thread: who calls/uses a symbol (symbol→symbol edges).
//   deps <file>      Relational thread: what a file imports + the local files it calls into.
//   arch             Relational thread: module dependency map, derived from the edge graph.
//   flow <module>    Relational thread: up/downstream of a module.
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
    -- The relational thread: how the project wires together. One row per edge
    -- src → dst, extracted deterministically (no LLM) during the same per-file
    -- scan that fills symbols. Two edge kinds:
    --   import — src_path's file imports/requires the module dst_name (dst_path
    --            is the resolved on-disk target when it could be located, else NULL).
    --   uses   — the symbol src_name (defined at src_path) calls/references the
    --            known symbol dst_name (resolved against the symbols table; only
    --            edges whose dst is an indexed definition are kept, to stay exact).
    -- The module-level architecture map is DERIVED from these rows by aggregating
    -- per directory at query time — no separate table, one source of truth.
    CREATE TABLE IF NOT EXISTS refs (
      kind     TEXT NOT NULL,     -- import | uses
      src_name TEXT,              -- enclosing symbol on the source side (NULL for file-level imports)
      src_path TEXT NOT NULL,     -- file the edge originates from
      src_line INTEGER,           -- line of the import / call site
      dst_name TEXT NOT NULL,     -- imported module specifier, or called symbol
      dst_path TEXT               -- resolved target file (NULL when unresolved/external)
    );
    CREATE INDEX IF NOT EXISTS idx_refs_dst  ON refs(dst_name);
    CREATE INDEX IF NOT EXISTS idx_refs_src  ON refs(src_path);
    CREATE INDEX IF NOT EXISTS idx_refs_kind ON refs(kind);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

// Extensions worth feeding to ctags: real source + docs/markup that carry
// symbols. Deliberately EXCLUDES data formats (.json/.xml/.yaml/.toml): ctags
// extracts no useful code symbols from them, but a project can hold thousands
// of data/cache files (one per record), and indexing them all is what OOMs the
// process on a big tree. The non-git fallback enumerates ONLY these so a sweep
// never drags in media/data/binaries (.jpg/.mp3/.db/.json …). Value-agnostic:
// keyed on file type, never on a project's folder names.
const INDEXABLE_EXTS = [
  'php', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'rb',
  'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'scala', 'sh',
  'bash', 'zsh', 'pl', 'pm', 'lua', 'sql', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'vue', 'svelte', 'md',
];

// Parse a .gitignore into matcher fns. Supports the subset that matters for
// pruning a sweep: blank/comment lines, dir globs (`foo/`), trailing `/*`,
// leading `!` negation, and plain path/glob prefixes. Returns predicate(relPath)
// → true when the path should be IGNORED. Best-effort, not a full gitignore impl
// — only used in the non-git fallback to honor the exclusions the user already
// wrote, so a data tree they'd never commit (storage/, tenants/…) stays out.
function gitignoreMatcher(root) {
  const giPath = join(root, '.gitignore');
  if (!existsSync(giPath)) return () => false;
  let body;
  try { body = readFileSync(giPath, 'utf-8'); } catch { return () => false; }
  const rules = [];
  for (let line of body.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let pat = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat) continue;
    // Build a regex: ** → any, * → any-but-slash, escape the rest. A pattern
    // with no slash matches a path segment anywhere; with a slash it anchors.
    const rx = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*');
    const anchored = line.includes('/');
    const re = new RegExp(anchored ? `^${rx}(/|$)` : `(^|/)${rx}(/|$)`);
    rules.push({ re, negate });
  }
  return (rel) => {
    let ignored = false;
    for (const { re, negate } of rules) if (re.test(rel)) ignored = !negate;
    return ignored;
  };
}

// ─── File enumeration (git-aware, respects .gitignore) ───────────
// Directory names that are never source to index: VCS internals, dependency
// trees, build output, and tool-generated backup dirs (SafeEdit's per-edit
// snapshots would otherwise duplicate every symbol N times). Pruned in BOTH
// the git and non-git paths. Tool/VCS conventions, not any one project's layout.
const PRUNE_DIRS = ['.git', 'node_modules', 'dist', '.safe-edit-backups', '.backups'];
const inPrunedDir = (p) => PRUNE_DIRS.some((d) => p === d || p.startsWith(d + '/') || p.includes('/' + d + '/'));

function listFiles() {
  // git ls-files gives tracked + cached files and honors .gitignore for free.
  // Fall back to a find sweep when not in a repo.
  try {
    const out = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    });
    // --others can surface untracked tool backups; prune them here too.
    return out.split('\n').filter(Boolean).filter((p) => !inPrunedDir(p));
  } catch {
    // No git → no `git ls-files` to prune by. Two safeguards: (1) restrict to
    // indexable extensions so the sweep can't swallow a media/data tree, and
    // (2) still honor the project's own .gitignore (the user already listed the
    // heavy dirs there). Always prune the usual junk dirs too.
    const extExpr = INDEXABLE_EXTS.map((e) => `-name '*.${e}'`).join(' -o ');
    const pruneExpr = PRUNE_DIRS.map((d) => `-not -path '*/${d}/*'`).join(' ');
    const out = execSync(
      `find . -type f ${pruneExpr} \\( ${extExpr} \\)`,
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
    );
    const ignored = gitignoreMatcher(ROOT);
    return out.split('\n').filter(Boolean)
      .map((p) => p.replace(/^\.\//, ''))
      .filter((p) => !ignored(p));
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

// Extra ctags regex rules: capture JS functions declared inside <script> blocks
// in PHP/HTML templates, which the native PHP/HTML parsers skip entirely (they
// only see the host language). Covers `function name(` and `const|let|var name =
// function|(|async`. Tagged kind 'embeddedjs' (one-letter ctags code J) so a
// result is visibly JS-in-a-template, not a native symbol. The kind name must be
// alphanumeric — a hyphen makes ctags reject the whole option and emit zero
// symbols. Value-agnostic; only fires inside these host languages.
const EMBEDDED_JS_RULES = ['PHP', 'HTML'].flatMap((host) => [
  `--regex-${host}=/^[[:space:]]*(async[[:space:]]+)?function[[:space:]]+([a-zA-Z_$][a-zA-Z0-9_$]*)[[:space:]]*\\(/\\2/J,embeddedjs,JS function in a template/`,
  `--regex-${host}=/^[[:space:]]*(const|let|var)[[:space:]]+([a-zA-Z_$][a-zA-Z0-9_$]*)[[:space:]]*=[[:space:]]*(async[[:space:]]+)?(function|\\()/\\2/J,embeddedjs,JS function in a template/`,
]);

// ─── ctags extraction for a single file ──────────────────────────
// Returns an array of {name, kind, line, scope, lang, sig, doc}.
// `lines` is the file split into lines (passed in to avoid a second read).
function extractSymbols(relPath, lines) {
  const abs = join(ROOT, relPath);
  let raw;
  try {
    raw = execFileSync(
      CTAGS,
      ['--output-format=json', '--fields=+nKlS', ...EMBEDDED_JS_RULES, '-f', '-', abs],
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

// ─── Import extraction (file-level edges) ────────────────────────
// Scan a file for import/require/include statements and return the raw module
// specifiers it pulls in: { dstName, line }. Language-agnostic via a small set
// of patterns covering the common ecosystems (JS/TS, Python, Go, Rust, Ruby,
// shell `source`, C/C++ include). The specifier is kept verbatim — resolution
// to an on-disk file (when local) happens later, once all paths are known.
function extractImports(lines) {
  const out = [];
  const patterns = [
    /\bimport\b[^'"]*['"]([^'"]+)['"]/,            // ES import ... from '...' / import '...'
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,      // CommonJS require('...')
    /\bfrom\s+([.\w]+)\s+import\b/,                // Python: from x.y import z
    /^\s*import\s+([.\w]+)/,                        // Python/Go/Java: import x.y
    /^\s*(?:source|\.)\s+["']?([^\s"';]+)/,        // shell: source file / . file
    /^\s*#\s*include\s+[<"]([^>"]+)[>"]/,          // C/C++: #include <x>
    /\buse\s+([\w:]+)/,                             // Rust: use a::b::c
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of patterns) {
      const m = line.match(re);
      if (m && m[1]) { out.push({ dstName: m[1], line: i + 1 }); break; }
    }
  }
  return out;
}

// Resolve a local import specifier to an indexed file path, or null if external
// (a bare package name like 'react' / 'os' that isn't a relative/abs project path).
// Tries the specifier as-is and with the common source extensions + /index.
function resolveImport(spec, fromPath, knownPaths) {
  // Only relative/absolute specifiers can be local files; bare names are external.
  if (!/^[./]/.test(spec)) return null;
  const baseDir = dirname(fromPath);
  const cand = spec.startsWith('/') ? spec.slice(1) : join(baseDir, spec);
  const norm = cand.replace(/\\/g, '/');
  const exts = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb'];
  for (const e of exts) if (knownPaths.has(norm + e)) return norm + e;
  for (const e of exts.slice(1)) if (knownPaths.has(join(norm, 'index' + e))) return join(norm, 'index' + e);
  return null;
}

// Source-code file? Used to gate 'uses' edge extraction to real code (docs and
// markdown only mention symbol names; they aren't callers). Extension-based.
const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'rb', 'java',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'swift', 'kt', 'scala', 'sh', 'bash',
]);
function isCodeFile(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return CODE_EXTS.has(ext);
}

// ─── Call/usage extraction (symbol → symbol edges) ───────────────
// For one file, find which KNOWN symbols (defined anywhere in the index) are
// referenced, and attribute each reference to the enclosing defined symbol of
// this file. Deterministic and conservative: we only emit an edge when the
// referenced token is a real indexed definition (in defByName) AND it isn't the
// definition site itself — so the graph stays exact instead of guessing.
// `localDefs` is this file's own definitions sorted by line, used to attribute
// each call site to the function/method it sits inside.
function extractCalls(relPath, lines, localDefs, defByName) {
  const edges = [];
  // Sort this file's defs by line so we can map any line to its enclosing symbol.
  const defs = [...localDefs].sort((a, b) => a.line - b.line);
  const enclosing = (lineNo) => {
    let cur = null;
    for (const d of defs) { if (d.line <= lineNo) cur = d; else break; }
    return cur ? cur.name : null;
  };
  // Match identifier-shaped tokens; for each, if it names a known definition
  // elsewhere, record an edge. Cap per-file work to keep indexing fast.
  const seen = new Set(); // dedupe (srcName, dstName) within the file
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/(["'`]).*?\1/g, '').replace(/(?:\/\/|#).*$/, ''); // strip strings/comments
    const ids = code.match(/[A-Za-z_$][\w$]*/g);
    if (!ids) continue;
    for (const id of ids) {
      const dst = defByName.get(id);
      if (!dst) continue;                       // not a known definition
      if (dst.path === relPath && dst.line === i + 1) continue; // its own def site
      const src = enclosing(i + 1);
      const key = `${src}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ srcName: src, srcLine: i + 1, dstName: id, dstPath: dst.path });
    }
  }
  return edges;
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
  const insRef = db.prepare('INSERT INTO refs (kind, src_name, src_path, src_line, dst_name, dst_path) VALUES (?,?,?,?,?,?)');
  const delRef = db.prepare('DELETE FROM refs WHERE src_path = ?');
  const upFile = db.prepare('INSERT OR REPLACE INTO files (path, hash, mtime) VALUES (?,?,?)');
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');

  let changed = 0, added = 0, removed = 0, skipped = 0;
  // Files whose symbols changed this run — their refs must be re-extracted in a
  // second pass, once the full symbol table is up to date (call resolution needs it).
  const touched = new Map(); // relPath -> lines[]

  db.exec('BEGIN');
  try {
    // Removed files: in DB but no longer on disk.
    for (const path of known.keys()) {
      if (!currentSet.has(path)) {
        delSym.run(path);
        delRef.run(path);
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
      // Skip minified / single-line blobs (bundled .min.js, one-line caches):
      // a single multi-hundred-KB line makes ctags and the docstring regexes
      // thrash and can blow the heap. No real source has a 50KB+ line; this is
      // a content guard, value-agnostic, distinct from the per-file size cap.
      if (lines.some((l) => l.length > 50000)) { skipped++; continue; }
      const syms = extractSymbols(path, lines);
      delSym.run(path);
      for (const s of syms) insSym.run(s.name, s.kind, path, s.line, s.scope, s.lang, s.sig, s.doc);
      upFile.run(path, hash, Math.floor(st.mtimeMs));
      touched.set(path, lines);
      if (prev) changed++; else added++;
      if (verbose) console.log(`  ${prev ? '~' : '+'} ${path}  (${syms.length} symbols)`);
    }

    // ── Second pass: the relational thread ──────────────────────────
    // Now that the symbol table reflects every change, (re)build refs for the
    // touched files. defByName maps each known definition name to its primary
    // site, so call edges resolve to real targets only. On a --full rebuild we
    // also clear the whole refs table up front so nothing stale survives.
    if (full) db.exec('DELETE FROM refs;');
    if (touched.size) {
      const knownPaths = currentSet;
      // Only callable definitions are valid 'uses' targets. Variables/constants/
      // properties have generic names (db, path, root, lines) that collide across
      // unrelated projects and would forge bogus cross-module edges — restricting
      // to callables keeps the graph (and the derived architecture map) exact.
      // Also drop names that resolve to MORE THAN ONE callable definition: an
      // ambiguous name (e.g. a `start()` defined in two projects) can't be
      // attributed to one target without guessing, so we skip it entirely.
      const CALLABLE = new Set(['function', 'method', 'class', 'interface', 'struct', 'trait', 'enum', 'func', 'def', 'member']);
      const defCount = new Map();
      const defByName = new Map();
      for (const r of db.prepare('SELECT name, path, line, kind FROM symbols').all()) {
        if (!CALLABLE.has((r.kind || '').toLowerCase())) continue;
        defCount.set(r.name, (defCount.get(r.name) || 0) + 1);
        if (!defByName.has(r.name)) defByName.set(r.name, { path: r.path, line: r.line, kind: r.kind });
      }
      for (const [n, c] of defCount) if (c > 1) defByName.delete(n); // ambiguous → not resolvable
      for (const [path, lines] of touched) {
        delRef.run(path);
        // Imports — file-level edges.
        for (const imp of extractImports(lines)) {
          insRef.run('import', null, path, imp.line, imp.dstName, resolveImport(imp.dstName, path, knownPaths));
        }
        // Uses — symbol→symbol edges, attributed to the enclosing local definition.
        // Only from actual CODE files: docs/markdown mention symbol names in prose
        // and snippets, which would forge phantom dependency edges (a README is not
        // a caller). Restricting 'uses' to code keeps the architecture map honest.
        if (!isCodeFile(path)) continue;
        const localDefs = db.prepare('SELECT name, line FROM symbols WHERE path = ?').all(path);
        for (const e of extractCalls(path, lines, localDefs, defByName)) {
          insRef.run('uses', e.srcName, path, e.srcLine, e.dstName, e.dstPath);
        }
      }
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

// ─── Relational-thread queries ───────────────────────────────────

// callers <name> — who uses symbol <name>: every 'uses' edge whose dst is <name>,
// grouped by the enclosing source symbol, plus who imports the file defining it.
function callers(name) {
  const db = openDbReadonly();
  const uses = db.prepare(
    `SELECT src_name, src_path, src_line FROM refs
     WHERE kind='uses' AND dst_name = ? ORDER BY src_path, src_line`
  ).all(name);
  console.log(`— callers / users of ${name} —`);
  if (!uses.length) console.log('  (none indexed)');
  else for (const r of uses) {
    console.log(`  ${r.src_path}:${r.src_line}\t${r.src_name ? r.src_name + '()' : '(file scope)'}`);
  }
  db.close();
}

// deps <file> — what a file pulls in: its import edges (resolved target when local,
// otherwise the bare external specifier) + the local files it calls into.
function deps(path) {
  const db = openDbReadonly();
  const rel = relative(ROOT, resolve(path));
  const key = existsSync(join(ROOT, path)) ? path : rel;
  const imports = db.prepare(
    `SELECT dst_name, dst_path, src_line FROM refs WHERE kind='import' AND src_path = ? ORDER BY src_line`
  ).all(key);
  const calls = db.prepare(
    `SELECT DISTINCT dst_path FROM refs WHERE kind='uses' AND src_path = ? AND dst_path != ? ORDER BY dst_path`
  ).all(key, key);
  console.log(`— ${key} imports —`);
  if (!imports.length) console.log('  (none)');
  else for (const r of imports) {
    console.log(`  ${r.dst_name}${r.dst_path ? '  → ' + r.dst_path : '  (external)'}`);
  }
  if (calls.length) {
    console.log(`— calls into —`);
    for (const r of calls) console.log(`  ${r.dst_path}`);
  }
  db.close();
}

// Map a file path to its module bucket — the top-2 path segments, so
// `others/microbrain/plugins/x.ts` → `others/microbrain`. Single-segment paths
// stay as-is. This is the directory-level grain the architecture map aggregates on.
function moduleOf(p) {
  const parts = p.split('/');
  if (parts.length <= 1) return parts[0] || p;
  return parts.slice(0, 2).join('/');
}

// arch — the project architecture map, DERIVED from refs by aggregating every
// cross-module edge (import + uses) into module→module counts. No stored table.
function arch() {
  const db = openDbReadonly();
  const rows = db.prepare(
    `SELECT src_path, dst_path FROM refs WHERE dst_path IS NOT NULL AND dst_path != src_path`
  ).all();
  const edges = new Map(); // "from→to" -> weight
  for (const r of rows) {
    const from = moduleOf(r.src_path), to = moduleOf(r.dst_path);
    if (from === to) continue; // intra-module wiring isn't an architecture edge
    const k = `${from} ${to}`;
    edges.set(k, (edges.get(k) || 0) + 1);
  }
  db.close();
  const sorted = [...edges.entries()].sort((a, b) => b[1] - a[1]);
  console.log('— module dependency map (from → to, weight = cross-module edges) —');
  if (!sorted.length) console.log('  (no cross-module edges indexed)');
  else for (const [k, w] of sorted) {
    const [from, to] = k.split(' ');
    console.log(`  ${from}  →  ${to}\t(${w})`);
  }
}

// flow <module> — up/downstream of one module: who depends on it (upstream) and
// what it depends on (downstream), aggregated from the same cross-module edges.
function flow(mod) {
  const db = openDbReadonly();
  const rows = db.prepare(
    `SELECT src_path, dst_path FROM refs WHERE dst_path IS NOT NULL AND dst_path != src_path`
  ).all();
  // Match the requested module exactly, or by prefix so `flow TheSecretary`
  // also covers `TheSecretary/src` (the 2-segment bucket arch reports on).
  const matches = (m) => m === mod || m.startsWith(mod + '/') || mod.startsWith(m + '/');
  const up = new Map(), down = new Map();
  for (const r of rows) {
    const from = moduleOf(r.src_path), to = moduleOf(r.dst_path);
    if (from === to) continue;
    if (matches(to) && !matches(from)) up.set(from, (up.get(from) || 0) + 1);   // from depends on mod
    if (matches(from) && !matches(to)) down.set(to, (down.get(to) || 0) + 1);   // mod depends on to
  }
  db.close();
  const dump = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([k, w]) => console.log(`  ${k}\t(${w})`));
  console.log(`— upstream (depends on ${mod}) —`);
  if (!up.size) console.log('  (none)'); else dump(up);
  console.log(`— downstream (${mod} depends on) —`);
  if (!down.size) console.log('  (none)'); else dump(down);
}

function stats() {
  const db = openDbReadonly();
  const files = db.prepare('SELECT COUNT(*) c FROM files').get().c;
  const syms = db.prepare('SELECT COUNT(*) c FROM symbols').get().c;
  const refsCount = db.prepare('SELECT COUNT(*) c FROM refs').get().c;
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
  console.log(`Refs (edges): ${refsCount}`);
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

 Relational thread (how the project wires together):
  callers <name>     Who calls / uses a symbol (symbol→symbol edges)
  deps <file>        What a file imports + the local files it calls into
  arch               Module dependency map (from → to, by edge weight)
  flow <module>      Up/downstream of a module (who needs it / what it needs)
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
  case 'where':   if (!rest[0]) { help(); process.exit(1); } where(rest[0]); break;
  case 'refs':    if (!rest[0]) { help(); process.exit(1); } refs(rest[0]); break;
  case 'file':    if (!rest[0]) { help(); process.exit(1); } fileSymbols(rest[0]); break;
  case 'grep':    if (!rest[0]) { help(); process.exit(1); } grep(rest[0]); break;
  case 'callers': if (!rest[0]) { help(); process.exit(1); } callers(rest[0]); break;
  case 'deps':    if (!rest[0]) { help(); process.exit(1); } deps(rest[0]); break;
  case 'arch':    arch(); break;
  case 'flow':    if (!rest[0]) { help(); process.exit(1); } flow(rest[0]); break;
  case 'stats':   stats(); break;
  case '--help':
  case '-h':
  case undefined: help(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
