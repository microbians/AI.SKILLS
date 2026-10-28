## Code symbol lookup (CodeIndex)

To locate WHERE a symbol (class, function, method, export) is defined or referenced, AND to understand HOW the project wires together (what calls/imports what), query the CodeIndex index BEFORE reading files or spawning search agents. It answers in milliseconds from a per-project SQLite index (symbols + a relational edge graph), auto-refreshed each session.

```bash
# Locate symbols
node ~/.claude/codeindex/codeindex.mjs where <Name>    # definitions -> file:line (kind) + doc
node ~/.claude/codeindex/codeindex.mjs refs <Name>     # definitions + textual references
node ~/.claude/codeindex/codeindex.mjs file <path>     # symbols in one file
node ~/.claude/codeindex/codeindex.mjs grep <pattern>  # fuzzy symbol search

# Relational thread — how the project connects (deterministic edge graph, no LLM)
node ~/.claude/codeindex/codeindex.mjs callers <Name>  # who calls/uses a symbol
node ~/.claude/codeindex/codeindex.mjs deps <file>     # what a file imports + calls into
node ~/.claude/codeindex/codeindex.mjs arch            # module dependency map (from -> to, weighted)
node ~/.claude/codeindex/codeindex.mjs flow <module>   # up/downstream of a module

node ~/.claude/codeindex/codeindex.mjs index           # incremental reindex (after creating files this session)
node ~/.claude/codeindex/codeindex.mjs stats           # files, symbols, edges, freshness
```

**HOW TO OBEY — CodeIndex is the DEFAULT first move; use it ALWAYS when it can possibly help.** Before any Read/Grep/Glob/Bash-search or spawning a search agent, ask "could CodeIndex answer this?" — if yes, run it FIRST, every time, no exceptions. This is not a fallback or a "when convenient" tool; it is the standing first step for code navigation. query CodeIndex FIRST, don't read/grep/search blind. Any time the task involves finding WHERE code lives (a function, class, method, export, constant — even "explain how X works", "where is X handled", "fix the bug in Y"), run the index BEFORE Read/Grep/Glob or spawning a search agent. Reading whole files to hunt a symbol when the index already answers `file:line` is the wrong move. Flow: `where`/`grep` to get the exact `file:line` → then Read only that span. Skip the index ONLY when you already hold the exact `file:line` (e.g. just edited it) or you genuinely need the full file content (reading a README/config top-to-bottom, not locating a symbol).

**WHEN TO USE THE RELATIONAL THREAD.** Before changing or removing a symbol, run `callers <Name>` to see the blast radius (who breaks if you touch it). To understand a new codebase's shape, run `arch` for the module map and `flow <module>` to see what a module depends on / who depends on it. To learn what a file pulls in before editing it, run `deps <file>`. This is the fast path to "how does this project work / what connects to what" — use it instead of reading many files to reconstruct the wiring by hand.

Gotchas: `grep` takes ONE pattern — no `\|` alternations; run it once per term. `where` is exact-match and falls back to suggesting `grep` when it misses. Output includes the symbol **kind** and the **doc-hint** (comment above the symbol), so you often don't need to open the file at all. The relational graph is deterministic (ctags + import/usage parsing): `import` edges resolved to local files and `callers` of uniquely-named symbols are exact; `uses`/`arch` edges are name-based heuristics, so in a monorepo where unrelated subprojects share common function names (`init`, `start`, `openDb`) a few cross-module edges may be noise — treat `arch`/`flow` as a strong hint, `where`/`callers` as ground truth.

Follow the `code-index` skill rules. If a just-created symbol is missing, run `index` to refresh.
