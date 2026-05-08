---
name: the-secretary
description: AI-powered context persistence for Claude Code — manages user memories, notes, reminders, and conversation summaries via local LLM hooks and SQLite. Use whenever the user mentions remembering/forgetting facts, taking notes, setting reminders, or asks recall questions ("recuerda que...", "olvida que...", "anota...", "borra la nota...", "avísame...", "recuérdame...", "cancela el recordatorio...", "qué recuerdas?", "muestra mis notas", "show my reminders", "remember that...", "forget...", "take note...", "remind me...", "do you remember...?"). Runs entirely in background via hooks; this skill defines the behavior rules and recall commands Claude must follow when interacting with it.
license: MIT
---

# The Secretary

A local-LLM secretary that auto-summarizes the conversation, captures user memories/notes/reminders via regex on every tool call, and injects context at session start. It runs entirely in background — Claude does not trigger it manually, but must follow the rules below when responding.

## Behavior rules

- **DO NOT use Claude's built-in memory.** All persistence is The Secretary (summarizer hooks + SQLite at `~/.claude/the-secretary/summaries.db`).
- **Trust injected context.** When the user asks about previous sessions ("qué hicimos?", "última sesión", "what did we do?"), respond from the context already injected at session start — do not re-search files or run commands unless the context is missing.
- **Memories under `## User Memories (NEVER ignore these)`** must always be respected.
- **When the user asks "qué recuerdas?", "muestra mis notas", "show my reminders", "what do you remember"**: run the matching recall command below and show its output as the response.

## Recall commands (run on user request)

```bash
# All memories + notes + reminders + context:
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall

# Only notes:
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall-notes

# Only reminders:
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall-reminders

# Free-text search across cache + DB (on-demand):
node ~/.claude/the-secretary/summarize.mjs search "query"

# Force an immediate summary:
node ~/.claude/the-secretary/summarize.mjs force

# Inject arbitrary context:
node ~/.claude/the-secretary/summarize.mjs inject --text "your context here"
```

## Triggers (auto-detected by hooks — Claude does not invoke these)

- **Memories:** "Recuerda que..." / "Remember that..." / "Olvida que..." / "Forget..." / "Borra la memoria de..."
- **Notes:** "Toma nota..." / "Anota..." / "Apunta..." / "Take note..." / "Borra la nota de..." / "Delete the note about..."
- **Reminders:** "Avísame..." / "Recuérdame..." / "Pon un recordatorio..." / "Remind me..." / "Cancela el recordatorio de..." / "Mark done..."
- **Recall (auto-injection):** "¿Recuerdas X?" / "Te acuerdas de X?" / "Do you remember X?" / "Do you recall X?" / "Remember when X?"
- **Global modifier:** add the word "global" to make the item visible across all projects ("Anota global...", "Recuerda global...", "Avísame global...").

Reminders parse natural dates: "mañana", "el viernes", "en 3 días", "el 15 de abril", ISO dates. Reminders without a date are stored as "undated". Overdue reminders are surfaced first at session start.

## Scope

By default memories/notes/reminders are **per-project** (scoped to `cwd`). The "global" modifier makes them cross-project. Items appear tagged `[global]` when shown.

## Configuration

`~/.claude/the-secretary/config.json`:
- `summarize_every_n` (default: 15) — tool calls between auto-summaries
- `min_new_chars` (default: 2000) — minimum new content before summarizing
- `max_summary_tokens` (default: 1500) — max tokens per summary

## Status check (debugging)

```bash
curl -s http://localhost:8922/v1/models | head -1
sqlite3 ~/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"
```
