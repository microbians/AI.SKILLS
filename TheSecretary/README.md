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
"Remember that I prefer TypeScript"     →  Memory saved
"I use neovim as my editor"             →  Memory saved
"Forget about my editor"                →  Memory deleted (LLM matching)
```

### Notes
Project-scoped observations and info to keep track of.

```
"Note: the staging API key expires in June"  →  Note saved
"Delete the note about the API key"          →  Note deleted (LLM matching)
```

### Reminders
Time-sensitive items with natural date parsing.

```
"Remind me on Friday about the deploy"   →  Reminder saved (due: Friday)
"Remind me tomorrow to review the tests" →  Reminder saved (due: tomorrow)
"The deploy is done"                     →  Reminder done (LLM matching)
```

Supports bilingual date parsing (English and Spanish): "tomorrow", "next friday", "in 3 days", "in 2 weeks", "april 15", ISO dates, "mañana", "el viernes", etc.

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
- "forget about my editor" matches "[REMEMBER] I use neovim as my editor"
- "delete the note about staging" matches "[NOTE] staging server goes down on Tuesdays"
- "the deploy is done" matches "[REMINDER] deploy to production on Friday"

Cross-language matching works too (Spanish request matches English memory, and vice versa).

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
