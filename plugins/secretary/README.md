# The Secretary

AI-powered context persistence for Claude Code. Stores **every conversation verbatim** (read from Claude Code's own transcripts, screenshots included, kept beyond their 30-day cleanup), searchable by words and by meaning, and keeps **one flat index** of everything worth remembering plus LLM summaries on top — all local (summaries by gemma-4 / Qwen 2.5 auto-sized by RAM, vectors by Qwen3-Embedding). Optional `claude_cli` provider available for users with a Claude Max subscription.

There are **no memory types**: a fact, a note and a reminder are all the same thing — one item in the session's index.

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
│                            │ one index │              │
│                            │ per       │              │
│                            │ session   │              │
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

### Per-project storage (memory travels with the folder)

Each project stores its own database and bullets cache **inside the project** at `<projectRoot>/.claude/the-secretary/` (`summaries.db` + `bullets.md`). Copy or sync the project folder anywhere and its memory goes with it — the next session in the copied folder restores the same context.

- The project root is resolved from the filesystem: climb the cwd's ancestors until a generic container folder (`Code`, `Programacion`, `Documents`, home, …). An ancestor that already holds `.claude/the-secretary/` data (or a plain `.claude/` dir) anchors the root, so sessions opened in any subfolder share the same DB.
- Only items explicitly marked **global** (`project_dir = '__global__'`) live in the shared DB at `~/.claude/the-secretary/summaries.db`. Every query reads project + global through a unified `all_items` view (the global DB is `ATTACH`ed to the project connection).
- **Automatic migration:** the first time a project DB is created, the project's rows are copied out of the old global DB (non-destructively — the global DB is left untouched). The legacy `bullets.md` under `~/.claude/the-secretary/cache/` is copied over the same way.
- **Never pushed by default:** the data dir is created with a self-ignoring `.gitignore` (`*`) inside, so no repo ever commits the memory — no per-project setup needed. To intentionally commit/share it, delete `<projectRoot>/.claude/the-secretary/.gitignore`.

### Conversation Summarization (automatic)
Every 15 tool calls, the conversation is summarized by the local LLM and stored. On `/clear` or session restart, context is recovered automatically.

### Saved items (one flat index)

Anything the user asks to keep is written as one item into the current session's index, detected via regex on every tool call. There are no categories, no prefixes and no lifecycle — an item is stored under the `session_id` that created it, exactly like an automatic summary.

```
"Remember that I prefer TypeScript"          →  Saved
"I use neovim as my editor"                  →  Saved
"Note: the staging API key expires in June"  →  Saved
"Remind me on Friday about the deploy"       →  Saved
"Forget about my editor"                     →  Deleted (LLM matching)
"Delete the note about the API key"          →  Deleted (LLM matching)
```

Because everything lands in the same index, an item is found by searching for what it says — not by knowing which category it was filed under.


### Recall-on-demand (automatic)

When your prompt looks like a recall question, the Secretary automatically searches cached summaries and the SQLite history, and injects matching snippets as extra context before Claude replies. No need to run a command.

```
"¿Recuerdas el template 691?"          →  auto-search + inject
"Te acuerdas del bug del login?"       →  auto-search + inject
"Do you remember the aspect ratio fix?" →  auto-search + inject
"Do you recall that CSS issue?"         →  auto-search + inject
```

Triggers: `¿recuerdas?`, `te acuerdas?`, `do you remember`, `do you recall`, `remember when`.

How it works:
1. **UserPromptSubmit hook** detects a recall-style question.
2. Keywords are extracted from the prompt. A recall question is mostly filler (`qué hice hoy en X`), and scoring by raw term count lets that filler outrank the real subject — so an ES/EN **stopword list** is stripped first. If a query is *all* stopwords, the original tokens are used rather than returning nothing.
3. Search runs in three tiers, stopping once it has enough hits: per-project cache `.md` files (fast file-level grep) → **verbatim turns** (FTS5 and vectors, fused — see [Search](#search-literal-and-semantic-fused)) → the `summaries` table (`LIKE` fallback).
4. Top matches are printed to stdout and appear as injected context in Claude's next turn.

**Verbatim turn index (FTS5).** Summaries paraphrase — ask "what did I say about ffmpeg on Railway" and the summary only kept "discussed deployment". So every conversation turn is also stored verbatim in an FTS5 table, read straight from Claude Code's transcript by every hook (PostToolUse, Stop, PreCompact) and at SessionStart. This makes search flexible in three ways `LIKE` was not:

- **Accent- and case-insensitive** (`unicode61 remove_diacritics 2`) — `edicion` matches `edición`.
- **Partial matches instead of nothing** — terms are OR-ed with prefix wildcards, so an absent word no longer zeroes the result set; `bm25` ranks whatever matched most. The old `AND` chain returned 0 hits if any single term was missing.
- **Ranked by relevance**, not just recency.

Results are tagged `[said]` (your own words) or `[turn]` (assistant), so quoting yourself back is easy to spot.

Sessions that ended before the index existed can be backfilled from the transcripts on disk:

```bash
node ~/.claude/the-secretary/summarize.mjs index-turns            # only what is new
node ~/.claude/the-secretary/summarize.mjs index-turns --rebuild  # re-read every transcript from line 0
```

Run it from the project root; it reads `~/.claude/projects/<slug>/*.jsonl` for that project only. It is idempotent — re-running indexes just the new turns. `--rebuild` replaces the rows (and their vectors) of every session whose transcript is still on disk; sessions whose transcript Claude Code already deleted keep their rows, since the index is by then their only copy. (Reference: 14 sessions → 8,559 chunks in ~1.2s.)

### The transcript is the source of truth (v2.5.0)

The summaries are a layer on top; the verbatim index is the memory. Three things made it lossy before, all fixed:

- **Pure-chat turns were dropped.** The indexer was fed the messages the *summarizer* had not consumed yet, and the `Stop` hook — which fires after every reply — advanced that cursor without indexing. Any exchange with no tool call in between (a question and its answer) was skipped for good, and the next backfill could not recover it either, because its line guard had already moved past. On one real session 9 of 11 turns in a 7-minute stretch were missing, including the one the user later asked about. The index now reads the transcript from its **own cursor** (`fts-line:<session>`), independent of the summarizer, and every hook calls it.
- **Long turns were cut at 3000 chars.** Rows are now **800-char chunks** split at paragraph / line / sentence breaks, so nothing is lost and each chunk fits the embedder whole (its cap went from 512 to 1000 chars).
- **Screenshots vanished.** A pasted image lives in the transcript as base64; Claude Code's own copy sits in `/private/tmp` and dies with the session. It is now saved to `<projectRoot>/.claude/the-secretary/images/<sha1>.<ext>` (deduplicated by content) and the turn carries `[imagen: <path>]`, so a later session can open it. The answer to "which site did I show you?" was only in a screenshot.

Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`); the index keeps them for good.

For manual searches:

```bash
node ~/.claude/the-secretary/summarize.mjs search "template 691"
```

### Session handoff (resume next session without re-explaining)

When a Claude Code session ends, the **Stop hook** asks the local LLM to write a richer "handoff brief" instead of the regular incremental summary. The handoff is designed so the **next session can pick up the work without the user having to explain anything again**.

The brief includes (skipping any section that has nothing real to say):

- **What was accomplished** — concrete features/files/behaviors that now work.
- **Current state** — what's running, what's broken, what's untested.
- **Next step** — the single most likely first action when the user returns.
- **Open questions / decisions pending** — blockers awaiting user input.
- **Don't break / hard rules** — constraints the user repeated this session (backups, language rules, "never revert without permission", naming conventions…).
- **Backups** — paths of any backup folders created.
- **Key files touched** — paths + one-line summary per file.

**Accuracy rules.** A small local model asked to summarize will happily turn a search into an achievement — a session that only ran `grep X` gets written up as "implemented X", and the next session starts from a fiction. Every summarization prompt (incremental, handoff, pre-compact and the consolidation merge) therefore carries explicit accuracy constraints:

- Report only what literally happened — never infer, extrapolate, or fill gaps with plausible-sounding work.
- **Searching is not implementing.** A grep/read for symbol `X`, or confirming `X` is absent, must be written as "verified X does not exist", never as "added X".
- Failed, reverted or abandoned attempts are recorded *as* failures, never under "What was accomplished".
- Negative findings are preserved verbatim (not found, not working, still broken, **untested**).
- If the assistant corrected an earlier claim, the correction wins and the wrong claim is dropped.
- Never invent file paths, function names, versions or metrics absent from the conversation.
- On conflict between two summaries, the later one wins and the discrepancy is noted.

**Enough input to summarize (v2.3.2).** Accuracy rules only bind a model that has something to describe; starved of input it invents regardless. The handoff used to read the transcript from the *unprocessed offset* — the tail the incremental summarizer had not yet consumed — and at session close that is usually nothing. One real handoff was generated from a single 112-character line ("Commiteado en `main` como `08becc2`, working tree limpio") and, told to fill eight mandatory sections, produced a fluent brief about `src/controllers/userController.js`, `src/config.json` and a server on `localhost:3000` — none of which exist in this repo. That is worse than a corrupted summary: it reads as authoritative, so the next session acts on it.

Three changes, each covering a different part of the failure:

- **The handoff reads the whole session**, not the unprocessed tail (`parseTranscript(path, 0)` when `--stop-llm`), with a 16000-char budget so early turns stating the session's goal survive. Incremental summaries still use the offset. On the case above, the model's input went from 112 chars / 1 message to 15755 chars / 148 messages.
- **A floor of 600 chars** for handoffs specifically. Below it nothing is written: the reader falls back to older bullets, which are at least true. The incremental path keeps the 100-char bar — a thin chunk there is just a thin chunk, not a fabricated session state.
- **An explicit way out.** The prompt lets the model answer `NOTHING TO REPORT` when the transcript holds no real work, and a guard in `bgSummarize` discards that answer instead of storing it. Verified against the local model: the same 112-char input that produced the fiction now returns exactly `NOTHING TO REPORT`. The phrase also turns up *appended* to a perfectly good brief — a stray echo of the instruction, seen on a 208-message session — so the guard trims a trailing occurrence (markdown emphasis included) and only discards when it is the entire answer. A brief that merely quotes the phrase mid-text survives untouched.

**Repetition loops (v2.3.3).** The 4-bit local model sometimes falls into a repetition cycle and fills the whole token budget with it. Measured over the 29373 stored summaries, 304 of them (~1%) were degenerate; the SessionStart hook had been re-injecting one such handoff on every launch. Three gaps in the original detector, each found by measuring the stored rows rather than by inspection:

- **Local collapse.** A brief can be healthy prose that loops only in its last section, so whole-text variety stays respectable — the known-bad rows scored 0.13-0.20 unique/total words, inside the legitimate range that starts at 0.186, which is why a stricter global threshold would have deleted good summaries. A sliding 80-word window separates them cleanly instead: 0.66-0.81 on good output versus 0.04-0.10 on looping output.
- **Punctuation-only loops.** `:\n:\n:\n` and `：\n：\n` yield zero words, so every word ratio was skipped, and the period alternates so the exact-periodicity check missed it too. Character variety catches them (0.0007-0.004 unique chars).
- **Salvage over discard.** Degeneration usually strikes *after* a complete brief. `trimDegenerateTail` keeps the longest clean prefix and only discards when nothing above the 600-char floor survives — the same call the `NOTHING TO REPORT` guard makes. On the stored rows: 42 kept their brief, 262 were garbage throughout.

Why it happens: near-zero temperature always takes the most likely token, and after a repeated line the most likely continuation is that same line; 4-bit quantization sharpens the distributions further; and a 1500-token budget against output that really measures 460-921 chars leaves room the model fills by repeating. The penalties already sent (`repetition_penalty`, `frequency_penalty`) mitigate but do not eliminate it — their 256-token context is shorter than a loop of long lines. Retuning the sampling parameters was benchmarked against the live model (4 configurations, 24 generations, realistic 16000-char input) and produced zero degenerate outputs in *every* configuration including the current one, so at ~1% incidence the benchmark cannot show which is better; `temperature` and the penalties were left alone rather than changed on a guess.

The budget was cut, though, because that one is measurable. `max_summary_tokens` turned out to be **dead config** — nothing read it; every budget was hardcoded at the call site, so editing the JSON did nothing. It now feeds `callLLM`'s default and the summary/handoff call, and its value drops 1500 → 800. Verified against the live model: at 800 every generation ends with `finish_reason: stop` (the model closes on its own, the cap never truncates) at the same 746-827 chars it produced with 1500.

Also fixed a prompt tic that asked for "server URL" unconditionally, which made the model assert `http://localhost:3000` in projects that run no server — it appeared in 7 otherwise-legitimate stored handoffs. The line now says to mention a branch, URL or process *only if the conversation states it*.

**Invented file paths (v2.4.0).** The handoff kept naming files that were never touched — 26 fabricated paths across three real sessions, plus a `http://localhost:8000/` that no one had mentioned. The prompt already forbade it; the cause was that the model was never shown a single real path. `messagesToText` admits tool traffic *last*, after user and assistant turns, and on a real session there is nothing left for it: measured at the 8000-char budget, user turns took 315 chars and assistant turns 7665, leaving 20 — so **0 of 178 tool turns got in and the model saw zero file paths** while being told to quote exact ones. Given eight mandatory sections and no paths, it produced plausible ones: `src/models/gemini-3-pro-image.py` alongside `.js`, the same file in two languages, neither real.

Raising the budget does not fix it (assistant prose simply takes more: 16588 chars at a 32000 budget, still only 13 of 24 paths visible). Instead a **files-touched manifest** is built straight from the transcript's `tool_use` blocks and prefixed to the summarizer input as authoritative:

- The **verb comes from the tool**, never guessed — `Edit`/`Write`/`NotebookEdit` mean `changed`, `Read`/`Grep`/`Glob` mean `read`, and a write outranks an earlier read of the same file. This also enforces "searching is not implementing" structurally instead of by instruction.
- It costs ~300 chars for a whole session (two files, in the measured case) versus the 34669 chars of raw tool traffic it replaces, and it is **charged to the same budget** so a long file list cannot silently push out the conversation.
- Writes are listed first, and the block is capped at 1200 chars.
- Both prompts now state that when the input opens with a FILES TOUCHED list, that list is the only valid source of paths.

Verified end to end against the live model on a real transcript: invented files went **1 → 0** on the same session, and the two files it does name are exactly the two that were edited, each with the right description. Without the manifest that same run cited `CLAUDE.md` and `.gitignore`, neither of which the session touched.

**Model: gemma-4-26B-A4B (v2.4.0).** Benchmarked against the incumbent Qwen2.5-7B on The Secretary's own prompts, 5 rounds over 3 real transcripts: fabricated paths in handoffs 26 → 10, invented URLs 1 → 0, intent classification 60% → 90%, total time 49.2s → 52.6s (and *more* stable per summary: 7-10s versus the 7B's 5-13s). A MoE activates ~4B parameters per token, so 26B costs RAM (~14 GB), not speed; the `≥48 GB` tier picks it and smaller machines keep the 7B. Two things are mandatory for it:

- **`--chat-template-args '{"enable_thinking":false}'`.** Gemma-4's chat template emits a pre-closed thought channel only when thinking is off. Left on, the model spends the entire token budget in a `reasoning` field and returns no `content` at all — every summary came back empty, 10/10, which initially looked like the model being unusable.
- **`mlx_lm >= 0.31.3`.** 0.31.1 rejects the architecture outright with `Model type gemma4 not supported`; 0.31.3 ships `models/gemma4.py`.

Also fixed while measuring: `detectedModel` took `data[0]` from `/v1/models`, which lists the whole local cache alphabetically rather than the loaded model — so every request asked for `Qwen2.5-3B-Instruct-4bit` and `config.model` was silently ignored, whatever it said. Autodetection now only applies when the configured model is genuinely not served.

**Summaries that report nothing (v2.4.1).** Three rows landed in the DB in one afternoon, each a different wording of the same condition, each injected into the next session as if it were context:

- `Please provide the **CONVERSATION** text you would like me to summarize. I have noted your strict accuracy rules and the FILES TOUCHED list…` — the model asking for its own input.
- `Since no substantive coding activity occurred in the provided segment beyond a user greeting ("ok"), there are no decisions… **STATE:** Waiting for instructions.`
- `DECISIONS: - None made. CHANGES: - /proj/src/app.js: No changes. STATE: - Waiting for instructions.`

All three clear the 600-char floor and none matches `NOTHING TO REPORT`, so nothing caught them. The cause was structural: only the *handoff* prompt offered an explicit way out, so on a thin segment the incremental prompt left the model no option but to write prose *about* there being nothing to write.

Two changes, and deliberately not three more regexes — these were three phrasings of one condition in a single session, so matching phrasings is a losing game:

- **The incremental prompt gets the same way out** the handoff has, plus an explicit ban on the failure mode: no "None" sections, no "no substantive activity occurred", no "waiting for instructions", because those get stored and read back as context.
- **One `reportsNothing()` check for every summary** — summaries, handoffs, bullets and consolidation all go through `callLLMForSummary`, so one mechanism covers them instead of a guard per call site. It strips the scaffolding the prompt itself dictates (section headers, empty-value words, the clauses that frame the segment rather than the work) and measures what is left: under 60 chars of residue means nothing was reported. Verified against the live model on the input that produced the junk: `discarded LLM output (reports no content)`, 0 rows written; and against 11 stored cases, including a legitimate brief that opens `DECISIONS: - None made yet; the user is still choosing…`, which survives.
- **Short answers are not summaries (v2.9.8).** The check first lived in `callLLM` itself, which every generation passes through — including the ones whose answer is one line by design: the intent classifier (`SAVE|…`), the list of ids to forget, the notification blurb. Each of those leaves almost no residue, so the guard returned `''` and the caller fell back to "nothing matched" (13 of 20 intents came back `NONE` in a benchmark, every one of them a `SAVE` or `FORGET`). `callLLM` now only handles degenerate output; the "reports nothing" check sits in `callLLMForSummary`, and only prompts that ask for a summary call it.

A note on the debugging, because it cost a round: The Secretary writes to the **project-local** DB (`<project>/.claude/the-secretary/summaries.db`), not the global one. Checking the global DB showed "0 rows written" and the guard looked like it worked while the junk was being stored all along — a passing check against the wrong target is worse than no check.

Stored in the same `summaries` table tagged with a `[HANDOFF]` prefix. On the next `SessionStart`, **the most recent handoff for the current project is shown FIRST**, before the older bullet summaries, under a `📋 Session handoff — resume here` heading. The bullet cache stays available below as background.

This is additive — incremental summaries, memories, notes and reminders all keep working as before. The handoff is what the next session reads first; the rest is context.

#### Project-tree restore (matches the whole project, not the exact cwd)

A single project is saved under **many** `project_dir` values — a session indexes by whatever cwd it ran in, so summaries land under the project root *and* every subfolder a session happened to start in (`repo/`, `repo/apps/web/`, `repo/packages/...`). The Secretary keys purely on the cwd path; it has nothing to do with git.

If restore matched `project_dir = cwd` exactly, a session opened in one folder would never see context saved under a sibling or parent path — so it could surface a **stale** handoff while today's real work sat invisible under another prefix. To prevent this, the **project root is resolved from the filesystem** (see *Per-project storage* above): climb the cwd's ancestors until a generic container folder (`Code`, `Programacion`, `Documents`, `AI.SKILLS`, home, …; see `GENERIC_CONTAINERS` in `summarize.mjs`), anchoring on any ancestor that already holds secretary data or a `.claude/` dir. Every query then runs against that root's own DB — which contains the whole project tree — so a session sees the project's latest activity regardless of which subfolder it opened in: the handoff, the latest-N items, the conversation summaries, and the saved items. An item anchored to a project is visible from any of its subfolders but never leaks to a sibling project. `__global__` items are always included on top via the attached global DB.

#### Latest-N items (the literal "what just happened" view)

Right after the handoff, restore injects a `🕑 Latest N items in the DB (newest first)` block: the N most recent summaries across the whole project tree, ordered by `created_at DESC`, one compact line each. This is independent of session grouping or the bullet cache, so it can never go stale relative to a handoff written under a sibling path — it's the literal tail of the DB for this project. N defaults to `15` and is configurable via `restore_recent_items`.

### Fresh-context notice (late summaries after `/clear`)

If you hit `/clear` while the local LLM is still summarizing the previous session's tail, those new summaries land in the DB **after** SessionStart has already injected context — so Claude doesn't see them and the user has to prompt them manually.

The Secretary handles this automatically:

1. On restore, a watermark file is written to `~/.claude/the-secretary/watermarks/<session_id>.json` with `max(created_at)` of summaries visible at that moment.
2. On every user prompt, `UserPromptSubmit` checks if any summaries with `created_at > watermark` have appeared for the current project.
3. If so, a `📥 The Secretary: contexto nuevo disponible` block is injected into the conversation with the new content, and the watermark is advanced so the notice doesn't repeat.

The check is cheap (a single SQLite query per prompt) and fires only when there is genuinely new content to show. No-op for sessions that had nothing pending.

**Waiting for the handoff without a prompt (v2.8.0).** The notice above needs the user to type something first. On `/clear` an async SessionStart hook (`await-handoff --rewake`, `asyncRewake`) waits for the previous session's handoff worker instead, and when that worker exits it wakes Claude with what was stored — or with a one-line notice that the handoff added nothing, so every `/clear` ends with a visible answer. While it waits, the status line (`handoff-status`, [`statusline.json`](statusline.json)) adds `⏳ The Secretary: waiting for the previous handoff` plus a spinner, and drops it once it is done. If the user does type first, the prompt hook prints the pending notice together with the `await-handoff` command for Claude to run in the background.

### Context trim and the `secretary` launcher (v2.13.0)

Past `context_clear_tokens` the session transcript is trimmed in place to its last `trim_keep_tokens` (dropped lines go to `<transcript>.bak`). Claude Code cannot reload a running session's context, so the trim only takes effect when the session is reopened with `/resume <id>`, which the status line shows.

Start Claude with `secretary` instead of `claude` and that step is automatic. `secretary` takes every argument `claude` takes (account flags of your own `claude` wrapper included) and runs `claude` with them. When the context is past the threshold, the prompt you send trims the transcript, is held, and `secretary` stops `claude` and starts it again with the same arguments plus `--resume <id> "<prompt>"`: the session comes back short and your prompt is sent. The status line shows `↻ al enviar` instead of `/resume`. Pasted images in that one prompt are not carried over.

To try it without filling a large context, `secretary -limit 30k` (or `-limit 30`, always in thousands) sets that session's limit (`context_clear_tokens`; the warning goes to 75% of it and the kept tail to half). `-limit` is not passed to `claude`.

The status line starts with a small face and `Secretary`. The face blinks every few seconds and every two minutes plays a short gesture (surprise, laugh, frown, dizzy, goofy); every face is `( ∵E M E∵ )` with one narrow character per eye and mouth, so it is always 11 cells wide and the rest of the line never moves. A 16-cell bar spans the model's context window, with a mark at the clear limit. Then it shows the context against the clear limit (`56K/500K`), then the model and effort, the session cost, plan usage for 5 h and 7 days (amber from 75%, red from 90%), the minutes left on the prompt cache (`cache frío` in amber once it expired) and the account: `CLAUDE_PROFILE` when your launcher sets it, otherwise the user part of the account's email. Secretary's own notices (memory recovered on start, previous handoff included after `/clear`) appear at the end of the line for 15 s; there are no desktop notifications.

```
( ∵ᴖ ᴗ ᴖ∵ ) Secretary █░░░░░░░│░░░░░░░░   56K/500K · Opus 5.5 medium · $21.48 · 5h 12% 7d 78% · cache 41m · work
```

## How it works

1. **PostToolUse hook** — On every tool call, scans user messages for secretary orders (save / forget) via regex. Every N calls (default: 15), summarizes conversation via local LLM.
   - **Transcript extraction** — Summaries are built from Claude Code's own session transcript (`~/.claude/projects/<slug>/<session-id>.jsonl`), passed to the hook as `transcript_path`. Since that file is mostly tool traffic and attachments (a typical session: 1.3 MB raw, of which conversation is under 5%), the extractor filters before summarizing:
     - **Noise stripped** — slash-command plumbing (`<command-*>`, `<local-command-stdout>`), `<task-notification>`, `<system-reminder>`, interruption markers and image placeholders never reach the model. Bare acknowledgements (`ok`, `dale`, `sigue`, `thanks`) are dropped too.
     - **Budget by role** — user turns are admitted first, then assistant turns, and tool traffic only fills what is left over. Tool output can no longer crowd out what was actually said.
     - **Newest-first selection** — the budget is filled walking backwards from the end of the session, so the summary reflects the *current* state rather than the stale opening. The selected turns are re-emitted in chronological order.
2. **UserPromptSubmit hook** — On every user prompt, detects recall-style questions (`¿recuerdas?`, `do you remember`, etc.) and auto-injects matching snippets from cache + DB.
3. **PreCompact hook** — Indexes the pending turns and forces a final summary before Claude's compaction. The compaction itself still proceeds; when the session has summaries stored, the hook notes that `/clear` would load them instead.
4. **SessionStart hook** — On `/clear`, `startup`, or `resume`, restores context from the project's own DB (root resolved from the filesystem, so it matches the whole project tree, not just the exact cwd):
   - **Manually injected context** — items added with `inject` are printed **verbatim**, never LLM-consolidated: they are hand-curated, so paraphrasing them only loses detail
   - **Session handoff brief** (📋) from the previous session's Stop hook — the dense "how to resume" doc
   - **Handoffs from earlier sessions** — the 2 previous handoffs, truncated to 900 chars each. A handoff is the distilled state of an entire session, so restoring only the last one (`LIMIT 1`) discarded most of the project history; truncation keeps them from dwarfing the rest of the recall
   - **End of the previous conversation** (🧵, `/clear` only) — the verbatim tail of the session just left (`restore_tail_chars`, default 5000), always starting with its last user request; tool turns are cut to one line. A summary says what was done, only the raw end shows whether the last reply finished or broke off, so Claude is told to check it and offer to resume unfinished work. The previous session is the one recorded in this terminal's handoff lock
   - **Latest N items** (🕑) — the N most recent summaries across the project tree, newest-first (`restore_recent_items`, default 15)
   - Consolidated conversation summary (loaded from per-project cache — see below) as background
   - Saved items — one flat list, oldest first
5. **Stop hook** — Generates a session **handoff brief** (richer than the regular summary, structured so the next session can resume without explanation). The LLM server is shared by every session and is left running; `start-llm.sh`'s idle reaper stops it after `SECRETARY_LLM_IDLE_MIN` minutes (default 45) without use.

### Incremental bullets cache (per-project)

To keep SessionStart instant and avoid racing with still-running summarizers after `/clear`, each background summarization distills **3 terse one-line bullets** from the latest chunk summary and appends them to a per-project `bullets.md`. SessionStart just reads that file — no LLM call, no waiting.

- **Location:** `<projectRoot>/.claude/the-secretary/bullets.md` (travels with the project). Legacy caches under `~/.claude/the-secretary/cache/<project>-<hash8>/` are migrated automatically on first read.
- **Structure:** sections by session. Each section header is `## Session <id> (started <iso>)`, followed by bullets.
- **Per-session caps:** max **20 bullets** or **4000 chars**, FIFO when exceeded (oldest bullets drop first).
- **Global caps:** last **2 sessions** kept (current + previous); older sessions are discarded when a new one starts.
- **Dedup:** the LLM is told the existing bullets of the current session and asked to output only genuinely new info; exact duplicates are filtered on append.
- **Strictly per-project:** each `cwd` has its own `bullets.md`; content is never mixed across projects. Only items explicitly marked `global` cross project boundaries.
- **Bootstrap:** if `bullets.md` is missing but the DB has chunks, `SessionStart` falls back to raw concatenation for that one turn and spawns a background `_bg_regenerate` worker that distills the last session's chunks into bullets — so the next SessionStart hits the new format.
- **Non-blocking restore:** SessionStart never calls the LLM inline. The cache is ready because bullets were appended incrementally during the previous session, not generated at restore time.

### Background worker lock + debounce

PostToolUse fires on every tool call, which on slower machines (e.g. base M1) caused multiple `_bg_summarize` workers to pile up and saturate the neural engine. A lockfile at `/tmp/secretary-bg-<session>.lock` (PID + timestamp) ensures only one worker runs per session, and a 30s debounce window prevents back-to-back spawns even after the previous worker exits. The `--stop-llm` (Stop hook) path bypasses the debounce so the final summary always runs.

### Model auto-selection by RAM

`start-llm.sh` picks the MLX model based on total unified memory (`sysctl hw.memsize`):

| Unified memory | Model | RAM use | Notes |
|---|---|---|---|
| ≥ 48 GB | `mlx-community/gemma-4-26B-A4B-it-qat-4bit` | ~14 GB | fewest hallucinations; needs `mlx_lm >= 0.31.3` |
| 32 – 47 GB | `mlx-community/Qwen2.5-7B-Instruct-4bit` | ~4 GB | good accuracy/speed balance |
| 16 – 31 GB | `mlx-community/Qwen2.5-3B-Instruct-4bit` | ~2 GB | ~80 tok/s |
| < 16 GB | `mlx-community/Qwen2.5-1.5B-Instruct-4bit` | ~1 GB | fastest |

With `provider: claude_cli` no local model is loaded at all: `start-llm.sh start` exits without starting a server.

Override with env var `SECRETARY_MLX_MODEL=<repo>` (e.g. force 7B on a 16 GB machine if you have RAM headroom).

### Flexible matching via LLM

Deletion uses the local LLM for flexible matching against the index. This means:
- "forget about my editor" matches "I use neovim as my editor"
- "delete the note about staging" matches "staging server goes down on Tuesdays"
- "the deploy is done" matches "deploy to production on Friday"

Cross-language matching works too (Spanish request matches English memory, and vice versa).

### Data shape

One table, one shape. `session_id` is always the session that produced the row; `message_count` distinguishes an explicit item from an auto-generated summary.

| Kind | `session_id` | `message_count` | Persistence |
|------|-------------|-----------------|-------------|
| Saved item | session UUID | `0` | Until explicitly forgotten |
| Summary | session UUID | `> 0` | Per-session, auto-managed |

There are no type prefixes, no `due_at` and no `status` column.

## Search: literal and semantic, fused

**By date.** A date in the query limits every stage to that span of local time: `hoy`/`today`, `ayer`/`yesterday`, `anteayer`, `el martes (pasado)`/`last tuesday`, `la semana pasada`/`last week`, `esta semana`, `este mes`, `el mes pasado`, `hace 3 días`/`3 days ago`, `los últimos 5 días`/`last 5 days`, `el 5 de octubre`/`october 5`, `en octubre`/`in october`, `28/10`, `2026-10-28`. The remaining words are what is searched (`search "microproxy ayer"`). A query that is only a date (`search "qué hicimos el lunes"`) returns the session handoffs written that day, else its other summaries. The summaries cache has no per-entry dates, so a dated query skips it; vector hits are kept only when they fall in the span. A bare weekday word ("lunes") is not a date.

Two indexes, because they fail in opposite ways. Measured on a real 1.8k-turn project:

| Query kind | FTS5 | Vectors |
|---|---|---|
| a bare identifier (17 real occurrences) | finds all 17 | recovers **0** |
| a short keyword (52 occurrences) | finds all 52 | recovers **0** |
| literal recall overall | exact | **8%** |
| "espaciado vertical" → the turn saying *"les falta gap vertical"* | 0 hits (or 1000+ OR-noise) | **finds it** |

Until v2.4 vectors ran only when FTS5 came up short. On a 10k-turn index that never
happens: an OR query always fills every slot with rows that merely share a word, so the
semantic half never ran. Asked "the site I said was similar to X", it returned five rows
containing "similar" or "X" and never the one saying "a site like X". Both lists now run
on every search and are merged:

- **FTS5 order:** rows covering more *distinct* query terms first, `bm25` only breaking
  ties. `bm25` alone let a short row holding one filler word ("mentioned") outrank rows
  matching the real subjects.
- **Reciprocal rank fusion** (`1/(60+rank)` summed over both lists): a row that ranks
  well in both rises to the top.
- **Exact rows stay first.** A row holding *every* query term is the literal answer (an
  identifier, a quoted phrase); vectors recover ~0% of those, so no vector hit outranks it.
- A row found only by vectors is tagged `[said~]` / `[turn~]`. No `[said]`/`[turn]` hit
  still means the phrase is genuinely not in the memory.
- The query embedding costs ~1.8 s and runs only on recall-style prompts. It waits at
  most 2 s for the GPU lock (the prompt hook has a 10 s budget); if `index-vectors` holds
  it, the search returns the literal half instead of timing out with nothing.

**A vector hit is not evidence.** Calibrating the threshold showed real topics scoring
0.58–0.78 and *invented* ones 0.55–0.65 — the ranges overlap, so no cutoff separates them.
Anything a vector finds means "similar wording exists", never "this was discussed". Only
an FTS5 hit proves that. The old cutoff (0.62) made sense for a standalone fallback; fused,
the *rank* decides, and 0.62 threw real answers away — the turn a recall question was
about ranked 9th of 10k at 0.582. The floor is now 0.5 and only drops the plainly unrelated.

Set `SECRETARY_DEBUG=1` to print both lists and the fused order to stderr:

```bash
echo '{"prompt":"do you remember X?","cwd":"'$PWD'"}' | SECRETARY_DEBUG=1 node ~/.claude/the-secretary/summarize.mjs user-prompt
```

Both indexes refresh themselves: `SessionStart` runs `sync`, which spawns a detached
worker and returns in ~50 ms, so indexing never delays the prompt. The same per-project
lock as the other background workers keeps concurrent sessions from piling up. Manual
runs stay available:

```bash
node ~/.claude/the-secretary/summarize.mjs sync            # both indexes, in background
node ~/.claude/the-secretary/summarize.mjs index-turns     # verbatim FTS index (free, per project)
node ~/.claude/the-secretary/summarize.mjs index-vectors   # semantic index (optional, ~50s/2k turns)
```

Both commands are safe to re-run after an interruption: already-indexed turns are
skipped rather than re-embedded.

The semantic layer is **optional**. Without `sqlite-vec` and the embedding venv, search
silently stays on FTS5 — nothing breaks. Both indexes live inside the project's own
`summaries.db`, so they travel with the folder like the rest of the memory.

## Requirements

- **macOS or Linux**
- **Node.js** ≥ 18
- **LLM backend**: MLX (recommended for Apple Silicon) or llama.cpp
- **~1–15 GB disk space** for the model (auto-downloaded by MLX on first run, or GGUF path; ~15 GB is gemma-4-26B on machines with ≥ 48 GB). None with `provider: claude_cli`
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
1. Migrate any legacy install from `~/.claude/summarizer/` to `~/.claude/the-secretary/` (preserves DB, models, watermarks, cache)
2. Create `~/.claude/the-secretary/` with all files, and link the `secretary` launcher to `~/.local/bin/secretary` (that folder must be in your `PATH`)
3. Install the `secretary` skill at `~/.claude/skills/secretary/` (defines the behavior rules Claude must follow)
4. Install the `better-sqlite3` and `sqlite-vec` dependencies
5. Set up the summary model: MLX downloads the one sized to your machine on first run (see [Model auto-selection by RAM](#model-auto-selection-by-ram)); without MLX, the 3B GGUF for llama.cpp is downloaded now
6. Merge hooks into `~/.claude/settings.json` and set its `statusLine` (an existing status line of yours is kept)
7. Inject a pointer to the skill into `~/.claude/CLAUDE.md`
8. Start the LLM server and verify

Two steps stay manual (both in [INSTALL.md](INSTALL.md)):

- **Semantic index (optional):** create the embedding venv (`python3 -m venv ~/.claude/the-secretary/venv && ~/.claude/the-secretary/venv/bin/pip install mlx-embeddings numpy`). Without it search stays literal.
- **Backfill each project:** from each project root, `index-turns` then `index-vectors`. After that `SessionStart` keeps both indexes current.

**Upgrading from v2.4.x:** re-run `install.sh`, then once per project run `index-turns --rebuild` and `index-vectors`. That fills the gaps older versions left in the index (see [The transcript is the source of truth](#the-transcript-is-the-source-of-truth-v250) and [INSTALL.md → Upgrading](INSTALL.md#upgrading-from-v24x-to-v250)).

For manual installation, see [INSTALL.md](INSTALL.md).

## Commands

Switch the AI that writes the summaries from the chat with `/secretary ai`:

```
/secretary ai                                        # show the current one
/secretary ai local                                  # local MLX server
/secretary ai apple                                  # Apple's on-device model (apfel)
/secretary ai claude                                 # claude CLI with claude_model
/secretary ai claude sonnet --account work          # model + which account bills it
/secretary ai claude --account default               # the account with no CLAUDE_CONFIG_DIR
```

`--account` finds the account by its config folder (`work`, `.claude-work`, `~/.claude-work`),
its email (`me@example.com`, `meexample.com`), the email's user (`me`) or domain (`example`),
or just a few of those letters in order. Accounts are `~/.claude.json` (`default`) plus every
`~/.<folder>/.claude.json`; `/secretary ai` lists them. A name two accounts share is refused.

Switching away from a local backend stops its server; the next summary starts the new one.

```bash
# Same as /secretary ai, from a shell
node ~/.claude/the-secretary/summarize.mjs backend claude sonnet

# Force an immediate summary
node ~/.claude/the-secretary/summarize.mjs force

# Inject arbitrary context
node ~/.claude/the-secretary/summarize.mjs inject --text "your context here"

# Show the whole index: saved items + context
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall

# Search cache + DB for any query (on-demand)
node ~/.claude/the-secretary/summarize.mjs search "template 691"

# Same search with both ranked lists and the fused order printed to stderr
SECRETARY_DEBUG=1 node ~/.claude/the-secretary/summarize.mjs search "template 691"

# Verbatim index, from the project root (reads ~/.claude/projects/<slug>/*.jsonl)
node ~/.claude/the-secretary/summarize.mjs index-turns            # only what is new
node ~/.claude/the-secretary/summarize.mjs index-turns --rebuild  # re-read every transcript on disk
node ~/.claude/the-secretary/summarize.mjs index-vectors          # embed rows that have no vector yet
node ~/.claude/the-secretary/summarize.mjs sync                   # both, detached (what SessionStart runs)

# Move every per-project row out of the global DB into each project's own DB.
# Each project keeps its memory inside itself (portable); the global DB is left
# holding only '__global__' notes. Rows whose directory no longer exists cannot
# be given a home, so they are reported and left alone. --dry-run shows the plan.
node ~/.claude/the-secretary/summarize.mjs drain-global --dry-run
node ~/.claude/the-secretary/summarize.mjs drain-global
```

## Where the data lives

Each project stores its own memory in `<project>/.claude/the-secretary/summaries.db`,
so moving or copying the project takes its history with it.

```
<project>/.claude/the-secretary/
├── .gitignore        ← "*": nothing here is ever committed
├── summaries.db
│   ├── summaries     ← LLM summaries + saved items (notes, reminders)
│   ├── turns         ← FTS5: every user/assistant message, verbatim, in ≤800-char chunks
│   ├── vturns        ← sqlite-vec: one 1024-d vector per chunk (rowid = turns.rowid)
│   └── state         ← cursors: fts-line:<session> (index), offset:<session> (summarizer)
├── bullets.md        ← distilled bullets injected at SessionStart
└── images/           ← screenshots pasted in the chat, <sha1>.<ext>
```

The two cursors are independent on purpose: the summarizer may skip ahead, the index
never does. The global DB
(`~/.claude/the-secretary/summaries.db`) holds only `__global__` notes — items
you saved that are not tied to any project. Opening a project moves any of its
rows still sitting in the global DB into the project's DB, deleting them from
the global one in the same transaction so nothing accumulates there.

## Configuration

Edit `~/.claude/the-secretary/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `local` | `local` (MLX/llama.cpp server) or `claude_cli` (uses your Claude Max subscription via the `claude` CLI) |
| `summarize_every_n` | `15` | Summarize every N tool calls |
| `min_new_chars` | `2000` | Minimum new content before summarizing |
| `max_summary_tokens` | `800` | Max tokens for summary output |
| `restore_recent_items` | `15` | How many recent items the `🕑 Latest N items` restore block shows (newest-first, across the whole project tree) |
| `restore_tail_chars` | `5000` | Size of the `🧵 End of the previous conversation` block restore injects after `/clear` |
| `llm_url` | `http://localhost:8922/v1/chat/completions` | OpenAI-compatible endpoint (used when `provider=local`) |
| `claude_bin` | `~/.local/bin/claude` | Path to the `claude` binary (used when `provider=claude_cli`). Defaults to the native installer's copy, the one that updates itself. If it does not exist, `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and `/usr/local/bin/claude` are tried |
| `claude_model` | `claude-haiku-4-5` | Model passed to `claude -p --model` |
| `claude_config_dir` | _(unset)_ | Which Claude account `claude_cli` uses when you have more than one: the account's config folder (sets `CLAUDE_CONFIG_DIR`), or `default` for the account with no `CLAUDE_CONFIG_DIR`. Unset keeps the account of the session that triggered the summary |
| `local_backend` | `mlx` | `mlx` (MLX / llama.cpp) or `apple` (Apple's on-device model via apfel), used when `provider=local` |
| `db_path` | `~/.claude/the-secretary/summaries.db` | GLOBAL SQLite DB path (only `__global__` items; per-project data lives in `<projectRoot>/.claude/the-secretary/summaries.db`) |
| `embed_python` | `~/.claude/the-secretary/venv/bin/python` | Interpreter with `mlx-embeddings` for the semantic index (optional key) |

Environment: `SECRETARY_DEBUG=1` traces the search ranking to stderr; `SECRETARY_MLX_MODEL` forces the summary model.

### Provider: `claude_cli` (Claude Max)

When set, summaries are generated by spawning `claude -p --model <claude_model> --output-format json --no-session-persistence --settings '{"disableAllHooks":true}'` instead of hitting the local MLX server, and `start-llm.sh start` leaves the local server down. Hooks are off for that call on purpose: it is a Claude session too, and with hooks on its Stop hook would run The Secretary again. No API key is needed — it reuses the authenticated session of your `claude` CLI (Max / Pro subscription).

Built-in safeguards:

- **Strict success parsing.** A response is only accepted if `subtype === 'success'`, `errors[]` is empty, and `result` is a non-empty string. Any other shape is treated as a failure (no silent passes).
- **Cooldown after repeated failures.** After 2 consecutive failures the provider is marked degraded for 10 minutes (state persisted at `/tmp/secretary-claude-cli-degraded.json`), so the secretary stops retrying on every tool call.

> **Note:** on Claude Code 2.1.x before the fix for issue [#52178](https://github.com/anthropics/claude-code/issues/52178), `claude -p --model claude-haiku-4-5` returned `subtype: "error_during_execution"`. It works as of 2.1.289; on an older CLI use `provider=local` or a different `claude_model`.

## Local hooks (machine-specific behaviour)

Behaviour that only makes sense on one machine does not belong in the shipped files: the next `install.sh` would overwrite it, and everybody else would get code they never asked for. It goes in `~/.claude/the-secretary/local/` instead. That folder is never shipped and `install.sh` never writes into it, so it survives every upgrade (only `--uninstall` removes it, together with the rest of the install directory). Without it nothing changes: every hook is a no-op.

Two files, one per runtime, both optional:

| File | Loaded by | Hooks it may define |
|---|---|---|
| `local/hooks.mjs` | `summarize.mjs` (ES module, loaded once at startup) | `export function gpuHeldExternally()` |
| `local/hooks.sh` | `start-llm.sh` (sourced before the command runs) | `local_before_start`, `local_on_server_up`, `local_command` |

**`summarize.mjs` hooks**

- `gpuHeldExternally()` — synchronous, returns `true` while something outside The Secretary needs the GPU to itself. While it holds, the GPU lock counts as taken (embeddings wait), the background summarizer waits before it starts (its text stays in memory, nothing is dropped or sent online), and a request to the local LLM that failed meanwhile is retried up to three times once the hold ends. A hook that throws counts as `false`; a file that fails to load is reported on stderr and ignored.

**`start-llm.sh` hooks**

- `local_before_start` — runs before a server is spawned. `exit` with a non-zero status to veto the start; callers treat that as "no LLM available".
- `local_on_server_up` — runs every time a live server is found, adopted or freshly started. The place to attach a watcher to it.
- `local_command <name>` — receives any command `start-llm.sh` does not know, so the file can add its own (`bash start-llm.sh <name>`).

The file is sourced after `PORT`, `LOG`, `PID_FILE` and `ACTIVITY_FILE` are set, so the hooks can use them.

**Example — yield the GPU to a benchmark.** Another program creates a reservation file while it measures; The Secretary stays off the GPU until the file goes away:

```js
// ~/.claude/the-secretary/local/hooks.mjs
import { statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RESERVATION = join(homedir(), '.claude', 'gpu-busy.lock');
const STALE_MS = 20 * 60 * 1000; // its holder died: ignore it

export function gpuHeldExternally() {
  try { return Date.now() - statSync(RESERVATION).mtimeMs < STALE_MS; }
  catch { return false; }
}
```

```bash
# ~/.claude/the-secretary/local/hooks.sh
RESERVATION="$HOME/.claude/gpu-busy.lock"

gpu_reserved() {
  [ -f "$RESERVATION" ] && [ -n "$(find "$RESERVATION" -mmin -20 2>/dev/null)" ]
}

# Don't load the model while the reservation holds
local_before_start() {
  if gpu_reserved; then
    echo "GPU reserved: not starting the LLM server"
    exit 3
  fi
}
```

`local_on_server_up` can go one step further and start a watcher that freezes a server that is already up (`kill -STOP`) while the reservation holds and resumes it afterwards (`kill -CONT`): the model stays in memory but leaves the GPU at once.

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
├── hooks.json          ← Hook definitions (single source of truth)
├── statusline.json     ← Status line definition (face, context bar, usage, handoff wait)
├── skill/
│   └── SKILL.md        ← Behavior rules; its `version:` is the package version
├── backups/            ← Previous versions (gitignored)
└── src/
    ├── summarize.mjs   ← Main secretary script
    ├── secretary.mjs   ← `secretary` launcher (runs claude, reopens trimmed sessions)
    ├── embed.py        ← Embedding helper (Qwen3-Embedding-0.6B via MLX)
    ├── start-llm.sh    ← LLM server manager
    ├── config.json     ← Default configuration
    ├── package.json    ← Node.js dependencies (better-sqlite3, sqlite-vec)
    ├── inject-claude-md.mjs ← Writes the versioned CLAUDE.md section
    └── claude-md-snippet.md ← CLAUDE.md docs snippet

~/.claude/the-secretary/local/   ← Optional, yours: never shipped, never overwritten
├── hooks.mjs           ← Local hooks for summarize.mjs
└── hooks.sh            ← Local hooks for start-llm.sh
```

## Changelog

| Version | Date | Change |
|---|---|---|
| 2.17.0 | 2026-10-30 | Desktop notifications removed (`osascript`, the SessionEnd `--notify` flag and its LLM blurb). "Memory recovered" (restore) and "Previous session handoff included" (`await-handoff --rewake`) now show in the status line after the face and `Secretary` for 15 s |
| 2.16.0 | 2026-10-30 | Status line face is now `( ∵ᴖ ᴗ ᴖ∵ )`: blinks `( ∵⸌ ᴗ ⸍∵ )` and every two minutes plays a gesture (surprise, laugh, frown, dizzy, goofy), always 11 cells wide. Context bar shortened to 16 cells. Docs: launcher in the install steps and the file list |
| 2.15.0 | 2026-10-30 | Status line starts with `(·_·) Secretary`: the face blinks and every two minutes plays a short gesture, always five characters wide so the line never shifts |
| 2.14.0 | 2026-10-30 | Status line: context as `56K/500K` (against the clear limit) set apart from the bar, plus model and effort, session cost, 5 h / 7 d plan usage, minutes left on the prompt cache and the account, separated by ` · ` |
| 2.13.0 | 2026-10-30 | `secretary` launcher: runs `claude` with the same arguments and, past `context_clear_tokens`, reopens the trimmed session with the prompt just sent, so `/resume` no longer has to be pasted. Status line shows the account (`CLAUDE_PROFILE` or the email's user) after the context size |
| 2.12.0 | 2026-10-28 | Search by date: a date in the query ("ayer", "el martes pasado", "la semana pasada", "hace 3 días", "el 5 de octubre", "2026-10-28", and the English forms) limits literal, vector and summary results to that span of local time; the other words are what is searched. A query that is only a date returns that day's session handoffs |
| 2.11.1 | 2026-10-28 | A session opened in any subfolder of a repo now uses the memory at the repo root: the personal folder name that the project-root climb treated as a "container of unrelated projects" is gone from `GENERIC_CONTAINERS`, so subfolders no longer get a memory of their own |
| 2.11.0 | 2026-10-28 | The skill is renamed `secretary` (`/secretary`); the installer removes the old `skills/the-secretary` folder. Data folders keep their `the-secretary` name. `/secretary ai` (and `summarize.mjs backend`) shows or switches the summarizing AI: `local`, `apple` or `claude [model]`. `--account <name | email | folder>` / the `claude_config_dir` key pick which Claude account the CLI bills when there is more than one. Off-project sessions get one `OFF-PROJECT:` line instead of taking over the handoff. The Apple backend gets no frequency penalty |
| 2.10.1 | 2026-10-17 | Long sessions get a handoff again: `messagesToText` admitted every user turn before any assistant turn, so once a session's requests alone filled the 16000-char budget the model saw only asks, no replies, answered `NOTHING TO REPORT`, and no handoff was stored for the rest of the session (the next `/clear` injected one ten hours stale). Talk turns of both roles are now admitted in one recency pass. The files-touched manifest writes paths relative to the session's first `cwd`: absolute paths under a deep project root cut the list at 8 files. With `SECRETARY_DEBUG`, every prompt sent to the LLM is appended to `$TMPDIR/secretary-prompts-debug.txt` and skipped transcript lines are logged. The `claude_cli` cooldown after two failures now holds: `readClaudeState` read `degradedUntil` with `| 0`, which truncates a millisecond timestamp to 32 bits into a value always in the past |
| 2.10.0 | 2026-10-16 | After `/clear`, restore injects the verbatim end of the session just left (`🧵`, `restore_tail_chars`, default 5000; the last user request always included) and asks Claude to check whether it broke off mid-task before resuming. The "Memory recovered" notification no longer fires on `/clear` before the previous handoff lands: `await-handoff --rewake` sends it once the wait is over. The Stop hook records the terminal's session in the handoff lock even when it writes no handoff |
| 2.9.8 | 2026-10-10 | Short LLM answers reach their caller again: the "reports nothing" guard sat in `callLLM` and discarded every one-line answer (intent `SAVE`/`FORGET`, ids to forget, notification blurb) as an empty summary, so saves and deletions detected by the LLM fell back to `NONE`. The guard moved to `callLLMForSummary`, which only summary prompts call |
| 2.9.7 | 2026-10-09 | A recall question now loads the skill every time: the `UserPromptSubmit` hook prints an order to call `Skill` with `the-secretary` as the first tool call of the turn, before any other branch, and the `CLAUDE.md` snippet states the same. With the handoff already in context Claude answered straight from it and skipped the skill |
| 2.9.6 | 2026-10-09 | "Where were we" questions ("por dónde vamos", "dónde lo dejamos", "where were we") are answered from the session handoff alone: the rule is in the `CLAUDE.md` snippet and in the skill's "Trust injected context" triggers, so Claude no longer runs `git status` or grep to rebuild the state the handoff already holds |
| 2.9.5 | 2026-10-08 | `claude_bin` defaults to `~/.local/bin/claude` (the native installer's copy) instead of `/opt/homebrew/bin/claude`. A global npm install left behind next to the native one stays at its old version, and an old CLI warms up its built-in agents on every start: each summary carried an extra request on the user's main model and another on the previous Haiku, several times the cost of the summary itself |
| 2.9.4 | 2026-10-05 | `provider: claude_cli` no longer feeds on itself: every `claude -p` The Secretary spawned was a session of its own, whose Stop hook ran The Secretary again and spawned the next one — an unbounded chain of summaries of summaries (28 sessions in three minutes). The call now runs with `--settings '{"disableAllHooks":true}'` and `--no-session-persistence`, so it fires no hooks and leaves no transcript in the project folder. `start-llm.sh start` does nothing when the provider is `claude_cli` (the SessionStart and PreCompact hooks used to launch a local server nothing talked to). `claude_bin` falls back to the known install locations (`~/.local/bin`, Homebrew, `/usr/local/bin`) when the configured path does not exist. `install.sh` keeps an existing `config.json` instead of overwriting it |
| 2.9.3 | 2026-10-05 | The wait for the previous session's handoff after `/clear` is now visible: a `statusLine` command (`handoff-status`, `statusline.json`, `refreshInterval: 1`) prints `⏳ The Secretary: waiting for the previous handoff` plus an animated spinner while it is being written; `install.sh` sets it unless a status line of your own is already configured, and removes it on uninstall |
| 2.9.2 | 2026-10-05 | Handoffs no longer vanish when two summarizer workers overlap: `start-llm.sh` killed everything returned by `lsof -ti:$PORT`, which includes the workers connected to the server, so a worker with a request in flight died with no error and no summary (`port_listener_pids` now targets the listener only); workers no longer stop the shared LLM server, an idle reaper started with the server runs `stop-if-idle` once a minute and `ensureLLMRunning` records each use with `touch`; a dropped summary now logs why |
| 2.9.1 | 2026-10-05 | `await-handoff --rewake` wakes Claude after every `/clear`, also when the previous session's handoff added nothing (it used to exit silently, so a short session looked like the hook never ran); `rewakeSummary` / `rewakeMessage` label the wake-up; with `SECRETARY_DEBUG` the handoff worker's stderr and the raw LLM answer go to `$TMPDIR/secretary-worker-debug.log` |
| 2.9.0 | 2026-10-05 | Local hooks: optional `~/.claude/the-secretary/local/hooks.mjs` and `hooks.sh` hold machine-specific behaviour (`gpuHeldExternally`, `local_before_start`, `local_on_server_up`, `local_command`) outside the shipped files, so it survives `install.sh` |
| 2.8.0 | 2026-10-05 | After `/clear`, an async SessionStart hook (`await-handoff --rewake`, `asyncRewake`) waits for the previous session's handoff and wakes Claude with it, so the user no longer has to type a first prompt to get the fresh context |
| 2.5.0 | 2026-09-25 | Transcript is the source of truth: the index reads the transcripts with its own cursor from every hook (pure-chat turns were being dropped), stores full turns in 800-char chunks (no 3000-char cut), saves pasted screenshots to `images/`; `index-turns --rebuild`; search fuses FTS5 and vectors (coverage-ranked FTS, reciprocal rank fusion, exact rows first, duplicates collapsed); vector floor 0.62 → 0.5; 2 s GPU-lock wait during search; embedder cap 512 → 1000 chars; `SECRETARY_DEBUG` |
| 2.4.1 | 2026-09-21 | Discard summaries that report nothing |
| 2.4.0 | 2026-09-21 | Files-touched manifest stops the handoff inventing paths; gemma-4-26B-A4B on ≥48 GB |

## Troubleshooting

**LLM server won't start:**
```bash
bash ~/.claude/the-secretary/start-llm.sh start
cat /tmp/the-secretary-llm.log
```

**No context after /clear:**
```bash
# Per-project DB (main storage):
sqlite3 <projectRoot>/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"
# Global DB (only items marked 'global'):
sqlite3 ~/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"
curl http://localhost:8922/v1/models
```

**Hooks not firing:**
```bash
cat ~/.claude/settings.json | grep -A5 summarize
```

## License

MIT
