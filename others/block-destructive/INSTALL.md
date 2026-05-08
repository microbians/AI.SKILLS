# Manual Installation Guide

If you prefer to install `block-destructive` manually instead of using `install.sh`, follow these steps.

## 1. Copy the hook script

```bash
mkdir -p ~/.claude/hooks
cp src/block-destructive.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/block-destructive.sh
```

## 2. Register the hook in `settings.json`

Open `~/.claude/settings.json` and merge the `PreToolUse` entry below into the existing `hooks` section (do not replace other hooks):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/block-destructive.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

## 3. Verify dependencies

The hook uses `jq` to read/write JSON:

```bash
command -v jq || brew install jq   # macOS
command -v jq || sudo apt install jq  # Debian/Ubuntu
```

## 4. Test the hook

Block test (should fail with a BLOCKED message):

```bash
echo '{"tool_input":{"command":"rm -rf /tmp/whatever"}}' | bash ~/.claude/hooks/block-destructive.sh
```

Escape-hatch test (should exit with no output):

```bash
echo '{"tool_input":{"command":"rm -rf /tmp/whatever # approved"}}' | bash ~/.claude/hooks/block-destructive.sh
```

## 5. Restart Claude Code

Close and reopen Claude Code. The hook now runs on every Bash tool call, globally across all projects.

---

## Uninstall

```bash
bash install.sh --uninstall
```

Or manually remove `~/.claude/hooks/block-destructive.sh` and delete the matching entry from `~/.claude/settings.json`.
