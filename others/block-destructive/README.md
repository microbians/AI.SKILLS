# block-destructive

> A Claude Code `PreToolUse` hook that intercepts destructive Bash commands and asks the user for confirmation via the native approval dialog — even in bypass mode.

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
│  Decision:        ask   →  native dialog asks user to confirm    │
│                                                                  │
│  Pre-authorized:  user's last prompt said "dale" / "approved"    │
│                   / "borra" / "force" / "hazlo" → runs directly  │
│                                                                  │
│  Escape hatch:    rm -rf /path # approved + last prompt OK       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

AI coding agents sometimes reach for destructive shortcuts: `rm -rf`, `git reset --hard`, `DROP TABLE`, `--no-verify`. This hook runs before every Bash tool call and intercepts the ones that can destroy work or data.

Instead of hard-denying (which forced a 3-turn dance: run → error → user types "approved" → retry), it emits `permissionDecision: "ask"` so Claude Code shows the **native approval dialog** before executing. One click, one turn, no keyword magic.

Works at the harness level, so it applies **even in auto / bypass-permissions mode**.

---

## What it intercepts

| Category     | Patterns                                                                  |
| ------------ | ------------------------------------------------------------------------- |
| Filesystem   | `rm -rf`, `mkfs`, `dd if=…`, writes to `/dev/sd*`, `/dev/disk*`, `/dev/nvme*` |
| Git          | `git reset --hard`, `git push --force / -f / --force-with-lease`          |
|              | `git checkout .`, `git restore .`, `git clean -f`, `git branch -D`, `git stash drop/clear` |
|              | Any command with `--no-verify`                                            |
| SQL          | `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA`                              |
|              | `TRUNCATE TABLE`, `DELETE FROM …` without `WHERE`, `UPDATE …` without `WHERE` |
| Postgres CLI | `dropdb`                                                                  |
| MongoDB      | `dropDatabase()`, `deleteMany({})`                                        |
| Redis        | `FLUSHDB`, `FLUSHALL`                                                     |

---

## Pre-authorization (skip the dialog)

The hook checks the user's **last prompt** in this session for authorization keywords. If found, the command runs without showing the dialog:

`approved`, `aprobado`, `apruebo`, `autorizo`, `force`, `forzar`, `dale`, `ok force`, `borra`, `sí borra`, `sí adelante`, `sí hazlo`, `adelante`, `hazlo`.

Example:

```
user: "dale, borra esa rama"
claude: git branch -D feat/old  →  runs directly (user authorized)
```

Otherwise the native dialog appears and the user clicks **Allow** / **Deny** / **Always allow**.

---

## Escape hatch: `# approved`

Append `# approved` at the end of any command. It is a regular bash comment, so it doesn't affect execution:

```bash
rm -rf /tmp/build-artifacts # approved
git reset --hard origin/main # approved
```

This still requires the user's last prompt to contain an authorization keyword — to prevent Claude from self-approving by just appending the comment. If the keyword is missing, the dialog is shown instead.

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

- `jq` (reads hook input, emits ask decisions)
- `node` (for the installer's settings.json merging)
- `bash` 3.2+ (macOS default works)

---

## How it works

Claude Code's `PreToolUse` hook receives the tool call JSON on stdin **before** the tool executes. The hook:

1. Parses `.tool_input.command` with `jq`
2. Checks if the user's last prompt contains an authorization keyword
3. If authorized → exits 0 (allow)
4. Otherwise, runs each regex pattern; on match, emits a JSON ask decision:
   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "PreToolUse",
       "permissionDecision": "ask",
       "permissionDecisionReason": "Destructive command: …"
     }
   }
   ```
5. Claude Code shows the native approval dialog with the reason
6. If no pattern matches, exits 0 (allow)

The hook is installed **globally** (`~/.claude/`), so it runs for every project on this machine.

---

## Why `ask` instead of `deny`?

Earlier versions of this hook used `permissionDecision: "deny"`. That forced an awkward 3-turn loop:

1. Claude runs the command.
2. Hook denies with an error message telling Claude to retry with `# approved`.
3. Claude asks the user.
4. User says "approved".
5. Claude re-runs with `# approved`.

With `ask`, Claude Code shows its built-in approval dialog before the command runs. The user clicks **Allow** (or **Always allow**) and the command executes immediately. No retries, no keyword detection in the prompt stream, no model behavior changes needed.

---

## Customizing

To add or remove patterns, edit `~/.claude/hooks/block-destructive.sh` directly. Each rule follows the same shape:

```bash
if echo "$cmd" | grep -qE 'your-pattern-here'; then
  ask "Destructive command: <description>."
fi
```

Re-run `install.sh` to sync future versions from the repo (the installer overwrites the hook file).

---

## Why not just use `permissions.ask`?

Claude Code's `permissions.ask` in `settings.json` is pattern-based and fires before hooks, but it has two limits:

- Limited regex syntax — harder to express "DELETE FROM … without WHERE" or "any flag with --no-verify"
- No pre-authorization from prompt context

`block-destructive` complements `permissions.ask`: put simple blanket asks in settings, put pattern logic + pre-authorization here.

---

## License

MIT
