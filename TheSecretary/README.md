# The Secretary

AI-powered context persistence for Claude Code. Preserves conversation context, manages user memories, takes notes, and tracks reminders — all using a small local LLM (Qwen 2.5, auto-sized 1.5B / 3B / 7B by available RAM). Optional `claude_cli` provider available for users with a Claude Max subscription.

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
2. Keywords are extracted from the prompt (stopwords stripped, EN + ES).
3. Search runs first against per-project cache `.md` files (fast file-level grep), then falls back to the `summaries` table if fewer than 5 hits.
4. Top matches are printed to stdout and appear as injected context in Claude's next turn.

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

Stored in the same `summaries` table tagged with a `[HANDOFF]` prefix. On the next `SessionStart`, **the most recent handoff for the current project is shown FIRST**, before the older bullet summaries, under a `📋 Session handoff — resume here` heading. The bullet cache stays available below as background.

This is additive — incremental summaries, memories, notes and reminders all keep working as before. The handoff is what the next session reads first; the rest is context.

### Fresh-context notice (late summaries after `/clear`)

If you hit `/clear` while the local LLM is still summarizing the previous session's tail, those new summaries land in the DB **after** SessionStart has already injected context — so Claude doesn't see them and the user has to prompt them manually.

The Secretary handles this automatically:

1. On restore, a watermark file is written to `~/.claude/the-secretary/watermarks/<session_id>.json` with `max(created_at)` of summaries visible at that moment.
2. On every user prompt, `UserPromptSubmit` checks if any summaries with `created_at > watermark` have appeared for the current project.
3. If so, a `📥 The Secretary: contexto nuevo disponible` block is injected into the conversation with the new content, and the watermark is advanced so the notice doesn't repeat.

The check is cheap (a single SQLite query per prompt) and fires only when there is genuinely new content to show. No-op for sessions that had nothing pending.

## How it works

1. **PostToolUse hook** — On every tool call, scans user messages for secretary orders (remember/forget/note/reminder) via regex. Every N calls (default: 15), summarizes conversation via local LLM.
2. **UserPromptSubmit hook** — On every user prompt, detects recall-style questions (`¿recuerdas?`, `do you remember`, etc.) and auto-injects matching snippets from cache + DB.
3. **PreCompact hook** — Forces a final summary before Claude's compaction, then blocks it and suggests `/clear`.
4. **SessionStart hook** — On `/clear`, `startup`, or `resume`, restores context:
   - **Overdue reminders** shown first (highest priority)
   - **Session handoff brief** (📋) from the previous session's Stop hook — the dense "how to resume" doc
   - Consolidated conversation summary (loaded from per-project cache — see below) as background
   - User memories
   - Active notes
   - Upcoming reminders
5. **Stop hook** — Generates a session **handoff brief** (richer than the regular summary, structured so the next session can resume without explanation), then shuts down the LLM server.

### Incremental bullets cache (per-project)

To keep SessionStart instant and avoid racing with still-running summarizers after `/clear`, each background summarization distills **3 terse one-line bullets** from the latest chunk summary and appends them to a per-project `bullets.md`. SessionStart just reads that file — no LLM call, no waiting.

- **Location:** `~/.claude/the-secretary/cache/<project>-<hash8>/bullets.md`.
- **Structure:** sections by session. Each section header is `## Session <id> (started <iso>)`, followed by bullets.
- **Per-session caps:** max **20 bullets** or **4000 chars**, FIFO when exceeded (oldest bullets drop first).
- **Global caps:** last **2 sessions** kept (current + previous); older sessions are discarded when a new one starts.
- **Dedup:** the LLM is told the existing bullets of the current session and asked to output only genuinely new info; exact duplicates are filtered on append.
- **Strictly per-project:** each `cwd` has its own `bullets.md`; content is never mixed across projects. Only the explicit `global` memories/notes/reminders cross project boundaries.
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

# Show everything: memories, notes, reminders, context
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall

# Show only notes
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall-notes

# Show only reminders
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/the-secretary/summarize.mjs recall-reminders

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
| `llm_url` | `http://localhost:8922/v1/chat/completions` | OpenAI-compatible endpoint (used when `provider=local`) |
| `claude_bin` | `/opt/homebrew/bin/claude` | Path to the `claude` binary (used when `provider=claude_cli`) |
| `claude_model` | `claude-haiku-4-5` | Model passed to `claude -p --model` |
| `db_path` | `~/.claude/the-secretary/summaries.db` | SQLite database path |

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
sqlite3 ~/.claude/the-secretary/summaries.db "SELECT session_id, COUNT(*) FROM summaries GROUP BY session_id"
curl http://localhost:8922/v1/models
```

**Hooks not firing:**
```bash
cat ~/.claude/settings.json | grep -A5 summarize
```

## License

MIT
