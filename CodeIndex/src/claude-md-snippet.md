## Code symbol lookup (CodeIndex)

To locate WHERE a symbol (class, function, method, export) is defined or referenced, query the CodeIndex symbol index BEFORE reading files or spawning search agents. It answers `file:line` in milliseconds from a per-project SQLite index (auto-refreshed each session).

```bash
node ~/.claude/codeindex/codeindex.mjs where <Name>    # definitions -> file:line (kind)
node ~/.claude/codeindex/codeindex.mjs refs <Name>     # definitions + textual references
node ~/.claude/codeindex/codeindex.mjs file <path>     # symbols in one file
node ~/.claude/codeindex/codeindex.mjs grep <pattern>  # fuzzy symbol search
node ~/.claude/codeindex/codeindex.mjs index           # incremental reindex (after creating files this session)
```

Use it as a shortcut to skip the search phase, then Read the exact `file:line` it points to. Follow the `code-index` skill rules. If a just-created symbol is missing, run `index` to refresh.
