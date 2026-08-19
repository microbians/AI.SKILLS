# The Secretary

AI-powered context persistence for Claude Code. Preserves conversation context and keeps **one flat index** of everything worth remembering — all using a small local LLM (Qwen 2.5, auto-sized 1.5B / 3B / 7B by available RAM). Optional `claude_cli` provider available for users with a Claude Max subscription.

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
3. Search runs in three tiers, stopping once it has enough hits: per-project cache `.md` files (fast file-level grep) → **verbatim turns** (`turns`, FTS5) → the `summaries` table (`LIKE` fallback).
4. Top matches are printed to stdout and appear as injected context in Claude's next turn.

**Verbatim turn index (FTS5).** Summaries paraphrase — ask "what did I say about ffmpeg on Railway" and the summary only kept "discussed deployment". So every conversation turn is also stored verbatim in an FTS5 table, indexed live by the PostToolUse hook. This makes search flexible in three ways `LIKE` was not:

- **Accent- and case-insensitive** (`unicode61 remove_diacritics 2`) — `edicion` matches `edición`.
- **Partial matches instead of nothing** — terms are OR-ed with prefix wildcards, so an absent word no longer zeroes the result set; `bm25` ranks whatever matched most. The old `AND` chain returned 0 hits if any single term was missing.
- **Ranked by relevance**, not just recency.

Results are tagged `[said]` (your own words) or `[turn]` (assistant), so quoting yourself back is easy to spot.

Sessions that ended before the index existed can be backfilled from the transcripts on disk:

```bash
node ~/.claude/the-secretary/summarize.mjs index-turns
```

Run it from the project root; it reads `~/.claude/projects/<slug>/*.jsonl` for that project only. It is idempotent — re-running indexes just the new turns. (Reference: 31 sessions → 7,518 turns in ~1.2s.)

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

## How it works

1. **PostToolUse hook** — On every tool call, scans user messages for secretary orders (save / forget) via regex. Every N calls (default: 15), summarizes conversation via local LLM.
   - **Transcript extraction** — Summaries are built from Claude Code's own session transcript (`~/.claude/projects/<slug>/<session-id>.jsonl`), passed to the hook as `transcript_path`. Since that file is mostly tool traffic and attachments (a typical session: 1.3 MB raw, of which conversation is under 5%), the extractor filters before summarizing:
     - **Noise stripped** — slash-command plumbing (`<command-*>`, `<local-command-stdout>`), `<task-notification>`, `<system-reminder>`, interruption markers and image placeholders never reach the model. Bare acknowledgements (`ok`, `dale`, `sigue`, `thanks`) are dropped too.
     - **Budget by role** — user turns are admitted first, then assistant turns, and tool traffic only fills what is left over. Tool output can no longer crowd out what was actually said.
     - **Newest-first selection** — the budget is filled walking backwards from the end of the session, so the summary reflects the *current* state rather than the stale opening. The selected turns are re-emitted in chronological order.
2. **UserPromptSubmit hook** — On every user prompt, detects recall-style questions (`¿recuerdas?`, `do you remember`, etc.) and auto-injects matching snippets from cache + DB.
3. **PreCompact hook** — Forces a final summary before Claude's compaction, then blocks it and suggests `/clear`.
4. **SessionStart hook** — On `/clear`, `startup`, or `resume`, restores context from the project's own DB (root resolved from the filesystem, so it matches the whole project tree, not just the exact cwd):
   - **Manually injected context** — items added with `inject` are printed **verbatim**, never LLM-consolidated: they are hand-curated, so paraphrasing them only loses detail
   - **Session handoff brief** (📋) from the previous session's Stop hook — the dense "how to resume" doc
   - **Handoffs from earlier sessions** — the 2 previous handoffs, truncated to 900 chars each. A handoff is the distilled state of an entire session, so restoring only the last one (`LIMIT 1`) discarded most of the project history; truncation keeps them from dwarfing the rest of the recall
   - **Latest N items** (🕑) — the N most recent summaries across the project tree, newest-first (`restore_recent_items`, default 15)
   - Consolidated conversation summary (loaded from per-project cache — see below) as background
   - Saved items — one flat list, oldest first
5. **Stop hook** — Generates a session **handoff brief** (richer than the regular summary, structured so the next session can resume without explanation), then shuts down the LLM server.

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

| Unified memory | Model | RAM use | Speed (M-series) | Hallucination |
|---|---|---|---|---|
| ≥ 32 GB | `mlx-community/Qwen2.5-7B-Instruct-4bit` | ~4.5 GB | ~50 tok/s | very low |
| 16 – 31 GB | `mlx-community/Qwen2.5-3B-Instruct-4bit` | ~2 GB | ~80 tok/s | low |
| < 16 GB | `mlx-community/Qwen2.5-1.5B-Instruct-4bit` | ~1 GB | ~120 tok/s | medium |

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

