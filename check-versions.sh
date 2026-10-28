#!/usr/bin/env bash
# Version report: what this repo ships vs what is installed in ~/.claude.
#
# Answers "is anything out of date?" in one glance — the question that had no
# answer when the global CLAUDE.md (claude-md/) silently drifted 25 lines behind the
# installed copy.
#
# Compares BOTH the declared version AND the file content, because a version
# number only helps when somebody remembered to bump it.

GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; DIM="\033[2m"; NC="\033[0m"
REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"

ver() { sed -n 's/^version: *//p' "$1" 2>/dev/null | head -1; }

row() { # name  repo_file  installed_file
  local name="$1" src="$2" dst="$3"
  local vs vd status

  if [ ! -f "$src" ]; then return; fi
  vs="$(ver "$src")"; vs="${vs:-—}"

  if [ ! -f "$dst" ]; then
    status="${DIM}not installed${NC}"
    printf "  %-30s %-9s %-9s %b\n" "$name" "$vs" "—" "$status"
    return
  fi
  vd="$(ver "$dst")"; vd="${vd:-—}"

  # A symlinked skill points AT the repo, so it can never drift — say so
  # explicitly instead of reporting a content comparison against itself.
  if [ -L "$(dirname "$dst")" ]; then
    printf "  %-30s %-9s %-9s %b\n" "$name" "$vs" "$vd" "${GREEN}linked${NC} ${DIM}(always current)${NC}"
    return
  fi

  if cmp -s "$src" "$dst"; then
    status="${GREEN}in sync${NC}"
  elif [ "$vs" = "$vd" ]; then
    status="${RED}SAME VERSION, DIFFERENT CONTENT${NC}"
  else
    status="${YELLOW}outdated → reinstall${NC}"
  fi
  printf "  %-30s %-9s %-9s %b\n" "$name" "$vs" "$vd" "$status"
}

echo
echo "AI.SKILLS — version report"
echo
printf "  %-30s %-9s %-9s %s\n" "PACKAGE" "REPO" "INSTALLED" "STATUS"
printf "  %-30s %-9s %-9s %s\n" "──────────────────────────────" "─────────" "─────────" "──────"

# Every skill, plugin and tool: its skill is <dir>/SKILL.md (plain skill) or
# <dir>/skill/SKILL.md (package with an installer); installed under its name.
for d in "$REPO"/skills/*/ "$REPO"/plugins/*/ "$REPO"/tools/*/; do
  src="${d}SKILL.md"
  [ -f "$src" ] || src="${d}skill/SKILL.md"
  [ -f "$src" ] || continue
  slug="$(sed -n 's/^name: *//p' "$src" | head -1)"
  row "${d#"$REPO"/}" "$src" "$CLAUDE/skills/$slug/SKILL.md"
done

# The global CLAUDE.md (versioned via an HTML comment on line 1)
if [ -f "$REPO/claude-md/CLAUDE.md" ]; then
  gv() { sed -n 's/^<!-- CLAUDE.md v\([^ ]*\) .*-->$/\1/p' "$1" 2>/dev/null | head -1; }
  vs="$(gv "$REPO/claude-md/CLAUDE.md")"; vs="${vs:-—}"
  if [ -f "$CLAUDE/CLAUDE.md" ]; then
    vd="$(gv "$CLAUDE/CLAUDE.md")"; vd="${vd:-—}"
    if cmp -s "$REPO/claude-md/CLAUDE.md" "$CLAUDE/CLAUDE.md"; then st="${GREEN}in sync${NC}"
    elif [ "$vs" = "$vd" ]; then st="${RED}SAME VERSION, DIFFERENT CONTENT${NC}"
    else st="${YELLOW}outdated${NC}"; fi
    printf "  %-30s %-9s %-9s %b\n" "CLAUDE.md (global)" "$vs" "$vd" "$st"
  else
    printf "  %-30s %-9s %-9s %b\n" "CLAUDE.md (global)" "$vs" "—" "${DIM}not installed${NC}"
  fi
fi

# Skill sections injected into the global CLAUDE.md carry their own marker
echo
if [ -f "$CLAUDE/CLAUDE.md" ] && grep -q '^<!-- skill: ' "$CLAUDE/CLAUDE.md" 2>/dev/null; then
  echo "  CLAUDE.md sections:"
  sed -n 's/^<!-- skill: \(.*\) -->$/    \1/p' "$CLAUDE/CLAUDE.md"
  echo
fi

echo "  Fix anything yellow by re-running that package's install.sh"
echo "  (or copying SKILL.md for the standalone ones)."
echo
