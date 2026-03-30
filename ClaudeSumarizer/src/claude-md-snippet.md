## ClaudeSumarizer (Local LLM Context Persistence)

A local LLM summarizer runs via Claude Code hooks to preserve conversation context across `/clear` and session restarts.

### How it works
- **PostToolUse hook** runs every 15 tool calls — summarizes the conversation transcript via a local Qwen 2.5 3B model and stores summaries in `~/.claude/summarizer/summaries.db`
- **SessionStart hook** (on `/clear`, `startup`, `resume`) — injects saved summaries as context into the new session
- **PreCompact hook** — blocks compaction and suggests `/clear` so local summaries are used instead
- **Stop hook** — shuts down the local LLM server when the session ends

### Important behaviors
- The summarizer is **automatic** — you don't need to do anything special, it runs in the background via hooks
- After `/clear`, previous context will appear as a `## Context from Previous Conversation` block — trust and use this context
- Summaries are per-session and per-project (stored in SQLite with `session_id` and `project_dir`)
- The local LLM server runs on `http://localhost:8922` — if it's not running, summarization silently skips

### Checking summarizer status
```bash
# Check if LLM server is running
curl -s http://localhost:8922/v1/models | head -1

# Check stored summaries for current project
sqlite3 ~/.claude/summarizer/summaries.db "SELECT COUNT(*), MAX(created_at) FROM summaries"

# Check tool call counter for current session
sqlite3 ~/.claude/summarizer/summaries.db "SELECT key, value FROM state WHERE key LIKE 'counter:%' ORDER BY updated_at DESC LIMIT 1"
```

### Configuration
Edit `~/.claude/summarizer/config.json` to change:
- `summarize_every_n` (default: 15) — how often to summarize
- `min_new_chars` (default: 2000) — minimum new content before summarizing
- `max_summary_tokens` (default: 1500) — max tokens per summary