## Search: literal first, semantic only as a fallback

Two indexes, because they fail in opposite ways. Measured on a real 1.8k-turn project:

| Query kind | FTS5 | Vectors |
|---|---|---|
| a bare identifier (17 real occurrences) | finds all 17 | recovers **0** |
| a short keyword (52 occurrences) | finds all 52 | recovers **0** |
| literal recall overall | exact | **8%** |
| "espaciado vertical" → the turn saying *"les falta gap vertical"* | 0 hits (or 1000+ OR-noise) | **finds it** |

So FTS5 runs first and owns the literal answer — and its **zero is meaningful**: it means
the phrase is genuinely not in the memory. Vectors run only when FTS5 came up short, and
their hits are tagged `[said~]` / `[turn~]`.

**A vector hit is not evidence.** Calibrating the threshold showed real topics scoring
0.58–0.78 and *invented* ones 0.55–0.65 — the ranges overlap, so no cutoff separates them.
The threshold (0.62) drops most invented queries, but anything that survives means
"similar wording exists", never "this was discussed". Only an FTS5 hit proves that.

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
- **~1–5 GB disk space** for the model (auto-downloaded by MLX on first run, or GGUF path)
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
2. Create `~/.claude/the-secretary/` with all files
3. Install the `the-secretary` skill at `~/.claude/skills/the-secretary/` (defines the behavior rules Claude must follow)
4. Install `better-sqlite3` dependency
5. Download a Qwen 2.5 model sized to your machine (MLX downloads on first run; llama.cpp uses the bundled 3B GGUF)
6. Merge hooks into `~/.claude/settings.json`
7. Inject a pointer to the skill into `~/.claude/CLAUDE.md`
8. Start the LLM server and verify

For manual installation, see [INSTALL.md](INSTALL.md).

## Commands

```bash
# Force an immediate summary
node ~/.claude/the-secretary/summarize.mjs force

# Inject arbitrary context
node ~/.claude/the-secretary/summarize.mjs inject --text "your context here"

# Show the whole index: saved items + context
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall

# Search cache + DB for any query (on-demand)
node ~/.claude/the-secretary/summarize.mjs search "template 691"
```

## Configuration

Edit `~/.claude/the-secretary/config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `local` | `local` (MLX/llama.cpp server) or `claude_cli` (uses your Claude Max subscription via the `claude` CLI) |
| `summarize_every_n` | `15` | Summarize every N tool calls |
| `min_new_chars` | `2000` | Minimum new content before summarizing |
| `max_summary_tokens` | `1500` | Max tokens for summary output |
| `restore_recent_items` | `15` | How many recent items the `🕑 Latest N items` restore block shows (newest-first, across the whole project tree) |
| `llm_url` | `http://localhost:8922/v1/chat/completions` | OpenAI-compatible endpoint (used when `provider=local`) |
| `claude_bin` | `/opt/homebrew/bin/claude` | Path to the `claude` binary (used when `provider=claude_cli`) |
| `claude_model` | `claude-haiku-4-5` | Model passed to `claude -p --model` |
| `db_path` | `~/.claude/the-secretary/summaries.db` | GLOBAL SQLite DB path (only `__global__` items; per-project data lives in `<projectRoot>/.claude/the-secretary/summaries.db`) |

### Provider: `claude_cli` (Claude Max)

When set, summaries are generated by spawning `claude -p --model <claude_model> --output-format json` instead of hitting the local MLX server. No API key is needed — it reuses the authenticated session of your `claude` CLI (Max / Pro subscription).

Built-in safeguards:

- **Strict success parsing.** A response is only accepted if `subtype === 'success'`, `errors[]` is empty, and `result` is a non-empty string. Any other shape is treated as a failure (no silent passes).
- **Cooldown after repeated failures.** After 2 consecutive failures the provider is marked degraded for 10 minutes (state persisted at `/tmp/secretary-claude-cli-degraded.json`), so the secretary stops retrying on every tool call.

> **Note (May 2026):** `claude -p --model claude-haiku-4-5` currently returns `subtype: "error_during_execution"` due to an upstream bug in `@anthropic-ai/claude-code` (see issue [#52178](https://github.com/anthropics/claude-code/issues/52178)). Until that ships a fix, use `provider=local` or set `claude_model` to `claude-sonnet-4-5` (more expensive, consumes more of your Max quota).

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
