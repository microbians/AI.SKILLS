# Manual Installation Guide

If you prefer to install The Secretary manually instead of using `install.sh`, follow these steps.

## 1. Create directory and copy files

```bash
mkdir -p ~/.claude/the-secretary/models

cp src/summarize.mjs ~/.claude/the-secretary/
cp src/start-llm.sh ~/.claude/the-secretary/
cp src/config.json ~/.claude/the-secretary/
cp src/package.json ~/.claude/the-secretary/

chmod +x ~/.claude/the-secretary/start-llm.sh
```

If migrating from a legacy install at `~/.claude/summarizer/`, move the directory first to preserve the SQLite DB, models, watermarks, and cache:

```bash
mv ~/.claude/summarizer ~/.claude/the-secretary
# then re-run the cp commands above to update summarize.mjs / start-llm.sh / config.json with the new paths
```

## 1b. Install the skill

```bash
mkdir -p ~/.claude/skills/the-secretary
cp skill/SKILL.md ~/.claude/skills/the-secretary/SKILL.md
```

The skill defines the behavior rules Claude must follow when interacting with The Secretary (recall commands, trigger patterns, scope, etc.).

## 2. Install dependencies

```bash
cd ~/.claude/the-secretary
npm install
```

## 3. Download the model

**Using MLX (Apple Silicon, recommended):** skip this step. `start-llm.sh` auto-selects the right Qwen2.5 size based on your unified memory and downloads it on first run:

| Unified memory | Auto-selected model | Disk |
|---|---|---|
| ≥ 32 GB | `Qwen2.5-7B-Instruct-4bit` | ~4.5 GB |
| 16 – 31 GB | `Qwen2.5-3B-Instruct-4bit` | ~2 GB |
| < 16 GB | `Qwen2.5-1.5B-Instruct-4bit` | ~1 GB |

Force a different model with `SECRETARY_MLX_MODEL=mlx-community/<repo>` in your shell environment.

**Using llama.cpp (Linux / Intel / fallback):** download the bundled 3B GGUF:

```bash
curl -L -o ~/.claude/the-secretary/models/qwen2.5-3b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
```

## 4. Add hooks to settings.json

Open `~/.claude/settings.json` and merge these hooks (don't replace existing ones):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/the-secretary/summarize.mjs incremental",
            "timeout": 60
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/the-secretary/start-llm.sh start > /dev/null 2>&1; node ~/.claude/the-secretary/summarize.mjs compact",
            "timeout": 15
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/the-secretary/summarize.mjs force; bash ~/.claude/the-secretary/start-llm.sh stop > /dev/null 2>&1",
            "timeout": 90
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/the-secretary/start-llm.sh start > /dev/null 2>&1; node ~/.claude/the-secretary/summarize.mjs restore",
            "timeout": 120
          }
        ]
      },
      {
        "matcher": "clear",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/the-secretary/start-llm.sh start > /dev/null 2>&1; node ~/.claude/the-secretary/summarize.mjs restore",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

## 5. Copy CLAUDE.md snippet

```bash
cat src/claude-md-snippet.md >> ~/.claude/CLAUDE.md
```

## 6. Verify

```bash
bash ~/.claude/the-secretary/start-llm.sh start
curl -s http://localhost:8922/v1/models | head -1
echo '{}' | node ~/.claude/the-secretary/summarize.mjs incremental
echo $?  # Should be 0
```

## 7. Restart Claude Code

Close and reopen Claude Code. The hooks will activate automatically.
