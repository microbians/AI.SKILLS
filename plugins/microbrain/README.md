# Microbrain -- Persistent Memory Plugin

Reactive SQLite memory system for AI coding agents. Memories survive context compaction and are available across sessions.

```
┌───────────────────────────────────────────────────────────────┐
│                     MICROBRAIN ARCHITECTURE                    │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  PLUGIN (.opencode/plugins/microbrain.ts)                     │
│  +── session.created  → auto-load high-importance memories    │
│  +── session.compacting → extract + save (LLM/heuristic)     │
│  +── registers custom tools:                                  │
│      +── memory_search  → FTS5 full-text search               │
│      +── memory_save    → insert/update with validation       │
│      +── memory_delete  → delete memories by ID               │
│      +── memory_stats   → overview of stored knowledge        │
│                                                               │
│  STORAGE                                                      │
│  +── .opencode/memory.db (SQLite + FTS5)                      │
│                                                               │
│  OPTIONAL LLM                                                 │
│  +── .opencode/models/qwen2.5-0.5b-instruct-q4_k_m.gguf      │
│      (used for extraction on compaction, ~500MB)              │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## How it works

### Automatic behaviors (no agent action needed)

- **Session start:** Loads the 8 most important memories (importance >= 4) and injects them as context
- **Context compaction:** Extracts learnings from the conversation (via local LLM or heuristic fallback) and saves them to SQLite before context is compacted

### Custom tools (agent calls when needed)

```
┌─────────────────┬─────────────────────────────────────────────┐
│  Tool           │  Description                                │
├─────────────────┼─────────────────────────────────────────────┤
│  memory_search  │  FTS5 full-text search by type/file/score   │
│  memory_save    │  Save learning, auto-dedup by subject       │
│  memory_delete  │  Delete one or more memories by ID          │
│  memory_stats   │  Count by type, importance, recent entries  │
└─────────────────┴─────────────────────────────────────────────┘
```

## Memory types

```
┌──────────────┬────────────────────────────────────────────────┐
│  Type        │  Purpose                                       │
├──────────────┼────────────────────────────────────────────────┤
│  error       │  Bugs + solutions                              │
│  api         │  Correct API usage                             │
│  decision    │  Design choices                                │
│  pattern     │  Code patterns / best practices                │
│  context     │  File/module purpose                           │
│  preference  │  User preferences                              │
└──────────────┴────────────────────────────────────────────────┘
```

## Quick install

```bash
# 1. Copy plugin
cp plugins/microbrain.ts /path/to/project/.opencode/plugins/

# 2. Add dependencies to .opencode/package.json
cat > /path/to/project/.opencode/package.json << 'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.0",
    "node-llama-cpp": "^3.15.1"
  }
}
EOF

# 3. (Optional) Download LLM model for richer extraction (~500MB)
cd /path/to/project/.opencode
npx huggingface-cli download Qwen/Qwen2.5-0.5B-Instruct-GGUF \
  qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --local-dir ./models --local-dir-use-symlinks False
```

> `node-llama-cpp` is optional. Without it, heuristic pattern matching is used instead.

See [INSTALL.md](INSTALL.md) for full installation details and troubleshooting.

## Files

```
plugins/microbrain/
+── README.md               ← This file
+── INSTALL.md              ← Full installation guide
+── package.json.example    ← Example .opencode/package.json
+── plugins/
    +── microbrain.ts       ← The plugin (copy to .opencode/plugins/)
    +── README.md           ← Technical reference docs
```

## Requirements

- OpenCode with plugin support
- Bun runtime (used by OpenCode internally)
- SQLite (via bun:sqlite, no external dependency)
- Node.js >= 18 (for LLM extraction only)

## License

MIT
