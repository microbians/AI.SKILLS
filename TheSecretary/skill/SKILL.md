---
name: the-secretary
description: AI-powered context persistence for Claude Code — keeps ONE flat index per project (no memory types) plus conversation summaries, via local LLM hooks and SQLite. Use whenever the user mentions remembering/forgetting something, taking notes, or asks recall questions ("recuerda que...", "olvida que...", "anota...", "borra la nota...", "avísame...", "recuérdame...", "cancela el recordatorio...", "qué recuerdas?", "muestra mis notas", "show my reminders", "remember that...", "forget...", "take note...", "remind me...", "do you remember...?"). Runs entirely in background via hooks; this skill defines the behavior rules and recall commands Claude must follow when interacting with it.
version: 2.0.0
updated: 2026-08-19
license: MIT
---

# The Secretary

A local-LLM secretary that auto-summarizes the conversation, captures anything the user asks to save via regex on every tool call, and injects context at session start. It runs entirely in background — Claude does not trigger it manually, but must follow the rules below when responding.

**One flat index, no memory types.** Facts, notes and reminders are not separate categories: every saved item is one row in the same index, stored under the `session_id` of the session that created it — exactly like an automatic summary. There is no due date, no status and no lifecycle.

## Behavior rules

- **DO NOT use Claude's built-in memory.** All persistence is The Secretary (summarizer hooks + SQLite per project at `<projectRoot>/.claude/the-secretary/summaries.db`; items marked "global" live in `~/.claude/the-secretary/summaries.db`).
- **Trust injected context.** When the user asks about previous sessions ("qué hicimos?", "última sesión", "what did we do?"), respond from the context already injected at session start — do not re-search files or run commands unless the context is missing.
- **Items under `## Saved items (NEVER ignore these)`** must always be respected.
- **When the user asks "qué recuerdas?", "muestra mis notas", "what do you remember"**: run the recall command below and show its output as the response.

## Recall commands (run on user request)

```bash
# The whole index (saved items + context):
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall

# Free-text search across cache + DB (on-demand):
node ~/.claude/the-secretary/summarize.mjs search "query"

# Force an immediate summary:
node ~/.claude/the-secretary/summarize.mjs force

# Inject arbitrary context:
node ~/.claude/the-secretary/summarize.mjs inject --text "your context here"
```

## Searching the memory (how to read the results)

`search` returns hits tagged by how they were found. The tag decides how much they prove:

- `[said]` / `[turn]` — **literal FTS5 match**. These words were actually written. This is
  evidence: use it to confirm something was really discussed.
- `[cache]` — an LLM-written summary. Paraphrased, so wording may differ from what was said.
- `[said~]` / `[turn~]` — **approximate (vector) match**, only shown when the literal pass
  found nothing. It means "similar wording exists", NOT "this was discussed". Never cite it
  as proof; quote it only as a lead, and say it is approximate.

**No results is a real answer.** FTS5 returning zero means the phrase is not in the memory —
report that plainly instead of reaching for a loose match.

## Triggers (auto-detected by hooks — Claude does not invoke these)

- **Save (all of these write ONE item into the index):** "Recuerda que..." / "Remember that..." / "Toma nota..." / "Anota..." / "Apunta..." / "Take note..." / "Avísame..." / "Recuérdame..." / "Pon un recordatorio..." / "Remind me..."
- **Forget:** "Olvida que..." / "Forget..." / "Borra la memoria de..." / "Borra la nota de..." / "Cancela el recordatorio de..." / "Ya hice..."
- **Recall (auto-injection):** "¿Recuerdas X?" / "Te acuerdas de X?" / "Do you remember X?" / "Do you recall X?" / "Remember when X?"
- **Global modifier:** add the word "global" to make the item visible across all projects ("Anota global...", "Recuerda global...", "Avísame global...").

## Scope

By default saved items are **per-project**: stored in the project's own `<projectRoot>/.claude/the-secretary/` (DB + bullets cache), so memory travels with the folder if you copy it elsewhere. The "global" modifier makes items cross-project (stored in the global DB). Items appear tagged `[global]` when shown.

## Configuration

`~/.claude/the-secretary/config.json`:
- `summarize_every_n` (default: 15) — tool calls between auto-summaries
- `min_new_chars` (default: 2000) — minimum new content before summarizing
- `max_summary_tokens` (default: 1500) — max tokens per summary

## Status check (debugging)

```bash
curl -s http://localhost:8922/v1/models | head -1
sqlite3 <projectRoot>/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"   # project data
sqlite3 ~/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"              # global items
```
