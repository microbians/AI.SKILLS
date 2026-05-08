#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# block-destructive — Installer
# PreToolUse hook that blocks dangerous Bash commands in Claude Code
# Usage: bash install.sh [--uninstall]
# ═══════════════════════════════════════════════════════════════════

set -e

DEST_DIR="$HOME/.claude/hooks"
HOOK_FILE="$DEST_DIR/block-destructive.sh"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

HOOK_MATCH="block-destructive"

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling block-destructive hook..."

  if [ -f "$SETTINGS" ] && command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
      if (s.hooks && s.hooks.PreToolUse) {
        s.hooks.PreToolUse = s.hooks.PreToolUse.filter(m =>
          !m.hooks?.some(h => h.command?.includes('block-destructive'))
        );
        if (s.hooks.PreToolUse.length === 0) delete s.hooks.PreToolUse;
      }
      fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2));
    "
    info "Removed hook from $SETTINGS"
  fi

  [ -f "$HOOK_FILE" ] && rm "$HOOK_FILE" && info "Removed $HOOK_FILE"
  info "Uninstall complete. Restart Claude Code."
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

echo "Installing block-destructive hook..."

# Check deps
command -v jq &>/dev/null   || error "jq not found. Install with: brew install jq"
command -v node &>/dev/null || error "node not found. Needed to merge settings.json."

# Copy hook script
mkdir -p "$DEST_DIR"
cp "$SCRIPT_DIR/src/block-destructive.sh" "$HOOK_FILE"
chmod +x "$HOOK_FILE"
info "Installed hook: $HOOK_FILE"

# Merge hook into settings.json
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
  s.hooks = s.hooks || {};
  s.hooks.PreToolUse = s.hooks.PreToolUse || [];

  // Remove existing block-destructive entry (to allow upgrade)
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter(m =>
    !m.hooks?.some(h => h.command?.includes('block-destructive'))
  );

  s.hooks.PreToolUse.push({
    matcher: 'Bash',
    hooks: [{
      type: 'command',
      command: 'bash ~/.claude/hooks/block-destructive.sh',
      timeout: 5
    }]
  });

  fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2));
"
info "Registered hook in $SETTINGS"

echo ""
info "Installation complete."
echo ""
echo "What it blocks:"
echo "  • rm -rf, git reset --hard, git push --force, git clean -f, git branch -D"
echo "  • git stash drop/clear, git checkout ., --no-verify"
echo "  • DROP TABLE/DATABASE/SCHEMA, TRUNCATE, DELETE/UPDATE without WHERE"
echo "  • dropdb, mongo deleteMany({}), redis FLUSHDB/FLUSHALL"
echo "  • mkfs, dd if=, writes to /dev/sd|disk|nvme"
echo ""
echo "Escape hatch: append '# approved' at the end of the command."
echo "  Example:  rm -rf /tmp/foo # approved"
echo ""
warn "Restart Claude Code for the hook to activate."
