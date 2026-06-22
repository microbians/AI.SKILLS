# CodeIndex

A fast, incremental **symbol index** for any codebase, so Claude Code can answer
*"where is `X` defined?"*, *"what does it take and do?"*, and *"what references it?"*
in milliseconds — instead of reading thousands of files or spawning search agents on
every change.

Each result carries its **signature** (params/types, from ctags) and a **one-line
doc** — the leading comment / docstring the author already wrote above the symbol — so
a lookup orients *what* the symbol does, not just *where* it lives. No AI, no guessing:
the doc is verbatim source, section banners and divider rules stripped out.

It's a thin, durable layer on top of two boring, reliable tools:

- **universal-ctags** — extracts symbol definitions (classes, functions, methods,
  exports, …) for ~150 languages.
- **SQLite** (via Node's built-in `node:sqlite`) — stores them, queried in ms.

The index lives at `<project-root>/.claude/codeindex.db`, is **scoped per project**
(git root, else cwd), and is updated **incrementally** — only files whose content hash
changed are re-parsed. A `SessionStart` hook refreshes it automatically each session.

On first index, the DB is **auto-added to the project's `.gitignore`** so it never gets
committed — unless an existing rule (`*.db`, `.claude/`, …) already covers it, or the
project has no `.gitignore` (then nothing is created). Idempotent: never duplicated.

---

## Why

Claude doesn't hold a large project in context. On every change it re-searches the
codebase (grep sweeps, Explore agents) to relocate the same symbols again and again —
slow and token-hungry. CodeIndex turns "find where this lives" into a single indexed
lookup, so reading is reserved for the exact `file:line` that matters.

It's a **shortcut for the search phase, not a replacement for reading.** ctags indexes
definitions, not a semantic call graph; `refs` augments definitions with a ripgrep
textual scan.

---

## Install

Requires **Node ≥ 22** (for `node:sqlite`) and **universal-ctags**.

```bash
# macOS
brew install universal-ctags
# Debian/Ubuntu
sudo apt-get install universal-ctags

# then, from the repo:
bash CodeIndex/install.sh
```

The installer:
- copies the engine + hook to `~/.claude/codeindex/`,
- installs the `code-index` skill to `~/.claude/skills/code-index/`,
- merges a `SessionStart` reindex hook into `~/.claude/settings.json`,
- adds a permission allow-entry for the query command (no prompts),
- appends a usage snippet to `~/.claude/CLAUDE.md`.

It is idempotent — re-run to upgrade. Uninstall with:

```bash
bash CodeIndex/install.sh --uninstall
```

(Per-project `.claude/codeindex.db` files are left in place on uninstall.)

---

## Usage

Run from anywhere inside a project (it resolves the git root automatically):

```bash
node ~/.claude/codeindex/codeindex.mjs where <Name>     # definitions: file:line (kind)
node ~/.claude/codeindex/codeindex.mjs refs <Name>      # definitions + every textual reference
node ~/.claude/codeindex/codeindex.mjs file <path>      # all symbols defined in one file
node ~/.claude/codeindex/codeindex.mjs grep <pattern>   # fuzzy symbol search (substring)
node ~/.claude/codeindex/codeindex.mjs stats            # files, symbols, languages, freshness
node ~/.claude/codeindex/codeindex.mjs index            # incremental reindex (changed files only)
node ~/.claude/codeindex/codeindex.mjs index --full     # full rebuild
node ~/.claude/codeindex/codeindex.mjs index -v         # verbose: list each added/changed/removed file
```

`where`, `grep`, and `file` print the **signature** next to the name and the **one-line
doc** indented below it (when the symbol has a leading comment / docstring).

Example:

```
$ node ~/.claude/codeindex/codeindex.mjs where extractSymbols
CodeIndex/src/codeindex.mjs:186   extractSymbols(relPath, lines)   (function)
    ctags extraction for a single file. Returns {name, kind, line, scope, lang, sig, doc}.

$ node ~/.claude/codeindex/codeindex.mjs stats
Files:        70
Symbols:      1376
Languages:    JavaScript(657) Markdown(389) JSON(149) TypeScript(117) ...
```

The `SessionStart` hook runs `index -v` and lists what it reindexed (capped at 20 files)
so you see exactly what changed when a session starts.

---

## How it works

1. **Enumerate** files via `git ls-files` (honors `.gitignore`; falls back to `find`).
2. **Diff** each file's stored `mtime` then content `sha1` against the DB — unchanged
   files are skipped, so a no-op reindex over 64 files touches zero of them.
3. **Extract** symbols from changed/new files with `ctags --output-format=json`, capturing
   each symbol's signature plus the leading-comment doc parsed from the file's own lines
   (read once, reused for the hash). Replace that file's rows, update its hash. Removed
   files drop their rows.
4. **Query** the `symbols` table by name / substring / path, returning `file:line`,
   signature, and the one-line doc.

| Component                | Path                                   |
|--------------------------|----------------------------------------|
| Engine + queries         | `src/codeindex.mjs`                     |
| SessionStart reindex hook| `src/reindex-hook.mjs`                  |
| Hook registration        | `hooks.json`                            |
| Skill (behavior rules)   | `skill/SKILL.md`                        |
| CLAUDE.md snippet         | `src/claude-md-snippet.md`             |
| Installer                | `install.sh`                            |

---

## Limitations

- **Definitions, not a call graph.** `refs` is definitions + a ripgrep word scan, so a
  "reference" is any line mentioning the word, not semantic usage.
- **Name collisions** return all definitions; disambiguate by `scope`/`path`.
- **Needs universal-ctags.** The BSD `ctags` shipped with macOS is incompatible; the
  hook prints an install hint and the index stays empty until it's installed.
- Files over 2 MB are skipped.
