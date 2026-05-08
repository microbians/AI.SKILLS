# SafeEdit

Safer replacement for `sed -i`, `perl -i`, and `awk -i inplace` for mass file edits in Claude Code sessions. Ships as a Node CLI plus a PreToolUse hook that blocks the dangerous commands and points you at the safer one.

## Why

In-place editors corrupt files when:
- A regex slips and matches more than intended.
- The edit is interrupted mid-write (Ctrl-C, OS kill, full disk).
- Multibyte/charset mismatch turns the rewrite into garbage.
- `sed -i ''` (macOS) vs `sed -i` (Linux) is forgotten.

`safe-edit`:
- **Always shows a unified diff first** — dry-run is the default, `--apply` is opt-in.
- **Backs up modified files** to a timestamped batch dir under `.safe-edit-backups/`.
- **Auto-prunes** old batches (default: keep last 7 days, max 20 batches).
- **Literal match by default**, `--regex` opt-in.
- **Multiple globs** in one invocation.

## What gets blocked

The PreToolUse hook (`block-inplace-edit.mjs`) inspects every Bash command. It blocks:

| Pattern | Example |
|---|---|
| `sed -i …` | `sed -i 's/x/y/' file` |
| `sed -i.bak …` / `sed -i ''` | `sed -i.bak 's/x/y/' f` / `sed -i '' 's/x/y/' f` |
| `sed --in-place` | `sed --in-place 's/x/y/' file` |
| `perl -i` / `perl -pi` / `perl -ni` | `perl -pi -e 's/x/y/' file` |
| `awk -i inplace` / `gawk -i inplace` | `awk -i inplace '{...}' file` |

It does **NOT** block read-only sed/awk/perl:

```bash
cat file | sed 's/x/y/'    # filter to stdout — fine
sed -n '10,20p' file       # print range — fine
awk '{print $1}' file      # extract column — fine
```

The rule: if the command rewrites a file in place, it's blocked. If it emits to stdout, it passes.

## Install

```bash
bash install.sh
```

Installs:
- `~/.claude/safe-edit/safe-edit.mjs` — the CLI
- `~/.claude/safe-edit/block-inplace-edit.mjs` — the PreToolUse hook
- `~/.claude/skills/safe-edit/SKILL.md` — the behavior rules
- A `PreToolUse` hook entry in `~/.claude/settings.json`
- A pointer snippet in `~/.claude/CLAUDE.md`

## Usage

```bash
# Dry-run (default) — preview the diff, no writes
node ~/.claude/safe-edit/safe-edit.mjs replace \
  --find "OldName" --with "NewName" --files "src/**/*.ts"

# Apply
node ~/.claude/safe-edit/safe-edit.mjs replace \
  --find "OldName" --with "NewName" --files "src/**/*.ts" --apply

# Regex mode with backrefs
node ~/.claude/safe-edit/safe-edit.mjs replace --regex \
  --find "v(\d+)\.(\d+)" --with "v\$1.\$2.0" \
  --files "**/*.md" --apply

# Skip backups (you trust git)
... --apply --no-backup

# Tune retention (or set SAFE_EDIT_KEEP_DAYS / SAFE_EDIT_KEEP_BATCHES)
... --apply --keep-days 14 --keep-batches 50
```

`--help` prints the full reference.

## Backup retention

At the start of every `--apply`, safe-edit prunes `.safe-edit-backups/`:

- **By age:** delete batches older than `--keep-days` (default 7, `0` disables).
- **By count:** keep at most `--keep-batches` most-recent (default 20, `0` disables).

Both run; whichever fires first wins.

To revert a batch:

```bash
cp -r .safe-edit-backups/20260508-143022/. .
```

Add `.safe-edit-backups/` to `.gitignore`.

## Uninstall

```bash
bash install.sh --uninstall
```

Removes the directory, the skill, the hook entry, and the CLAUDE.md snippet.

## Layout

```
SafeEdit/
  README.md                   ← this file
  install.sh                  ← installer (idempotent, --uninstall supported)
  hooks.json                  ← PreToolUse hook merged into settings.json
  src/
    safe-edit.mjs             ← the CLI
    block-inplace-edit.mjs    ← the PreToolUse blocker
    package.json              ← deps (glob)
    claude-md-snippet.md      ← snippet appended to ~/.claude/CLAUDE.md
  skill/
    SKILL.md                  ← behavior rules for Claude
```
