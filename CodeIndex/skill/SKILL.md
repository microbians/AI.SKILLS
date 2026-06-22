---
name: code-index
description: Fast symbol lookup for large codebases. Use BEFORE reading files or spawning search agents to locate where a class/function/method is defined and what references it. Backed by an incremental SQLite + universal-ctags index, scoped per project. Answers "where is X?" in milliseconds instead of reading thousands of files.
license: MIT
metadata:
  type: code-intelligence
  output: .claude/codeindex.db
  scope: all-codebases
---

# CodeIndex Skill

A per-project symbol index. Instead of reading dozens of files or fanning out search
agents to figure out *where* something lives, query the index — it returns
`file:line (kind)` instantly. The index updates incrementally on every session start
(via a SessionStart hook), so it is normally fresh without any action from you.

**Engine:** `~/.claude/codeindex/codeindex.mjs` (run with `node`).
**DB:** `<project-root>/.claude/codeindex.db` (SQLite, auto-created).

---

## When to use this FIRST

Reach for CodeIndex *before* Read/Grep/Glob or an Explore agent whenever you need to
locate a symbol you can name:

- "Where is `UserService` defined?" → `where UserService`
- "What references `validateToken`?" → `refs validateToken`
- "What's in this file?" → `file src/auth/login.ts`
- "There's a function about parsing… what's it called?" → `grep pars`
- "How big is this project / what languages?" → `stats`

And *before* a change, to understand how the project wires together (the relational thread):

- "Who would break if I change `parseConfig`?" → `callers parseConfig`
- "What does this file pull in?" → `deps src/auth/login.ts`
- "How is this codebase structured?" → `arch`
- "What depends on the auth module / what does it need?" → `flow src/auth`

This is a shortcut, not a replacement for reading. Once CodeIndex points you at
`file:line`, Read that exact location. The win is skipping the *search* phase.

---

## Commands

```bash
# Locate symbols
node ~/.claude/codeindex/codeindex.mjs where <Name>     # definitions: file:line (kind) + doc
node ~/.claude/codeindex/codeindex.mjs refs <Name>      # definitions + every textual reference
node ~/.claude/codeindex/codeindex.mjs file <path>      # all symbols defined in one file
node ~/.claude/codeindex/codeindex.mjs grep <pattern>   # fuzzy symbol search (substring)

# Relational thread — how the project connects (deterministic edge graph)
node ~/.claude/codeindex/codeindex.mjs callers <Name>   # who calls/uses a symbol (blast radius)
node ~/.claude/codeindex/codeindex.mjs deps <file>      # what a file imports + the local files it calls into
node ~/.claude/codeindex/codeindex.mjs arch             # module dependency map (from -> to, weighted)
node ~/.claude/codeindex/codeindex.mjs flow <module>    # up/downstream of a module

node ~/.claude/codeindex/codeindex.mjs stats            # files, symbols, edges, languages, freshness
node ~/.claude/codeindex/codeindex.mjs index            # incremental reindex (changed files only)
node ~/.claude/codeindex/codeindex.mjs index --full     # full rebuild
```

The command resolves the project automatically (git root, else cwd) — run it from
anywhere inside the repo.

---

## Typical flow

```bash
# 1. Locate the definition (no file reads, no agents)
node ~/.claude/codeindex/codeindex.mjs where parseConfig
#   src/config/loader.ts:88   (function)

# 2. Read exactly that spot
#    -> Read src/config/loader.ts around line 88

# 3. Find everything that uses it before changing it
node ~/.claude/codeindex/codeindex.mjs refs parseConfig
```

---

## Freshness / self-healing

- The SessionStart hook reindexes incrementally each session, so the DB is usually fresh.
- If you just created or heavily edited files in *this* session and a `where` lookup
  misses a symbol you know exists, force a refresh: `node ~/.claude/codeindex/codeindex.mjs index`.
- If results look stale or wrong after a big refactor: `index --full`.
- If `where`/`refs` say "no index yet", run `index` once.

## Limitations (be honest about these)

- ctags indexes **definitions**; `refs` augments with a `ripgrep` textual scan, so a
  "reference" is any line mentioning the word — not semantic usage.
- The relational graph (`callers`/`deps`/`arch`/`flow`) is deterministic but heuristic:
  `import` edges resolved to local files and `callers` of uniquely-named symbols are
  exact; `uses`/`arch` edges are matched by name, so in a monorepo where unrelated
  subprojects share common function names (`init`, `start`, `openDb`) a few cross-module
  edges may be noise. Treat `arch`/`flow` as a strong hint, `where`/`callers` as ground truth.
- A symbol name shared across files returns all definitions; disambiguate by `scope`/`path`.
- Requires `universal-ctags`. If missing, the hook prints an install hint and the index
  stays empty — fall back to Grep/Explore until `brew install universal-ctags` is run.
