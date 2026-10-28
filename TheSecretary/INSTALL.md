# Manual Installation Guide

If you prefer to install The Secretary manually instead of using `install.sh`, follow these steps. `install.sh` does steps 1–3 and 5–7 for you; step 4 (the semantic index) and step 8 (the per-project backfill) are always manual.

## 1. Create directory and copy files

```bash
mkdir -p ~/.claude/the-secretary/models

cp src/summarize.mjs        ~/.claude/the-secretary/   # the engine: hooks, index, search, summaries
cp src/embed.py             ~/.claude/the-secretary/   # embedding helper for the semantic index
cp src/start-llm.sh         ~/.claude/the-secretary/   # local LLM server manager
cp -n src/config.json       ~/.claude/the-secretary/   # -n: never overwrite your own config
cp src/package.json         ~/.claude/the-secretary/
cp src/inject-claude-md.mjs ~/.claude/the-secretary/   # writes the versioned section into CLAUDE.md

chmod +x ~/.claude/the-secretary/start-llm.sh
```

Machine-specific behaviour (for example yielding the GPU to another program) does not go into these files: put it in `~/.claude/the-secretary/local/hooks.mjs` and `local/hooks.sh`, which nothing here ever overwrites. See [README → Local hooks](README.md#local-hooks-machine-specific-behaviour).

If migrating from a legacy install at `~/.claude/summarizer/`, move the directory first to preserve the SQLite DB, models, watermarks, and cache:

```bash
mv ~/.claude/summarizer ~/.claude/the-secretary
# then re-run the cp commands above to update the files with the new paths
```

## 1b. Install the skill

```bash
mkdir -p ~/.claude/skills/secretary
cp skill/SKILL.md ~/.claude/skills/secretary/SKILL.md
```

The skill defines the behavior rules Claude must follow when interacting with The Secretary (recall commands, how to read `[said]` / `[said~]` hits, trigger patterns, scope, etc.).

## 2. Install dependencies

```bash
cd ~/.claude/the-secretary
npm install
```

This installs `better-sqlite3` (storage + FTS5 verbatim index) and `sqlite-vec` (vector table for the semantic index).

## 3. LLM backend (summaries)

**Using MLX (Apple Silicon, recommended):** `pip install mlx-lm`. `start-llm.sh` picks the model by unified memory and downloads it on first run (≥ 48 GB → `gemma-4-26B-A4B-it-qat-4bit`; smaller machines → a Qwen2.5 size that fits). Force a different model with `SECRETARY_MLX_MODEL=mlx-community/<repo>`.

**Using llama.cpp (Linux / Intel / fallback):** `brew install llama.cpp`, then download the bundled 3B GGUF:

```bash
curl -L -o ~/.claude/the-secretary/models/qwen2.5-3b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
```

The LLM only writes summaries. The verbatim index and search work without it.

## 4. Semantic index (optional, Apple Silicon)

Vectors let a recall question find a turn by meaning ("the site *similar* to X" → the turn saying "a site *like* X"). Without this step search stays literal (FTS5) and nothing breaks. `install.sh` does not do this step.

```bash
python3 -m venv ~/.claude/the-secretary/venv
~/.claude/the-secretary/venv/bin/pip install mlx-embeddings numpy
```

`embed.py` loads `mlx-community/Qwen3-Embedding-0.6B-8bit` (~600 MB, downloaded on first use). To use another interpreter, set `"embed_python": "/path/to/python"` in `config.json`.

## 5. Add hooks to settings.json

Merge the contents of [`hooks.json`](hooks.json) into the `"hooks"` object of `~/.claude/settings.json`, keeping any hooks you already have. `hooks.json` is the single source of truth: copy it instead of retyping it here, because a hand-written copy in this file once drifted and was missing three hooks.

Then set the contents of [`statusline.json`](statusline.json) as the `"statusLine"` key of the same file. After a `/clear` it shows `⏳ The Secretary: waiting for the previous handoff` plus an animated spinner below the input box while that handoff is being written, and stays blank the rest of the time. Claude Code has one status line: if you already use your own, keep it and call `summarize.mjs handoff-status` from it (it reads the status line JSON on stdin and prints the notice or nothing).

What each hook does:

| Hook | Command | Role |
|---|---|---|
| `UserPromptSubmit` | `user-prompt` | Recall questions → search the memory and inject the hits |
| `PostToolUse` | `incremental` | Index new turns verbatim; every N calls, summarize in background |
| `Stop` | `force --stop-llm` | Index the turns of the reply that just ended (pure chat included); write the handoff |
| `SessionEnd` | `force --stop-llm --notify` | Same, plus a desktop notification |
| `PreCompact` | `compact` | Index + final summary before Claude Code compacts |
| `SessionStart` | `restore` + `sync` | Inject the saved context; catch up both indexes in background |
| `SessionStart` (`clear`, async) | `await-handoff --rewake` | Wait for the previous session's handoff and wake Claude with it |

`PreCompact` and `SessionStart` also call `start-llm.sh start` first; with `provider: claude_cli` that is a no-op.

## 6. CLAUDE.md section

```bash
node ~/.claude/the-secretary/inject-claude-md.mjs ~/.claude/CLAUDE.md src/claude-md-snippet.md "$(sed -n 's/^version: *//p' skill/SKILL.md)"
```

This inserts (or refreshes) the section with a `<!-- skill: secretary vX.Y.Z -->` marker, which `check-versions.sh` reads.

## 7. Verify

```bash
bash ~/.claude/the-secretary/start-llm.sh start     # provider: local only
curl -s http://localhost:8922/v1/models | head -1   # provider: local only
echo '{}' | node ~/.claude/the-secretary/summarize.mjs incremental
echo $?  # Should be 0
```

## 8. Backfill each project

From each project's root, index the sessions it already has on disk:

```bash
node ~/.claude/the-secretary/summarize.mjs index-turns     # verbatim text, ~1 s
node ~/.claude/the-secretary/summarize.mjs index-vectors   # vectors, ~1 min per 1k chunks (needs step 4)
```

After that, `SessionStart` keeps both indexes current by itself.

## 9. Restart Claude Code

Close and reopen Claude Code. The hooks will activate automatically.

## Upgrading from v2.4.x to v2.5.0

v2.5.0 reads the index straight from the transcripts. Earlier versions left gaps: turns with no tool call in between were never stored, long turns were cut at 3000 chars and pasted screenshots were not kept. Updating the files does not repair the rows already stored, so once per project:

```bash
cd <projectRoot>
sqlite3 .claude/the-secretary/summaries.db ".backup '.claude/the-secretary/summaries.db.bak-pre-2.5'"   # optional safety copy
node ~/.claude/the-secretary/summarize.mjs index-turns --rebuild   # re-read every transcript still on disk
node ~/.claude/the-secretary/summarize.mjs index-vectors           # re-embed the replaced rows
```

`--rebuild` only replaces sessions whose transcript still exists. Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`), and sessions already past that keep their old rows, since the index is by then their only copy. Pasted images are extracted into `<projectRoot>/.claude/the-secretary/images/` on the way. Reference: 14 sessions → 8,559 chunks and 275 images in 1.2 s; vectors for them took 7 min 40 s on an M-series Mac.
