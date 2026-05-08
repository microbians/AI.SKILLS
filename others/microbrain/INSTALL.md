# Microbrain Plugin — Installation

Persistent SQLite memory system for OpenCode. Memories survive context compaction
and are available across sessions.

## Quick Install

### 1. Copy the plugin

```bash
cp plugins/microbrain.ts /path/to/project/.opencode/plugins/
```

### 2. Add dependency to .opencode/package.json

If the file exists, add the dependency. If not, create it:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.0",
    "node-llama-cpp": "^3.15.1"
  }
}
```

> `node-llama-cpp` is optional — only needed for LLM-based memory extraction
> during compaction. Without it, heuristic pattern matching is used instead.

### 3. (Optional) Download the LLM model

For richer automatic memory extraction during context compaction (~500MB):

```bash
mkdir -p /path/to/project/.opencode/models
cd /path/to/project/.opencode
npx huggingface-cli download Qwen/Qwen2.5-0.5B-Instruct-GGUF \
  qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --local-dir ./models \
  --local-dir-use-symlinks False
```

### 4. Restart OpenCode

The plugin loads automatically at startup. On the first session it will:

- Create `.opencode/memory.db` if it doesn't exist
- Register 3 custom tools: `memory_search`, `memory_save`, `memory_stats`
- Auto-load important memories at session start
- Auto-extract memories before context compaction

## What's Included

```
plugin-microbrain_3.0/
├── INSTALL.md            ← This file
├── plugins/
│   ├── microbrain.ts     ← The plugin (copy to .opencode/plugins/)
│   └── README.md         ← Documentation
└── package.json.example  ← Example .opencode/package.json
```

## Features

- **Auto-load**: 8 most important memories injected at session start
- **Auto-extract**: Memories extracted before context compaction (LLM or heuristic)
- **memory_search**: FTS5 full-text search with type/file/importance filters
- **memory_save**: Save learnings with validation and auto-deduplication
- **memory_stats**: Overview of stored knowledge

## Known Issues

### `[node-llama-cpp] load: control-looking token: 128247 '</s>' was not control-type`

This warning comes from the native C++ llama.cpp layer during model vocabulary
loading. It is a known issue with Qwen2.5-0.5B GGUF (and other models) where
the `</s>` token is marked as a normal token instead of a control token in the
model metadata. There are 16+ open issues about this in llama.cpp upstream.

**The warning is harmless** — it does not affect inference quality or memory
extraction. Setting `logLevel: "error"` alone does not suppress it because
the native C++ log bypasses the JS-level log filter in some code paths.

**Fix (already applied in this version):** `getLlama()` is called with
`logger: () => {}` to silence all native llama.cpp output. Microbrain does
not need to display LLM engine logs.

If you see this warning after installing, verify that `microbrain.ts` line ~324
reads:
```typescript
const llama = await getLlama({ logLevel: "error", logger: () => {} });
```

## Requirements

- OpenCode with plugin support
- Bun runtime (used by OpenCode internally)
- SQLite (via bun:sqlite, no external dependency)
- Node.js >= 18 (for LLM extraction only)
