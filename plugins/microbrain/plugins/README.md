# Microbrain — Persistent Memory Plugin

Reactive SQLite memory system that persists knowledge across sessions.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      MICROBRAIN ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PLUGIN (.opencode/plugins/microbrain.ts)                           │
│  ├── session.created  → auto-load high-importance memories          │
│  ├── session.compacting → extract + save memories (LLM/heuristic)   │
│  └── registers custom tools:                                        │
│      ├── memory_search  → FTS5 full-text search                     │
│      ├── memory_save    → insert/update with validation             │
│      ├── memory_delete  → delete memories by ID                     │
│      └── memory_stats   → overview of stored knowledge              │
│                                                                     │
│  STORAGE                                                            │
│  └── .opencode/memory.db (SQLite + FTS5)                            │
│                                                                     │
│  OPTIONAL LLM                                                       │
│  └── .opencode/models/qwen2.5-0.5b-instruct-q4_k_m.gguf             │
│      (used for extraction on compaction, ~500MB)                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## How It Works

### Automatic Behaviors (no agent action needed)

- **Session start**: Plugin loads the 8 most important memories (importance >= 4) and injects them as context into the session.
- **Context compaction**: Plugin extracts learnings from the conversation (via local LLM or heuristic fallback) and saves them to SQLite before the context is compacted.

### Custom Tools (agent calls when needed)

| Tool | Description |
|------|-------------|
| `memory_search` | FTS5 full-text search. Filter by type, file, importance. |
| `memory_save` | Save a learning. Auto-deduplicates (updates if subject matches). |
| `memory_delete` | Delete one or more memories by ID. |
| `memory_stats` | Overview: total count, by type/importance, recent entries. |

## Memory Types

| Type | Purpose |
|------|---------|
| `error` | Bugs + solutions |
| `api` | Correct API usage |
| `decision` | Design choices |
| `pattern` | Code patterns / best practices |
| `context` | File/module purpose |
| `preference` | User preferences |

## Importance Levels

| Level | Meaning |
|-------|---------|
| 5 | Critical (breaking bugs, core architecture) |
| 4 | High (common errors, important patterns) |
| 3 | Normal (default) |
| 2 | Low (minor details) |
| 1 | Trivial |

## Files

```
.opencode/
├── plugins/
│   ├── microbrain.ts     ← Plugin (loaded by OpenCode at startup)
│   └── README.md         ← This file
├── models/
│   └── qwen2.5-0.5b-instruct-q4_k_m.gguf  ← Optional LLM (~500MB)
├── memory.db             ← SQLite database (auto-created)
└── package.json          ← Dependencies (node-llama-cpp, @opencode-ai/plugin)
```

## Maintenance

```bash
# Backup
cp .opencode/memory.db .opencode/memory.db.backup

# Verify integrity
sqlite3 .opencode/memory.db "PRAGMA integrity_check"

# Rebuild FTS index
sqlite3 .opencode/memory.db "INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"

# Statistics
sqlite3 .opencode/memory.db "SELECT type, COUNT(*) FROM memories GROUP BY type ORDER BY COUNT(*) DESC"
```

## Installing the LLM model (optional)

The LLM is used for richer memory extraction during compaction. Without it, heuristic pattern matching is used instead.

```bash
cd .opencode
npx huggingface-cli download Qwen/Qwen2.5-0.5B-Instruct-GGUF qwen2.5-0.5b-instruct-q4_k_m.gguf --local-dir ./models --local-dir-use-symlinks False
```

## Known Issues

### Control token warning during model load

The Qwen2.5-0.5B GGUF model produces this warning during loading:

```
[node-llama-cpp] load: control-looking token: 128247 '</s>' was not control-type;
this is probably a bug in the model. its type will be overridden
```

This is a known upstream issue in llama.cpp (16+ issues reported). The `</s>`
token is incorrectly marked as a normal token instead of a control token in the
model's GGUF metadata. **It is harmless and does not affect inference.**

`logLevel: "error"` alone does not suppress it because the native C++ log
bypasses the JS-level filter in node-llama-cpp for certain load-time messages.
The fix is to pass a no-op logger: `getLlama({ logLevel: "error", logger: () => {} })`.
