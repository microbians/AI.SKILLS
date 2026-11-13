// CodeIndex, read side — for other tools (The Secretary's status line, handoff and
// recall) to use a project's index when one exists. Installed at
// ~/.claude/codeindex/read.mjs; a tool imports it only if that file is there, and
// every function returns null / [] when the project has no index, so a caller never
// needs CodeIndex. The schema stays known here only, next to the code that writes it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';

// (the nearest ancestor of dir, itself included, holding .claude/<file>)
function climb(dir, file) {
  for (let d = dir; d; ) {
    const path = join(d, '.claude', file);
    if (existsSync(path)) return { root: d, path };
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

// A running index's progress — { phase: 'files' | 'links' | 'saving', done, total } —
// or null: none running, or the run that wrote it is gone.
export function indexProgress(dir) {
  const found = dir && climb(dir, 'codeindex.progress');
  if (!found) return null;
  try {
    const p = JSON.parse(readFileSync(found.path, 'utf-8'));
    process.kill(p.pid, 0);
    return p;
  } catch { return null; }
}

// The project's index, read-only: { db, root } (close with index.db.close()), or null.
// node:sqlite loads here, not on import: a status line refreshing every second that
// only asks indexProgress never pays for it (nor prints its experimental warning).
export function openIndex(dir) {
  const found = dir && climb(dir, 'codeindex.db');
  if (!found) return null;
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    return { db: new DatabaseSync(found.path, { readOnly: true }), root: found.root };
  } catch { return null; }
}

const CALLABLE = "('function', 'method', 'class', 'interface', 'struct', 'trait', 'enum', 'func', 'def', 'member', 'getter', 'setter')";

// The functions, methods and classes defined in a file whose name appears as a word in
// text (the text an edit wrote or replaced), most mentioned first. file: absolute, or
// relative to the index root.
export function symbolsIn(index, file, text, max = 6) {
  if (!index || !text) return [];
  const rel = isAbsolute(file) ? relative(index.root, file) : file;
  const names = index.db.prepare(`SELECT DISTINCT name FROM symbols WHERE path = ? AND kind IN ${CALLABLE}`).all(rel);
  const counts = [];
  for (const { name } of names) {
    const escaped = name.replace(/[$]/g, '\\$');
    const hits = text.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g'));
    if (hits) counts.push({ name, n: hits.length });
  }
  return counts.sort((a, b) => b.n - a.n).slice(0, max).map((c) => c.name);
}

// The files (relative to the index root) defining a symbol named exactly name,
// shortest path first.
export function filesDefining(index, name, max = 3) {
  if (!index || !/^[\w$]+$/.test(name)) return [];
  return index.db.prepare('SELECT DISTINCT path FROM symbols WHERE name = ? ORDER BY length(path) LIMIT ?')
    .all(name, max).map((r) => r.path);
}
