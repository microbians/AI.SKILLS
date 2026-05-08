# CLAUDE.Global

Reference copy of the **global `CLAUDE.md`** used across all Claude Code sessions on this machine. Lives at `~/.claude/CLAUDE.md` once installed.

This file holds behavior rules, FTP/SFTP guidelines, and pointers to the skills (`ascii-art-diagrams`, `the-secretary`) that handle the rest. It's intentionally terse: only what helps Claude act correctly, no rationale or filler.

## What's inside

- **Behavior Rules** — the non-negotiable habits Claude must keep across every project (no reverting without permission, no long sleeps, reuse before duplicate, finish in-flight tasks, acknowledge mistakes flat, just-do-it instead of asking, read code before debugging, etc.).
- **FTP / SFTP — Avoid firewall bans** — single-paragraph rules + ready-to-paste `lftp` patterns. Designed to prevent CSF/LFD bans on shared hosting.
- **ASCII Art Diagrams** — pointer to the `ascii-art-diagrams` skill (verifies Unicode column counts, prevents misaligned tree characters).
- **Memory / notes / reminders / recall** — pointer to the `the-secretary` skill (recall commands, triggers, scope, config). The actual context-persistence engine is installed separately via [`TheSecretary/install.sh`](../TheSecretary/install.sh).

## Install

### Fresh install

```bash
mkdir -p ~/.claude
cp CLAUDE.md ~/.claude/CLAUDE.md
```

### Existing CLAUDE.md (don't overwrite — merge)

If `~/.claude/CLAUDE.md` already exists with rules you want to keep, open both files side by side and merge by section:

```bash
diff ~/.claude/CLAUDE.md CLAUDE.md
```

Sections in this file (`## Behavior Rules`, `## FTP / SFTP`, `## ASCII Art Diagrams`, `## Memory / notes / reminders / recall`) can be appended individually, or replaced if your local versions are stale.

### Required skills

The two pointer sections in `CLAUDE.md` reference skills that must also be installed under `~/.claude/skills/`:

- **`the-secretary`** — installed automatically by [`TheSecretary/install.sh`](../TheSecretary/install.sh).
- **`ascii-art-diagrams`** — copy from [`../skills/ascii-art-diagrams/`](../skills/ascii-art-diagrams/) to `~/.claude/skills/ascii-art-diagrams/`.

If the skills are missing, the `STRICTLY follow the X skill` lines in `CLAUDE.md` won't resolve to anything and the relevant rules will be lost.

## Updating

When the canonical global `CLAUDE.md` changes:

```bash
cp ~/.claude/CLAUDE.md CLAUDE.md
```

Then commit the diff so the repo always reflects what's actually in `~/.claude/`.

## Uninstall

```bash
rm ~/.claude/CLAUDE.md
```

(This removes ALL global rules — Claude will fall back to defaults plus any project-level `CLAUDE.md`.)

## Philosophy

- **English only** for all rules (the user converses in Spanish, but persistent artefacts stay in English so they're stable across language switches).
- **Action-only**, no rationale unless strictly necessary. Rules describe *what to do / what not to do*, not *why* — the why lives in commit history, PRs, or skill READMEs.
- **Skills over inline docs**: long sections (memory engine, ASCII verification) live in dedicated skills so they only consume context when actually relevant, instead of bloating every session.
