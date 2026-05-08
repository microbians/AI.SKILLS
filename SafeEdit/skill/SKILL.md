---
name: safe-edit
description: Safer alternative to sed -i / perl -i / awk -i inplace for mass file edits. Use whenever you need to find-and-replace across multiple files, rename a symbol project-wide, bump a version string, or apply a regex transform to many files. A PreToolUse hook automatically blocks in-place sed/perl/awk to prevent accidental file corruption — use this skill instead.
license: MIT
---

# safe-edit

A Node CLI that replaces `sed -i` and friends for mass file edits. Shows a unified diff before writing, backs up modified files to a timestamped batch dir, and auto-prunes old batches.

## When to use

- Renaming a symbol or string across many files (`OldName` → `NewName`).
- Bumping version strings, dates, copyright years, etc.
- Applying a regex transform to a glob of files.
- ANY edit where the alternative would have been `sed -i`, `perl -i`, `awk -i inplace`, or `gawk -i inplace`.

For single-file targeted edits, prefer the `Edit` tool — it's safer because it requires reading the file first.

## Hard rule

The PreToolUse hook installed alongside this skill **blocks** `sed -i`, `perl -i`, `awk -i inplace`, and `gawk -i inplace` in Bash commands. Read-only sed/awk/perl (`cat | sed`, `awk '{print}'`, `sed -n`) still works. Don't try to bypass — use safe-edit.

## Invocation

```bash
node ~/.claude/safe-edit/safe-edit.mjs replace \
  --find "PATTERN" --with "REPLACEMENT" \
  --files "GLOB" [--files "GLOB2" ...] \
  [--regex] [--flags "g"] \
  [--apply] [--no-backup] \
  [--keep-days N] [--keep-batches N] \
  [--root DIR] [--quiet]
```

**Defaults:**
- Literal string match (no regex). Add `--regex` for regex mode.
- Dry-run. You MUST pass `--apply` to actually write.
- Backups ON when applying. Disable with `--no-backup`.
- Backup retention: keep batches from the last 7 days, max 20 batches.

## Workflow

1. **Always dry-run first** (omit `--apply`). Read the unified diff. Confirm replacement count looks sane.
2. **Then apply** (add `--apply`). The script writes files and prints the backup path.
3. **If you need to revert**, copy the batch back: `cp -r .safe-edit-backups/<timestamp>/. .`

## Shell quoting (important)

In bash, **always wrap `--find` and `--with` in SINGLE quotes** when using regex backrefs. Double quotes cause the shell to expand `$1`, `$2`, etc. before they reach Node, so backrefs become empty strings.

```bash
# WRONG — shell eats the backref
... --regex --find "(café|über)" --with "<$1>" ...    # → "<>"

# RIGHT — single quotes, backref reaches Node intact
... --regex --find '(café|über)' --with '<$1>' ...    # → "<café>", "<über>"
```

Single quotes are also safer for patterns containing spaces, parentheses, asterisks, and Unicode.

## Examples

```bash
# Preview a literal rename across TS files
node ~/.claude/safe-edit/safe-edit.mjs replace \
  --find "OldName" --with "NewName" --files "src/**/*.ts"

# Apply it
node ~/.claude/safe-edit/safe-edit.mjs replace \
  --find "OldName" --with "NewName" --files "src/**/*.ts" --apply

# Regex with backref ($1, $2, $&)
node ~/.claude/safe-edit/safe-edit.mjs replace --regex \
  --find "v(\d+)\.(\d+)" --with "v\$1.\$2.0" \
  --files "**/*.md" --apply

# Multiple globs, skip backup (you trust git)
node ~/.claude/safe-edit/safe-edit.mjs replace \
  --find "x" --with "y" \
  --files "a/*.js" --files "b/*.js" \
  --apply --no-backup
```

## Backup location and retention

- **Where:** `.safe-edit-backups/YYYYMMDD-HHMMSS/` at the project root (cwd, or `--root`).
- **Structure:** preserves relative paths inside the batch dir.
- **Retention:** runs automatically at the start of every `--apply`. Two limits, whichever fires first:
  - `--keep-days N` (default 7, env `SAFE_EDIT_KEEP_DAYS`, `0` disables age limit)
  - `--keep-batches N` (default 20, env `SAFE_EDIT_KEEP_BATCHES`, `0` disables count limit)
- Add `.safe-edit-backups/` to `.gitignore`.

## What does NOT trigger the hook

These are reads/filters and pass through unchanged:

```bash
cat file | sed 's/x/y/'             # write to stdout
sed -n '10,20p' file                # print range
awk '{print $1}' file               # extract column
grep -E 'foo' file                  # search
```

## What DOES trigger the hook (and gets blocked)

```bash
sed -i 's/x/y/' file                # in-place
sed -i.bak 's/x/y/' file
sed -i '' 's/x/y/' file             # macOS form
perl -i -pe 's/x/y/' file
perl -pi -e 's/x/y/' file
awk -i inplace '{...}' file
gawk -i inplace '{...}' file
```
