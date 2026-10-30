---
name: secretary
description: AI-powered context persistence for Claude Code — keeps ONE flat index per project (no memory types) plus conversation summaries, via local LLM hooks and SQLite. Use whenever the user mentions remembering/forgetting something, taking notes, or asks recall questions ("recuerda que...", "olvida que...", "anota...", "borra la nota...", "avísame...", "recuérdame...", "cancela el recordatorio...", "qué recuerdas?", "muestra mis notas", "show my reminders", "remember that...", "forget...", "take note...", "remind me...", "do you remember...?"). Runs entirely in background via hooks; this skill defines the behavior rules and recall commands Claude must follow when interacting with it.
argument-hint: "[ai [local | apple | claude [model] [--account <name | email | folder>]]]"
version: 2.15.0
updated: 2026-10-17
license: MIT
---

# The Secretary

A local-LLM secretary that auto-summarizes the conversation, captures anything the user asks to save via regex on every tool call, and injects context at session start. It runs entirely in background — Claude does not trigger it manually, but must follow the rules below when responding.

**One flat index, no memory types.** Facts, notes and reminders are not separate categories: every saved item is one row in the same index, stored under the `session_id` of the session that created it — exactly like an automatic summary. There is no due date, no status and no lifecycle.

## Behavior rules

- **DO NOT use Claude's built-in memory.** All persistence is The Secretary (summarizer hooks + SQLite per project at `<projectRoot>/.claude/the-secretary/summaries.db`; items marked "global" live in `~/.claude/the-secretary/summaries.db`).
- **Trust injected context.** When the user asks about previous sessions ("qué hicimos?", "última sesión", "por dónde vamos?", "dónde lo dejamos?", "what did we do?", "where were we?"), respond from the context already injected at session start (the full persisted file when the preview is truncated) — do not re-search files or run commands (`git status`, grep) unless the context is missing.
- **Project first.** "Por dónde vamos" is about the PROJECT. Answer from the latest handoff with project work; anything outside the project (shell config, Claude/tooling setup, accounts, other folders — the `↪ Outside the project` section, `OFF-PROJECT:` lines) gets at most one short line at the end. A search whose hits are off-project is not an answer: look for the project's work.
- **Previous session still being summarized.** After a `/clear`, the previous session's closing summary can still be running when the new session starts, so the context injected at startup is older than it should be. While it runs, every prompt receives `## ⏳ The Secretary: el resumen de la sesión anterior todavía se está generando` with an `await-handoff` command: launch it at once with Bash `run_in_background: true`. It exits when the summary lands and prints it as `## 📥 The Secretary: contexto nuevo disponible`; its completion notice is the signal. If the request depends on the previous session ("por dónde vamos", "sigue con…"), tell the user in one line that you are waiting for it and answer when the notice arrives — never from the stale context. Only the previous session of the same terminal and project counts: another Claude session open on the same project never triggers it. Right after a `/clear` the same wait also runs on its own as an async SessionStart hook: when the summary lands it wakes you with `## 📥 The Secretary: contexto nuevo disponible` before the user has typed anything — tell them in one or two lines where the previous session left off.
- **Items under `## Saved items (NEVER ignore these)`** must always be respected.
- **When the user asks "qué recuerdas?", "muestra mis notas", "what do you remember"**: run the recall command below and show its output as the response.
- **`/secretary ai [args]`** (or "qué IA usa el secretary", "cambia el secretary a apple/claude/local"): run `node ~/.claude/the-secretary/summarize.mjs backend [args]` and reply with its output line only. Args: none (show current) | `local` | `apple` | `claude [model] [--account <name | email | folder>]`.

## Recall commands (run on user request)

```bash
# The whole index (saved items + context):
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall

# Free-text search across cache + DB (on-demand):
node ~/.claude/the-secretary/summarize.mjs search "query"

# Re-read every transcript still on disk into the index (fills gaps, idempotent):
node ~/.claude/the-secretary/summarize.mjs index-turns --rebuild

# Force an immediate summary:
node ~/.claude/the-secretary/summarize.mjs force

# Inject arbitrary context:
node ~/.claude/the-secretary/summarize.mjs inject --text "your context here"
```

## Searching the memory (how to read the results)

**Dates narrow the search.** A date in the query limits it to that span (local time):
"hoy", "ayer", "anteayer", "el martes (pasado)", "la semana pasada", "esta semana", "este mes",
"el mes pasado", "hace 3 días", "los últimos 5 días", "el 5 de octubre", "en octubre", "28/10",
"2026-10-28", and the English forms ("yesterday", "last tuesday", "2 days ago"…). The other
words are what is searched: `search "microproxy ayer"` = microproxy, only yesterday. A query
that is only a date (`search "qué hicimos el lunes"`) returns that span's session handoffs.
No result for a date means nothing was recorded in this project that day — say so.

`search` returns hits tagged by how they were found. The tag decides how much they prove:

- `[said]` / `[turn]` — **literal FTS5 match**. These words were actually written. This is
  evidence: use it to confirm something was really discussed.
- `[cache]` — an LLM-written summary. Paraphrased, so wording may differ from what was said.
- `[said~]` / `[turn~]` — **approximate (vector) match**: found by meaning, not by words. It
  means "similar wording exists", NOT "this was discussed". Never cite it as proof; quote it
  only as a lead, and say it is approximate.

**No literal results is a real answer.** No `[said]`/`[turn]` hit means the phrase is not in
the memory — report that plainly instead of passing a `~` hit off as a quote.

**The index is the whole conversation, verbatim.** Every user and assistant message of every
session is stored in full (in chunks), read straight from Claude Code's transcripts — it
outlives their 30-day cleanup. Before digging through `~/.claude/projects/*.jsonl` by hand,
search the index: it holds the same text and answers in milliseconds.

**Screenshots are kept.** An image pasted in a message is saved under
`<projectRoot>/.claude/the-secretary/images/` and the turn carries `[imagen: <path>]`. When a
hit shows one and the answer may be in the picture, open that path with Read.

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
- Which AI summarizes: `/secretary ai [local | apple | claude [model] [--account <name | email | folder>]]` (no argument shows the current one)

## Status check (debugging)

```bash
curl -s http://localhost:8922/v1/models | head -1
sqlite3 <projectRoot>/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"   # project data
sqlite3 ~/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"              # global items
```
