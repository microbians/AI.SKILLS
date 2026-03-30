# ClaudeSumarizer

Local LLM-powered conversation summarizer for Claude Code. Preserves context across `/clear` and session restarts using a small local model (Qwen 2.5 3B).

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ClaudeSumarizer                                             │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐      │
│  │              │  │              │  │                │      │
│  │  Claude      │  │  Hooks fire  │  │  Local LLM     │      │
│  │  Code        ├──▶  on events   ├──▶  summarizes    │      │
│  │              │  │              │  │                │      │
│  └──────────────┘  └──────────────┘  └───────┬────────┘      │
│                                              │               │
│                                              │               │
│                                              ▼               │
│                                     ┌────────────────┐       │
│                                     │                │       │
│                                     │  SQLite DB     │       │
│                                     │  stores        │       │
│                                     │  summaries     │       │
│                                     │                │       │
│                                     └───────┬────────┘       │
│                                             │                │
│                      /clear ───────────────▶│                │
│                                             │                │
│                                             ▼                │
│                                     ┌────────────────┐       │
│                                     │                │       │
│                                     │  Context       │       │
│                                     │  injected into │       │
│                                     │  new session   │       │
│                                     │                │       │
│                                     └────────────────┘       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## How it works

1. **PostToolUse hook** — Every N tool calls (default: 15), parses the conversation transcript and sends it to a local LLM for summarization. Summaries are stored in SQLite.
2. **PreCompact hook** — When Claude Code is about to compact context, warns the user and suggests `/clear` to use local summaries instead.
3. **SessionStart hook** — On `/clear`, `startup`, or `resume`, injects saved summaries as context so the conversation can continue seamlessly.
4. **Stop hook** — Shuts down the local LLM server when the session ends.

## Requirements

- **macOS or Linux** (tested on macOS)
- **Node.js** ≥ 18
- **llama-server** (from [llama.cpp](https://github.com/ggerganov/llama.cpp)) — must be in PATH
- **~2GB disk space** for the GGUF model
- **Claude Code** CLI installed and working

### Installing llama-server

```bash
# macOS (Homebrew)
brew install llama.cpp

# Linux — build from source
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && make -j$(nproc)
sudo cp build/bin/llama-server /usr/local/bin/
```

## Installation

### Automatic (recommended)

```bash
# From the ClaudeSumarizer directory:
bash install.sh
```

The installer will:
1. Create `~/.claude/summarizer/` with all necessary files
2. Install the `better-sqlite3` npm dependency
3. Download the Qwen 2.5 3B model (~2GB) if not already present
4. Merge hooks into your `~/.claude/settings.json` (preserving existing settings)
5. Start the LLM server and verify it works

### Manual

If you prefer manual installation, see [INSTALL.md](INSTALL.md).

## Configuration

Edit `~/.claude/summarizer/config.json`:

```json
{
  "llm_url": "http://localhost:8922/v1/chat/completions",
  "model": "qwen2.5-3b-instruct-q4_k_m.gguf",
  "summarize_every_n": 15,
  "min_new_chars": 2000,
  "max_summary_tokens": 1500,
  "db_path": "~/.claude/summarizer/summaries.db"
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `llm_url` | `http://localhost:8922/v1/chat/completions` | OpenAI-compatible endpoint |
| `model` | `qwen2.5-3b-instruct-q4_k_m.gguf` | Model name for the API request |
| `summarize_every_n` | `15` | Summarize every N tool calls |
| `min_new_chars` | `2000` | Minimum new content before summarizing |
| `max_summary_tokens` | `1500` | Max tokens for summary output |
| `db_path` | `~/.claude/summarizer/summaries.db` | SQLite database path |

### Using a different model

You can use any GGUF model. Place it in `~/.claude/summarizer/models/` and update both:
- `config.json` → `model` field
- `start-llm.sh` → `MODEL` variable

### Using a remote LLM

If you have an OpenAI-compatible API running elsewhere, just change `llm_url` in `config.json`. You can disable the local llama-server by removing the `bash start-llm.sh start` parts from the hooks in `~/.claude/settings.json`.

## Uninstalling

```bash
bash install.sh --uninstall
```

This removes hooks from `settings.json`, stops the LLM server, and deletes `~/.claude/summarizer/`.

## Files

```
ClaudeSumarizer/
├── README.md           ← You are here
├── INSTALL.md          ← Manual installation guide
├── install.sh          ← Automatic installer/uninstaller
├── src/
│   ├── summarize.mjs   ← Main summarizer script
│   ├── start-llm.sh    ← LLM server manager
│   ├── config.json     ← Default configuration
│   └── package.json    ← Node.js dependencies
└── hooks.json          ← Hook definitions (merged into settings.json)
```

## Troubleshooting

**LLM server won't start:**
```bash
# Check if llama-server is installed
which llama-server

# Check logs
cat /tmp/llama-summarizer.log

# Manual start for debugging
bash ~/.claude/summarizer/start-llm.sh start
```

**No summaries after /clear:**
```bash
# Check if summaries exist
sqlite3 ~/.claude/summarizer/summaries.db "SELECT COUNT(*) FROM summaries"

# Check LLM is responding
curl http://localhost:8922/v1/models
```

**Hooks not firing:**
```bash
# Verify hooks in settings
cat ~/.claude/settings.json | grep -A5 summarizer
```

## License

MIT
