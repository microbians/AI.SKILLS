# block-destructive

> A Claude Code `PreToolUse` hook that blocks destructive Bash commands — even in bypass mode.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  BLOCK-DESTRUCTIVE                                               │
│                                                                  │
│  Claude runs:     rm -rf /path/to/something                      │
│        │                                                         │
│        ▼                                                         │
│  Hook inspects:   matches "rm -rf" pattern                       │
│        │                                                         │
│        ▼                                                         │
│  Decision:        deny  →  Claude must re-plan or ask the user   │
│                                                                  │
│  Escape hatch:    rm -rf /path # approved    →  allowed          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

AI coding agents sometimes reach for destructive shortcuts: `rm -rf`, `git reset --hard`, `DROP TABLE`, `--no-verify`. This hook runs before every Bash tool call and hard-blocks the ones that can destroy work or data.

Works at the harness level, so it applies **even in auto / bypass-permissions mode**.

---

## What it blocks

| Category     | Patterns                                                                  |
| ------------ | ------------------------------------------------------------------------- |
| Filesystem   | `rm -rf`, `mkfs`, `dd if=…`, writes to `/dev/sd*`, `/dev/disk*`, `/dev/nvme*` |
| Git          | `git reset --hard`, `git push --force / -f / --force-with-lease`          |
|              | `git checkout .`, `git clean -f`, `git branch -D`, `git stash drop/clear` |
|              | Any command with `--no-verify`                                            |
| SQL          | `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA`                              |
|              | `TRUNCATE TABLE`, `DELETE FROM …` without `WHERE`, `UPDATE …` without `WHERE` |
| Postgres CLI | `dropdb`                                                                  |
| MongoDB      | `dropDatabase()`, `deleteMany({})`                                        |
| Redis        | `FLUSHDB`, `FLUSHALL`                                                     |

---

## Escape hatch: `# approved`

Append `# approved` at the end of any command to skip all checks. It's a regular bash comment, so it doesn't affect execution:

```bash
rm -rf /tmp/build-artifacts # approved
git reset --hard origin/main # approved
psql -c "TRUNCATE TABLE staging_events" # approved
```

This keeps the agent honest: it has to explicitly re-state that the command is approved, which shows up in logs and transcripts.

---

## Installation

### Automatic

```bash
bash install.sh
```

The installer:

1. Copies `src/block-destructive.sh` to `~/.claude/hooks/`
2. Registers the hook in `~/.claude/settings.json` (merges, doesn't overwrite)
3. Leaves other hooks untouched

### Manual

See [INSTALL.md](INSTALL.md).

### Uninstall

```bash
bash install.sh --uninstall
```

### Requirements

- `jq` (reads hook input, emits deny decisions)
- `node` (for the installer's settings.json merging)
- `bash` 3.2+ (macOS default works)

---

## How it works

Claude Code's `PreToolUse` hook receives the tool call JSON on stdin **before** the tool executes. The hook:

1. Parses `.tool_input.command` with `jq`
2. If the command ends with `# approved`, exits 0 (allow)
3. Otherwise, runs each regex pattern; on match, emits a JSON deny decision:
   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "PreToolUse",
       "permissionDecision": "deny",
       "permissionDecisionReason": "BLOCKED: …"
     }
   }
   ```
4. If no pattern matches, exits 0 (allow)

Because the decision is `deny` (not `ask`), there is no interactive prompt — the command is refused and Claude receives the reason. Claude can then either reformulate or, with explicit user authorization, re-send the command with `# approved`.

The hook is installed **globally** (`~/.claude/`), so it runs for every project on this machine.

---

## Customizing

To add or remove patterns, edit `~/.claude/hooks/block-destructive.sh` directly. Each rule follows the same shape:

```bash
if echo "$cmd" | grep -qE 'your-pattern-here'; then
  block "BLOCKED: reason. Append '# approved' to confirm."
fi
```

Re-run `install.sh` to sync future versions from the repo (the installer overwrites the hook file).

---

## Why not just use `permissions.deny`?

Claude Code's `permissions.deny` in `settings.json` is pattern-based and fires before hooks, but it has two limits:

- No escape hatch — a denied command has no way through short of editing settings
- Harder to express complex rules (e.g. "DELETE FROM … without WHERE")

`block-destructive` complements `permissions.deny`: put static blanket blocks in settings, put pattern logic + escape hatch here.

---

## License

MIT
