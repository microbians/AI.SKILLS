---
name: code-index
description: Fast symbol lookup for large codebases. Use BEFORE reading files or spawning search agents to locate where a class/function/method is defined and what references it. Backed by an incremental SQLite + universal-ctags index, scoped per project. Answers "where is X?" in milliseconds instead of reading thousands of files.
version: 1.6.2
updated: 2026-11-25
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

# Structure — deep modules, narrow interfaces (exit 1 when it finds problems)
node ~/.claude/codeindex/codeindex.mjs lint                     # every rule, whole project
node ~/.claude/codeindex/codeindex.mjs lint field-leak src/sched  # one rule, one subtree
node ~/.claude/codeindex/codeindex.mjs lint --new               # only problems new or worse since the last lint of those rules
node ~/.claude/codeindex/codeindex.mjs lint field-leak --all     # every detail line, nothing cut short (--json: as JSON)

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

## Lint — deep modules, narrow interfaces

`lint` reindexes, then reports five structural smells (after deslop-please and
*A Philosophy of Software Design*):

| Rule | What it means |
|---|---|
| `module-cycle` | files that import each other in a ring (local imports only — exact) |
| `tangle` | two classes of one file that each use the other |
| `field-leak` | a class's fields (declared, or set as `this.x` / `$this->x` in its methods) written (`q.head++`) or reached into (`q.items.push()`, `q.items[i]`) from any other file — a plain read is not a leak, but each finding lists who reads its fields too |
| `shallow-module` | one client file calls at least 6 functions, and at least half of all the functions and methods, of another file |
| `hidden-modules` | a file of 40+ functions whose functions fall into groups that never call each other, once the most-called shared helpers are set aside — modules living in one file |

It also runs on its own:
- **Session start** — the reindex hook lints the whole project and shows the total and the first findings.
- **After a turn that edited files** — a Stop hook starts `lint --new module-cycle tangle` in the
  background (the turn is not held up): only those problems new or worse than last time. The
  next turn's Stop hands them over and that turn continues with them: fix them if a recent change
  introduced them, else tell the user in one line. A problem is raised
  again only if it grows; a turn without edits runs nothing. `field-leak`, `shallow-module` and
  `hidden-modules` are judgment calls: session start and on demand only.

A field counts only when its name belongs to one class in the whole index — what it reports is
real; some leaks go unseen (a field also set on hand-built object literals elsewhere is skipped).

Fields a class hands out on purpose — a record its engines read in hot loops — are its
contract, not leaks. Name them in a comment just above the class or inside it:
`// @contract-fields x y width`, or `// @contract-fields *` for every field.

Fix from first principles, never by moving code to silence a finding:
- `module-cycle` / `tangle`: which layer does each file or class belong to? The lower one must stop knowing the higher one.
- `field-leak` / `shallow-module`: why do outsiders need these fields or functions? Look at the patterns of use and hide them behind a few calls that say what the client wants — all leaks of a class together, not one by one.
- `hidden-modules`: each group is a module waiting for its own file; move a group out with the shared helpers it needs, one group at a time, and keep the file's callers working through the new file's few exports.
- Show the user the before/after structure in a small diagram.

---

## Freshness / self-healing

- The SessionStart hook reindexes incrementally each session, so the DB is usually fresh.
- If you just created or heavily edited files in *this* session and a `where` lookup
  misses a symbol you know exists, force a refresh: `node ~/.claude/codeindex/codeindex.mjs index`.
- If results look stale or wrong after a big refactor: `index --full`.
- If `where`/`refs` say "no index yet", run `index` once.
- After an upgrade that adds a table (schema version), the first `index` rebuilds the whole index once — on a large tree (30k files) that takes minutes.
- What gets indexed: in a git repo, `git ls-files` (every `.gitignore` honored); outside one, a sweep that honors every `.gitignore` in the tree, each scoped to its own folder. Either way, build/vendor folders are skipped at any depth: `node_modules`, `.next`, `.turbo`, `dist`, `build`, `out`, `coverage`.

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
