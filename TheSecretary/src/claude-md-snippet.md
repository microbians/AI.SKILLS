## The Secretary (AI-powered Context Persistence)

A local LLM-powered secretary that runs via Claude Code hooks to preserve conversation context, manage user memories, take notes, and track reminders.

### How it works
- **PostToolUse hook** runs on every tool call — detects secretary orders (remember/forget/note/reminder) via regex, and summarizes conversation every 15 calls via local LLM
- **SessionStart hook** (on `/clear`, `startup`, `resume`) — injects saved context, memories, notes, and pending reminders
- **PreCompact hook** — blocks compaction and suggests `/clear` so local summaries are used instead
- **Stop hook** — forces a final summary of unsummarized conversation, then shuts down the local LLM server

### User memories ("Recuerda que..." / "Olvida que...")
**To remember (permanent facts):**
- "Recuerda que soy X" / "Remember that I am X"
- "Soy un..." / "I am a..." / "Mi nombre es..." / "My name is..."
- "Prefiero..." / "I prefer..."

**To forget:**
- "Olvida que soy X" / "Forget that I am X"
- "Borra la memoria de..." / "Delete memory of..."

### Notes ("Toma nota..." / "Anota...")
**To save a note:**
- "Toma nota: ..." / "Take note: ..." / "Anota: ..." / "Apunta: ..."
- "Nota: ..." / "Note: ..."

**To delete a note:**
- "Borra la nota de..." / "Delete the note about..."

### Reminders ("Avísame..." / "Recuérdame...")
**To set a reminder:**
- "Avísame el viernes que..." / "Remind me on Friday to..."
- "Recuérdame mañana..." / "Remind me tomorrow..."
- "Pon un recordatorio: ..." / "Set a reminder: ..."

**To complete/cancel a reminder:**
- "Ya hice el deploy" / "Mark done..."
- "Cancela el recordatorio de..." / "Cancel the reminder about..."

Reminders support natural date parsing: "mañana", "el viernes", "en 3 días", "el 15 de abril", ISO dates. Reminders without dates are shown as "undated". Overdue reminders are shown prominently at session start.

### How context is restored (on `/clear`, `startup`, `resume`)
1. **Overdue/today reminders** shown first (highest priority)
2. Consolidated conversation summary from recent sessions
3. User memories
4. Active notes
5. Upcoming reminders (next 7 days)

### Commands
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

**When user asks "qué recuerdas?", "muestra mis notas", "show my reminders", etc.** — run the appropriate `recall` command and show the output as your response.

### Important behaviors
- The secretary is **automatic** — it runs in the background via hooks
- All orders (remember, forget, note, reminder) are detected via regex on every tool call
- Deletion/completion actions use the local LLM for flexible matching (understands variations and bilingual phrasing)
- After `/clear`, previous context appears as injected sections — trust and use this context
- User memories appear as `## User Memories (NEVER ignore these)` — always respect these
- Data is per-project (stored in SQLite with `session_id` and `project_dir`)

### Checking status
```bash
curl -s http://localhost:8922/v1/models | head -1
sqlite3 ~/.claude/summarizer/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"
```

### Configuration
Edit `~/.claude/summarizer/config.json`:
- `summarize_every_n` (default: 15) — how often to summarize
- `min_new_chars` (default: 2000) — minimum new content before summarizing
- `max_summary_tokens` (default: 1500) — max tokens per summary
