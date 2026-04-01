# The Secretary

AI-powered context persistence for Claude Code. Preserves conversation context, manages user memories, takes notes, and tracks reminders — all using a small local LLM (Qwen 2.5 3B).

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│  The Secretary                                        │
│                                                       │
│  Claude Code ──▶ Hooks ──▶ Local LLM + regex          │
│                                  │                    │
│                                  ▼                    │
│                            ┌───────────┐              │
│                            │ SQLite DB │              │
│                            │ summaries │              │
│                            │ memories  │              │
│                            │ notes     │              │
│                            │ reminders │              │
│                            └─────┬─────┘              │
│                                  │                    │
│             /clear ─────────────▶│                    │
│                                  ▼                    │
│                          Context injected             │
│                          into new session             │
│                                                       │
└───────────────────────────────────────────────────────┘
```

## Features

### Conversation Summarization (automatic)
Every 15 tool calls, the conversation is summarized by the local LLM and stored. On `/clear` or session restart, context is recovered automatically.

### User Memories
Permanent facts about the user, detected via regex on every tool call.

```
"Recuerda que soy developer senior"    →  💾 Memory saved
"Prefiero TypeScript"                   →  💾 Memory saved
"Olvida que soy developer"             →  🗑️ Memory deleted (LLM flexible matching)
```

### Notes
Project-scoped observations and info to keep track of.

```
"Toma nota: el API key expira en junio"  →  📝 Note saved
"Borra la nota del API key"              →  🗑️ Note deleted (LLM flexible matching)
```

### Reminders
Time-sensitive items with natural date parsing.

```
"Avísame el viernes que hay deploy"      →  ⏰ Reminder saved (due: 2026-04-04)
"Recuérdame mañana revisar los tests"    →  ⏰ Reminder saved (due: tomorrow)
"Ya hice el deploy"                      →  ✅ Reminder done (LLM flexible matching)
```

Supported date formats: "mañana", "pasado mañana", "el viernes", "en 3 días", "en 2 semanas", "el 15 de abril", "april 15", ISO dates.

## How it works

1. **PostToolUse hook** — On every tool call, scans user messages for secretary orders (remember/forget/note/reminder) via regex. Every N calls (default: 15), summarizes conversation via local LLM.
2. **PreCompact hook** — Forces a final summary before Claude's compaction, then blocks it and suggests `/clear`.
3. **SessionStart hook** — On `/clear`, `startup`, or `resume`, restores context:
   - **Overdue reminders** shown first (highest priority)
   - Consolidated conversation summary
   - User memories
   - Active notes
   - Upcoming reminders
4. **Stop hook** — Forces a final summary, then shuts down the LLM server.

### Flexible matching via LLM

Deletion and completion actions (forget memory, delete note, complete reminder) use the local LLM for flexible matching. This means:
- "olvida lo del mono" matches "[REMEMBER] El usuario es un mono"
- "forget about my favorite color" matches "[REMEMBER] El color favorito es naranja"
- "borra la nota del servidor" matches "[NOTE] el servidor de staging se cae los martes"

Cross-language matching works too (Spanish request → English memory, and vice versa).

### Data categories

| Category | `session_id` | Prefix | Persistence |
|----------|-------------|--------|-------------|
| Memories | `manual` | `[REMEMBER]` | Until explicitly forgotten |
| Notes | `notes` | `[NOTE]` | Until explicitly deleted |
| Reminders | `reminders` | `[REMINDER]` | Until done/cancelled |
| Summaries | UUID | (none) | Per-session, auto-managed |

## Requirements

- **macOS or Linux**
- **Node.js** ≥ 18
- **LLM backend**: MLX (recommended for Apple Silicon) or llama.cpp
- **~2GB disk space** for the model (GGUF path only)
- **Claude Code** CLI

### Installing a backend

```bash
# Apple Silicon (recommended)
pip install mlx-lm

# Any platform
brew install llama.cpp
```

## Installation

```bash
bash install.sh
```

The installer will:
1. Create `~/.claude/summarizer/` with all files
2. Install `better-sqlite3` dependency
3. Download the Qwen 2.5 3B model (if using llama.cpp)
4. Merge hooks into `~/.claude/settings.json`
5. Inject docs into `~/.claude/CLAUDE.md`
6. Start the LLM server and verify

For manual installation, see [INSTALL.md](INSTALL.md).

## Commands

```bash
# Force an immediate summary
node ~/.claude/summarizer/summarize.mjs force

# Inject arbitrary context
node ~/.claude/summarizer/summarize.mjs inject --text "your context here"

# Show everything: memories, notes, reminders, context
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/summarizer/summarize.mjs recall

# Show only notes
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/summarizer/summarize.mjs recall-notes

# Show only reminders
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/summarizer/summarize.mjs recall-reminders
```

## Configuration

Edit `~/.claude/summarizer/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `summarize_every_n` | `15` | Summarize every N tool calls |
| `min_new_chars` | `2000` | Minimum new content before summarizing |
| `max_summary_tokens` | `1500` | Max tokens for summary output |
| `llm_url` | `http://localhost:8922/v1/chat/completions` | OpenAI-compatible endpoint |
| `db_path` | `~/.claude/summarizer/summaries.db` | SQLite database path |

## Uninstalling

```bash
bash install.sh --uninstall
```

## Files

```
TheSecretary/
├── README.md           ← You are here
├── INSTALL.md          ← Manual installation guide
├── install.sh          ← Automatic installer/uninstaller
├── hooks.json          ← Hook definitions
└── src/
    ├── summarize.mjs   ← Main secretary script
    ├── start-llm.sh    ← LLM server manager
    ├── config.json     ← Default configuration
    ├── package.json    ← Node.js dependencies
    └── claude-md-snippet.md ← CLAUDE.md docs snippet
```

## Troubleshooting

**LLM server won't start:**
```bash
bash ~/.claude/summarizer/start-llm.sh start
cat /tmp/llama-summarizer.log
```

**No context after /clear:**
```bash
sqlite3 ~/.claude/summarizer/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"
curl http://localhost:8922/v1/models
```

**Hooks not firing:**
```bash
cat ~/.claude/settings.json | grep -A5 summarize
```

## License

MIT
