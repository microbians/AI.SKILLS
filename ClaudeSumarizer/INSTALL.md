# Manual Installation Guide

If you prefer to install ClaudeSumarizer manually instead of using `install.sh`, follow these steps.

## 1. Create directory and copy files

```bash
mkdir -p ~/.claude/summarizer/models

# Copy source files
cp src/summarize.mjs ~/.claude/summarizer/
cp src/start-llm.sh ~/.claude/summarizer/
cp src/config.json ~/.claude/summarizer/
cp src/package.json ~/.claude/summarizer/

# Make start-llm.sh executable
chmod +x ~/.claude/summarizer/start-llm.sh
```

## 2. Install dependencies

```bash
cd ~/.claude/summarizer
npm install
```

## 3. Download the model

```bash
curl -L -o ~/.claude/summarizer/models/qwen2.5-3b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
```

This is ~2GB. You can use any other GGUF model — just update `config.json` and `start-llm.sh`.

## 4. Add hooks to settings.json

Open `~/.claude/settings.json` and add these hooks to the `hooks` object. If you already have hooks, merge them — don't replace.

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
            "timeout": 30
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
            "command": "bash ~/.claude/summarizer/start-llm.sh stop > /dev/null 2>&1",
            "timeout": 5
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

## 5. Verify

```bash
# Start the LLM server
bash ~/.claude/summarizer/start-llm.sh start

# Check it responds
curl -s http://localhost:8922/v1/models | head -1

# Test summarizer (should exit silently — no stdin)
echo '{}' | node ~/.claude/summarizer/summarize.mjs incremental
echo $?  # Should be 0
```

## 6. Restart Claude Code

Close and reopen Claude Code. The hooks will activate automatically.
