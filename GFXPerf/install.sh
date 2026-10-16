#!/usr/bin/env bash
# gfx-perf installer
#
# Installs the gfx-perf skill into ~/.claude/skills/ (or into a project's
# .claude/skills/ with --project) and adds the "Graphics performance" section
# to CLAUDE.md so the skill is invoked without being asked for.
#
#   ./install.sh                       user-wide
#   ./install.sh --project             into ./.claude of the current folder
#   ./install.sh --project --skill-only   the skill alone, CLAUDE.md untouched
#   ./install.sh [--project] --uninstall
#
# Idempotent: re-running upgrades in place and refreshes the CLAUDE.md section.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skill"
SNIPPET="$SCRIPT_DIR/src/claude-md-snippet.md"
SNIPPET_MATCH="## Graphics performance (JavaScript, Canvas2D, WebGPU)"

# Version comes from the SKILL.md frontmatter — ONE source of truth, so the
# installer can never claim a version the skill doesn't carry.
VERSION="$(sed -n 's/^version: *//p' "$SKILL_SRC/SKILL.md" | head -1)"
[ -n "$VERSION" ] || VERSION="0.0.0"

GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; NC="\033[0m"
info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ─── OPTIONS ─────────────────────────────────────────────────────
# Default: user-wide (~/.claude). --project installs into ./.claude instead.

PROJECT=0; UNINSTALL=0; SKILL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --project) PROJECT=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --skill-only) SKILL_ONLY=1 ;;
    *) error "Unknown option: $arg" ;;
  esac
done

if [ "$PROJECT" = 1 ]; then
  BASE="$(pwd)/.claude"
  SCOPE="project ($(pwd))"
else
  BASE="$HOME/.claude"
  SCOPE="user-wide"
fi
SKILL_DEST="$BASE/skills/gfx-perf"
CLAUDE_MD="$BASE/CLAUDE.md"

# Our CLAUDE.md section, wherever it starts — from the version marker if
# present, otherwise from the heading — up to the next "## " heading.
strip_section() {
  awk -v m="$SNIPPET_MATCH" '
    /^<!-- skill: gfx-perf v/ { skip = 1; next }
    $0 == m { skip = 1; next }
    skip && /^## / { skip = 0 }
    !skip { print }
  ' "$1"
}

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$UNINSTALL" = 1 ]; then
  echo "Uninstalling gfx-perf ($SCOPE)..."
  [ -d "$SKILL_DEST" ] && rm -rf "$SKILL_DEST" && info "Removed $SKILL_DEST"
  if [ -f "$CLAUDE_MD" ] && grep -qF "$SNIPPET_MATCH" "$CLAUDE_MD" 2>/dev/null; then
    strip_section "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
    info "Removed the CLAUDE.md section"
  fi
  info "Done."
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

[ -f "$SKILL_SRC/SKILL.md" ] || error "skill/SKILL.md not found next to this script"

# What is installed right now? Report the transition so an upgrade is visible
# instead of a silent overwrite.
INSTALLED="$(sed -n 's/^version: *//p' "$SKILL_DEST/SKILL.md" 2>/dev/null | head -1)"
if [ -z "$INSTALLED" ]; then
  echo "Installing gfx-perf v$VERSION ($SCOPE)..."
elif [ "$INSTALLED" = "$VERSION" ]; then
  # Same version number, but the files may still differ — a content check
  # catches edits that nobody bumped the version for.
  if diff -rq "$SKILL_SRC" "$SKILL_DEST" >/dev/null 2>&1; then
    echo "gfx-perf v$VERSION already installed and identical ($SCOPE) — refreshing anyway."
  else
    warn "Same version ($VERSION) but the content DIFFERS — one side was edited without bumping the version."
  fi
else
  echo "Upgrading gfx-perf: v$INSTALLED → v$VERSION ($SCOPE)..."
fi

# The skill's own files replace what was there (a file dropped from the skill
# must not linger); nothing else lives in that folder.
rm -rf "$SKILL_DEST"
mkdir -p "$SKILL_DEST"
cp -R "$SKILL_SRC/." "$SKILL_DEST/"
find "$SKILL_DEST" -name '.DS_Store' -delete 2>/dev/null || true
chmod +x "$SKILL_DEST/scripts/fetch-specs.sh" 2>/dev/null || true
info "Skill v$VERSION installed at $SKILL_DEST"

# ─── CLAUDE.md section ───────────────────────────────────────────
# Replace the existing section when present (so an upgrade refreshes the text),
# otherwise append it. Never duplicate.

if [ "$SKILL_ONLY" = 1 ]; then
  info "CLAUDE.md left as it is (--skill-only)"
else
  SNIPPET_TEXT=""
  [ -f "$SNIPPET" ] && SNIPPET_TEXT="$(sed "s/SKILL_VERSION/$VERSION/" "$SNIPPET")"

  if [ -z "$SNIPPET_TEXT" ]; then
    warn "src/claude-md-snippet.md missing — skipping the CLAUDE.md section"
  elif [ ! -f "$CLAUDE_MD" ]; then
    mkdir -p "$BASE"
    printf '%s\n' "$SNIPPET_TEXT" > "$CLAUDE_MD"
    info "Created $CLAUDE_MD with the Graphics performance section (v$VERSION)"
  elif grep -qF "$SNIPPET_MATCH" "$CLAUDE_MD" 2>/dev/null; then
    PREV="$(sed -n 's/^<!-- skill: gfx-perf v\(.*\) -->$/\1/p' "$CLAUDE_MD" | head -1)"
    strip_section "$CLAUDE_MD" > "$CLAUDE_MD.tmp"
    printf '%s\n\n' "$(cat "$CLAUDE_MD.tmp")" > "$CLAUDE_MD"
    rm -f "$CLAUDE_MD.tmp"
    printf '%s\n' "$SNIPPET_TEXT" >> "$CLAUDE_MD"
    if [ -n "$PREV" ] && [ "$PREV" != "$VERSION" ]; then
      info "Updated the Graphics performance section in $CLAUDE_MD (v$PREV → v$VERSION)"
    else
      info "Refreshed the Graphics performance section in $CLAUDE_MD (v$VERSION)"
    fi
  else
    printf '\n%s\n' "$SNIPPET_TEXT" >> "$CLAUDE_MD"
    info "Added the Graphics performance section to $CLAUDE_MD (v$VERSION)"
  fi
fi

echo
info "Done. The skill loads as \`gfx-perf\`."
echo "   Specifications for local search: sh $SKILL_DEST/scripts/fetch-specs.sh"
echo "   Uninstall with: $0$([ "$PROJECT" = 1 ] && echo ' --project') --uninstall"
