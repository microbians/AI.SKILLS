#!/usr/bin/env bash
# secure-coding installer
#
# Installs the secure-coding skill into ~/.claude/skills/ (or into a project's
# .claude/skills/ with --project) and adds the "Security & data integrity"
# section to CLAUDE.md so the skill is invoked without being asked for.
#
# Idempotent: re-running upgrades in place and refreshes the CLAUDE.md section.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SNIPPET="$SCRIPT_DIR/src/claude-md-snippet.md"
SNIPPET_MATCH="## Security & data integrity"

# Version comes from the SKILL.md frontmatter — ONE source of truth, so the
# installer can never claim a version the skill doesn't carry.
VERSION="$(sed -n 's/^version: *//p' "$SCRIPT_DIR/SKILL.md" | head -1)"
[ -n "$VERSION" ] || VERSION="0.0.0"

GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; NC="\033[0m"
info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ─── TARGET ──────────────────────────────────────────────────────
# Default: user-wide (~/.claude). --project installs into ./.claude instead.

if [ "$1" = "--project" ] || [ "$2" = "--project" ]; then
  BASE="$(pwd)/.claude"
  SCOPE="project ($(pwd))"
else
  BASE="$HOME/.claude"
  SCOPE="user-wide"
fi
SKILL_DEST="$BASE/skills/secure-coding"
CLAUDE_MD="$BASE/CLAUDE.md"

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling secure-coding ($SCOPE)..."
  [ -d "$SKILL_DEST" ] && rm -rf "$SKILL_DEST" && info "Removed $SKILL_DEST"

  if [ -f "$CLAUDE_MD" ] && grep -q "$SNIPPET_MATCH" "$CLAUDE_MD" 2>/dev/null; then
    # Drop the section: from the version marker (or the heading, when the
    # section predates versioning) to just before the next "## " heading.
    awk -v m="$SNIPPET_MATCH" '
      /^<!-- skill: secure-coding v/ { skip = 1; next }
      $0 == m { skip = 1; next }
      skip && /^## / { skip = 0 }
      !skip { print }
    ' "$CLAUDE_MD" > "$CLAUDE_MD.tmp" && mv "$CLAUDE_MD.tmp" "$CLAUDE_MD"
    info "Removed the CLAUDE.md section"
  fi
  info "Done."
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

[ -f "$SCRIPT_DIR/SKILL.md" ] || error "SKILL.md not found next to this script"

# What is installed right now? Report the transition so an upgrade is visible
# instead of a silent overwrite.
INSTALLED="$(sed -n 's/^version: *//p' "$SKILL_DEST/SKILL.md" 2>/dev/null | head -1)"
if [ -z "$INSTALLED" ]; then
  echo "Installing secure-coding v$VERSION ($SCOPE)..."
elif [ "$INSTALLED" = "$VERSION" ]; then
  # Same version number, but the file may still differ — a hash check catches
  # edits that nobody bumped the version for (exactly how a versioned copy
  # drifts out of sync without anyone noticing).
  if cmp -s "$SCRIPT_DIR/SKILL.md" "$SKILL_DEST/SKILL.md"; then
    echo "secure-coding v$VERSION already installed and identical ($SCOPE) — refreshing anyway."
  else
    warn "Same version ($VERSION) but the content DIFFERS — one side was edited without bumping the version."
  fi
else
  echo "Upgrading secure-coding: v$INSTALLED → v$VERSION ($SCOPE)..."
fi

mkdir -p "$SKILL_DEST"
cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DEST/SKILL.md"
[ -f "$SCRIPT_DIR/README.md" ] && cp "$SCRIPT_DIR/README.md" "$SKILL_DEST/README.md"
info "Skill v$VERSION installed at $SKILL_DEST"

# ─── CLAUDE.md section ───────────────────────────────────────────
# Replace the existing section when present (so an upgrade refreshes the text),
# otherwise append it. Never duplicate.

SNIPPET_TEXT=""
[ -f "$SNIPPET" ] && SNIPPET_TEXT="$(sed "s/SKILL_VERSION/$VERSION/" "$SNIPPET")"

# Strip our section wherever it starts — from the version marker if present,
# otherwise from the heading — up to the next "## " heading.
strip_section() {
  awk -v m="$SNIPPET_MATCH" '
    /^<!-- skill: secure-coding v/ { skip = 1; next }
    $0 == m { skip = 1; next }
    skip && /^## / { skip = 0 }
    !skip { print }
  ' "$1"
}

if [ -z "$SNIPPET_TEXT" ]; then
  warn "src/claude-md-snippet.md missing — skipping the CLAUDE.md section"
elif [ ! -f "$CLAUDE_MD" ]; then
  mkdir -p "$BASE"
  printf '%s\n' "$SNIPPET_TEXT" > "$CLAUDE_MD"
  info "Created $CLAUDE_MD with the Security section (v$VERSION)"
elif grep -q "$SNIPPET_MATCH" "$CLAUDE_MD" 2>/dev/null; then
  PREV="$(sed -n 's/^<!-- skill: secure-coding v\(.*\) -->$/\1/p' "$CLAUDE_MD" | head -1)"
  strip_section "$CLAUDE_MD" > "$CLAUDE_MD.tmp"
  printf '%s\n\n' "$(cat "$CLAUDE_MD.tmp")" > "$CLAUDE_MD"
  rm -f "$CLAUDE_MD.tmp"
  printf '%s\n' "$SNIPPET_TEXT" >> "$CLAUDE_MD"
  if [ -n "$PREV" ] && [ "$PREV" != "$VERSION" ]; then
    info "Updated the Security section in $CLAUDE_MD (v$PREV → v$VERSION)"
  else
    info "Refreshed the Security section in $CLAUDE_MD (v$VERSION)"
  fi
else
  printf '\n%s\n' "$SNIPPET_TEXT" >> "$CLAUDE_MD"
  info "Added the Security section to $CLAUDE_MD (v$VERSION)"
fi

echo
info "Done. The skill loads as \`secure-coding\`."
echo "   Uninstall with: $0 --uninstall"
