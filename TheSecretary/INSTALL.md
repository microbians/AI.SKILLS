# Manual Installation Guide

If you prefer to install The Secretary manually instead of using `install.sh`, follow these steps.

## 1. Create directory and copy files

```bash
mkdir -p ~/.claude/summarizer/models

cp src/summarize.mjs ~/.claude/summarizer/
cp src/start-llm.sh ~/.claude/summarizer/
cp src/config.json ~/.claude/summarizer/
cp src/package.json ~/.claude/summarizer/

chmod +x ~/.claude/summarizer/start-llm.sh
```

## 2. Install dependencies

```bash
cd ~/.claude/summarizer
npm install
```

## 3. Download the model (llama.cpp only)

```bash
# Skip this if using MLX — it downloads automatically on first use
curl -L -o ~/.claude/summarizer/models/qwen2.5-3b-instruct-q4_k_m.gguf \
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
            "command": "node ~/.claude/summarizer/summarize.mjs incremental",
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
            "command": "bash ~/.claude/summarizer/start-llm.sh start > /dev/null 2>&1; node ~/.claude/summarizer/summarize.mjs compact",
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
            "command": "node ~/.claude/summarizer/summarize.mjs force; bash ~/.claude/summarizer/start-llm.sh stop > /dev/null 2>&1",
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
            "command": "bash ~/.claude/summarizer/start-llm.sh start > /dev/null 2>&1; node ~/.claude/summarizer/summarize.mjs restore",
            "timeout": 30
          }
        ]
      },
      {
        "matcher": "clear",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/summarizer/start-llm.sh start > /dev/null 2>&1; node ~/.claude/summarizer/summarize.mjs restore",
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
bash ~/.claude/summarizer/start-llm.sh start
curl -s http://localhost:8922/v1/models | head -1
echo '{}' | node ~/.claude/summarizer/summarize.mjs incremental
echo $?  # Should be 0
```

## 7. Restart Claude Code

Close and reopen Claude Code. The hooks will activate automatically.
