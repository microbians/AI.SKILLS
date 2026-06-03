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

### Per-session bypass (only when the user explicitly approves)

The hook supports a per-session opt-out via a marker file under `/tmp`. If the user explicitly says "permite sed -i siempre" / "yes always" / "allow in-place for this session", create the marker:

```bash
touch /tmp/mp-allow-inplace-$CLAUDE_SESSION_ID
```

After that, the hook lets every in-place edit through for the rest of this session. The marker dies on `/tmp` cleanup (reboot), so protection automatically returns in a fresh session.

**Important:** do not create the marker preemptively. The default is "use safe-edit" — the bypass exists only because some workflows (mass rename, codebase migration) genuinely benefit from `sed -i` and re-typing the safe-edit invocation each time gets in the way. Wait for the user to give explicit consent before touching the file.

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
3. **If you need to revert**, see "Undo / revert a batch" below.

## Undo / revert a batch

Every `--apply` writes a batch dir at `.safe-edit-backups/YYYYMMDD-HHMMSS/` containing the **pre-edit** copies of every file changed, with full relative paths preserved. The summary line printed by safe-edit names the batch (e.g. `backups: .safe-edit-backups/20260508-143022`).

### Step 1 — find the right batch

```bash
ls -lt .safe-edit-backups/                    # newest first
ls .safe-edit-backups/20260508-143022/        # see which files were touched
```

If you're not sure which batch corresponds to which edit, diff the backup against the current file:

```bash
diff -u .safe-edit-backups/20260508-143022/src/foo.ts src/foo.ts
```

### Step 2 — preview what the revert will change

**Before pisando nada**, see exactly what going back to the backup would do:

```bash
# For one file
diff -u src/foo.ts .safe-edit-backups/20260508-143022/src/foo.ts

# For the whole batch (recursive, only files that differ)
diff -ruN . .safe-edit-backups/20260508-143022/ \
  | grep -E '^(diff|---|\+\+\+|@@)'
```

If the user has made other edits on top of the safe-edit changes, the diff will show those too — flag this to the user before reverting.

### Step 3 — revert

**Option A: revert a single file** (most common, safest):

```bash
cp .safe-edit-backups/20260508-143022/src/foo.ts src/foo.ts
```

**Option B: revert the entire batch** (only if every change in that batch was wrong):

```bash
cp -R .safe-edit-backups/20260508-143022/. .
```

The trailing `/.` (NOT `/*`) ensures hidden files are included. `cp -R` preserves the directory structure verbatim.

**Option C: use git instead** (preferred when the project is a git repo and was clean before the edit):

```bash
git diff src/foo.ts                    # see what safe-edit changed
git checkout -- src/foo.ts             # revert via git
```

### Things to watch for

- **Other edits on top.** If the user (or another tool) edited the same file after safe-edit, copying the backup will silently lose those edits. Always diff first.
- **Backup pruning.** Batches older than `--keep-days` (default 7) or beyond `--keep-batches` (default 20) are deleted at the start of every new `--apply`. If you need to revert something old, do it BEFORE running another safe-edit.
- **No "undo" subcommand.** safe-edit deliberately doesn't ship an `undo` command — copying files back is transparent and gives the user a chance to inspect first.

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
