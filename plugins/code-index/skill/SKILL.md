---
name: code-index
description: Fast symbol lookup for large codebases. Use BEFORE reading files or spawning search agents to locate where a class/function/method is defined and what references it. Backed by an incremental SQLite + universal-ctags index, scoped per project. Answers "where is X?" in milliseconds instead of reading thousands of files.
version: 1.3.0
updated: 2026-11-13
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
- "Where is `Renderer.draw`, and every method `Renderer` has?" → `where Renderer.draw`, `members Renderer` (mixins included)
- "There's a function about parsing… what's it called?" → `grep pars` (or `grep parse config`, `grep "reads the picked id"` — words of its name, doc or signature)
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
node ~/.claude/codeindex/codeindex.mjs where <Class.name> # a class's member: its own, or from a class mixed into it
node ~/.claude/codeindex/codeindex.mjs members <Class>   # every member of a class, its mixins' included
node ~/.claude/codeindex/codeindex.mjs grep <words…>   # loose search, ranked: words of names, doc, signature; typos → closest names

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

## Loose search (grep)

`grep` does not need the exact name. Same method as The Secretary (SQLite FTS5):

- Each name is indexed as the words it is made of: `_loadUser` → `load`, `user`;
  `HTTPServer2` → `HTTP`, `Server`, `2`; `parse_config_file` → `parse`, `config`, `file`.
- Each word you give matches as a **prefix** of any of those words, of the symbol's doc
  comment or of its signature; several words are OR-ed and **bm25** ranks the symbols
  matching most of them (a hit in the name weighs more) first. Case and accents ignored.
- Then plain substring matches on the name (`ser` finds `_loadUser`).
- Nothing found → the closest names by edit distance (`lodUser` → `_loadUser`);
  `where` does the same when an exact name misses.
- A name defined in several files shows once, the shortest path first, with `(+N more)`.

---

## Mixins (a class's methods kept in other files)

A large JS/TS class split into groups of methods — each group a class of its own whose
members are laid onto the main class's prototype — is indexed as such. The index records
the wiring wherever the project writes it:

- `Object.assign(Target.prototype, Source.prototype, …)`
- a helper whose name contains "mix": `mixInto(Target, Source)`, `applyMixins(Target, [A, B])`,
  or one called over a list: `for (const m of [A, B]) mixInto(Target, m)`

Then a mixed-in member shows its real home and the class it lands in:
`where _loadUser` → `store/user-methods.js:172  _loadUser(id)  (method)  in UserMethods → Store (mixin)`;
`where Store._loadUser` finds it by the class it belongs to; `members Store` lists the
class's own members and each mixin's, with where it is wired. With mixins, members are read
only from the wiring file and each source class's file, so stale copies of the class
elsewhere in the tree (old versions kept for A/B) stay out.

---

## Freshness / self-healing

- The SessionStart hook reindexes incrementally each session, so the DB is usually fresh.
- If you just created or heavily edited files in *this* session and a `where` lookup
  misses a symbol you know exists, force a refresh: `node ~/.claude/codeindex/codeindex.mjs index`.
- If results look stale or wrong after a big refactor: `index --full`.
- If `where`/`refs` say "no index yet", run `index` once.
- After an upgrade that adds a table (schema version), the first `index` rebuilds the whole index once — on a large tree (30k files) that takes minutes.

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
