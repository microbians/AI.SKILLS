#!/usr/bin/env bash
# safe-edit installer
#
# Installs the safe-edit script + PreToolUse hook + skill into ~/.claude/.
# Idempotent: re-running upgrades in place.

set -e

DEST="$HOME/.claude/safe-edit"
SKILL_DEST="$HOME/.claude/skills/safe-edit"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; NC="\033[0m"
info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Match patterns for identifying our hook + CLAUDE.md section
HOOK_MATCH="safe-edit"
SNIPPET_MATCH="Mass file edits (sed -i replacement)"

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling safe-edit..."

  if [ -f "$SETTINGS" ] && command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      let s; try { s = JSON.parse(fs.readFileSync('$SETTINGS','utf-8')); } catch { process.exit(0); }
      if (s.hooks) {
        for (const k of Object.keys(s.hooks)) {
          if (!Array.isArray(s.hooks[k])) continue;
          s.hooks[k] = s.hooks[k].map(g => {
            if (!g.hooks) return g;
            g.hooks = g.hooks.filter(h => !(h.command || '').match(/$HOOK_MATCH/));
            return g;
          }).filter(g => g.hooks && g.hooks.length > 0);
          if (s.hooks[k].length === 0) delete s.hooks[k];
        }
        if (Object.keys(s.hooks).length === 0) delete s.hooks;
      }
      fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
    " 2>/dev/null && info "Hook removed from settings.json" || warn "Could not clean settings.json"
  fi

  for f in "$HOME/.claude/CLAUDE.md" ".claude/CLAUDE.md" "CLAUDE.md"; do
    if [ -f "$f" ] && grep -q "$SNIPPET_MATCH" "$f" 2>/dev/null; then
      node -e "
        const fs = require('fs');
        let md = fs.readFileSync('$f', 'utf-8');
        md = md.replace(/\n*## Mass file edits \(sed -i replacement\)[\s\S]*?(?=\n## |\n## \$|\$)/, '');
        md = md.trimEnd();
        if (md.length === 0) fs.unlinkSync('$f'); else fs.writeFileSync('$f', md + '\n');
      " 2>/dev/null && info "Removed snippet from $f" || warn "Could not clean $f"
    fi
  done

  rm -rf "$DEST" "$SKILL_DEST"
  info "Removed $DEST and $SKILL_DEST"
  info "safe-edit uninstalled."
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

command -v node &>/dev/null || error "node is required (>=18)"
command -v npm &>/dev/null || error "npm is required"

info "Creating $DEST"
mkdir -p "$DEST"

cp "$SCRIPT_DIR/src/safe-edit.mjs" "$DEST/"
cp "$SCRIPT_DIR/src/block-inplace-edit.mjs" "$DEST/"
cp "$SCRIPT_DIR/src/package.json" "$DEST/"
chmod +x "$DEST/safe-edit.mjs" "$DEST/block-inplace-edit.mjs"

info "Installing dependencies..."
( cd "$DEST" && npm install --production --silent 2>/dev/null ) || warn "npm install failed — glob may be missing"

info "Installing safe-edit skill..."
mkdir -p "$SKILL_DEST"
cp "$SCRIPT_DIR/skill/SKILL.md" "$SKILL_DEST/SKILL.md"

# Merge hook into ~/.claude/settings.json
info "Merging PreToolUse hook into $SETTINGS..."
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$SETTINGS','utf-8'));
  const incoming = JSON.parse(fs.readFileSync('$SCRIPT_DIR/hooks.json','utf-8'));
  s.hooks = s.hooks || {};

  for (const [event, groups] of Object.entries(incoming.hooks)) {
    s.hooks[event] = s.hooks[event] || [];
    for (const g of groups) {
      // Remove any existing safe-edit hook in this event/matcher
      s.hooks[event] = s.hooks[event].map(existing => {
        if (existing.matcher !== g.matcher) return existing;
        existing.hooks = (existing.hooks || []).filter(h => !(h.command || '').match(/$HOOK_MATCH/));
        return existing;
      }).filter(g2 => g2.hooks && g2.hooks.length > 0);

      // Find or create matcher group
      let target = s.hooks[event].find(x => x.matcher === g.matcher);
      if (!target) { target = { matcher: g.matcher, hooks: [] }; s.hooks[event].push(target); }
      target.hooks.push(...g.hooks);
    }
  }

  // Permission allow entries
  s.permissions = s.permissions || {};
  s.permissions.allow = s.permissions.allow || [];
  const perms = [
    'Bash(node ~/.claude/safe-edit/safe-edit.mjs*)'
  ];
  for (const p of perms) if (!s.permissions.allow.includes(p)) s.permissions.allow.push(p);

  fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
"
info "Hook merged."

# Inject CLAUDE.md snippet
SNIPPET="$SCRIPT_DIR/src/claude-md-snippet.md"
inject_snippet() {
  local target="$1"
  if [ ! -f "$target" ]; then
    cp "$SNIPPET" "$target"
    info "Created $target with safe-edit snippet"
    return
  fi
  if grep -q "$SNIPPET_MATCH" "$target" 2>/dev/null; then
    node -e "
      const fs = require('fs');
      let md = fs.readFileSync('$target','utf-8');
      const snippet = fs.readFileSync('$SNIPPET','utf-8');
      md = md.replace(/## Mass file edits \(sed -i replacement\)[\s\S]*?(?=\n## |\n## \$|\$)/, '');
      md = md.trimEnd() + '\n\n' + snippet.trim() + '\n';
      fs.writeFileSync('$target', md);
    "
    info "Updated snippet in $target"
  else
    printf '\n%s\n' "$(cat "$SNIPPET")" >> "$target"
    info "Appended safe-edit snippet to $target"
  fi
}

if [ -f "$HOME/.claude/CLAUDE.md" ]; then
  inject_snippet "$HOME/.claude/CLAUDE.md"
else
  warn "~/.claude/CLAUDE.md not found — create it and re-run, or run \`cat src/claude-md-snippet.md >> ~/.claude/CLAUDE.md\` manually."
fi

echo ""
info "safe-edit installed."
echo ""
echo "Try it:"
echo "  node ~/.claude/safe-edit/safe-edit.mjs --help"
echo ""
echo "The PreToolUse hook now blocks sed -i / perl -i / awk -i inplace in this and future sessions."
