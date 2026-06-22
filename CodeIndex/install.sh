#!/usr/bin/env bash
# CodeIndex installer
#
# Installs the codeindex engine + SessionStart reindex hook + skill into ~/.claude/.
# Idempotent: re-running upgrades in place.

set -e

DEST="$HOME/.claude/codeindex"
SKILL_DEST="$HOME/.claude/skills/code-index"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; NC="\033[0m"
info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Match patterns for identifying our hook + CLAUDE.md section
HOOK_MATCH="codeindex"
SNIPPET_MATCH="Code symbol lookup (CodeIndex)"

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling CodeIndex..."

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
      if (s.permissions && Array.isArray(s.permissions.allow)) {
        s.permissions.allow = s.permissions.allow.filter(p => !(p || '').match(/$HOOK_MATCH/));
      }
      fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
    " 2>/dev/null && info "Hook + permission removed from settings.json" || warn "Could not clean settings.json"
  fi

  for f in "$HOME/.claude/CLAUDE.md" ".claude/CLAUDE.md" "CLAUDE.md"; do
    if [ -f "$f" ] && grep -q "$SNIPPET_MATCH" "$f" 2>/dev/null; then
      node -e "
        const fs = require('fs');
        let md = fs.readFileSync('$f', 'utf-8');
        md = md.replace(/\n*## Code symbol lookup \(CodeIndex\)[\s\S]*?(?=\n## |\n## \$|\$)/, '');
        md = md.trimEnd();
        if (md.length === 0) fs.unlinkSync('$f'); else fs.writeFileSync('$f', md + '\n');
      " 2>/dev/null && info "Removed snippet from $f" || warn "Could not clean $f"
    fi
  done

  rm -rf "$DEST" "$SKILL_DEST"
  info "Removed $DEST and $SKILL_DEST"
  info "CodeIndex uninstalled. (Per-project .claude/codeindex.db files are left in place.)"
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

command -v node &>/dev/null || error "node is required (>=22, for the built-in node:sqlite module)"

# node:sqlite landed in Node 22. Verify it's usable.
node -e "require('node:sqlite')" 2>/dev/null || error "Your node lacks node:sqlite — upgrade to Node >= 22."

# universal-ctags is the symbol extractor. macOS ships an incompatible BSD ctags.
if command -v ctags &>/dev/null && ctags --version 2>/dev/null | grep -qi "Universal Ctags"; then
  info "universal-ctags found: $(ctags --version | head -1)"
else
  warn "universal-ctags NOT found (the macOS /usr/bin/ctags is incompatible)."
  warn "Install it to enable indexing:"
  warn "    brew install universal-ctags        (macOS)"
  warn "    apt-get install universal-ctags     (Debian/Ubuntu)"
  warn "Continuing — the index will stay empty until universal-ctags is installed."
fi

info "Creating $DEST"
mkdir -p "$DEST"
cp "$SCRIPT_DIR/src/codeindex.mjs" "$DEST/"
cp "$SCRIPT_DIR/src/reindex-hook.mjs" "$DEST/"
chmod +x "$DEST/codeindex.mjs" "$DEST/reindex-hook.mjs"

info "Installing code-index skill..."
mkdir -p "$SKILL_DEST"
cp "$SCRIPT_DIR/skill/SKILL.md" "$SKILL_DEST/SKILL.md"

# Merge hook into ~/.claude/settings.json
info "Merging SessionStart hook into $SETTINGS..."
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
      // Remove any existing CodeIndex hook in this event/matcher
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

  // Permission allow entries (so queries don't prompt)
  s.permissions = s.permissions || {};
  s.permissions.allow = s.permissions.allow || [];
  const perms = ['Bash(node ~/.claude/codeindex/codeindex.mjs*)'];
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
    info "Created $target with CodeIndex snippet"
    return
  fi
  if grep -q "$SNIPPET_MATCH" "$target" 2>/dev/null; then
    node -e "
      const fs = require('fs');
      let md = fs.readFileSync('$target','utf-8');
      const snippet = fs.readFileSync('$SNIPPET','utf-8').trim();
      // Replace the existing section IN PLACE: match from its '## Code symbol lookup'
      // heading up to (but not including) the next level-2 heading, or end of file.
      // The 'm' flag makes ^ match line starts so the lookahead lands on real headings.
      const re = /^## Code symbol lookup \(CodeIndex\)[\s\S]*?(?=^## |\$(?![\s\S]))/m;
      if (re.test(md)) md = md.replace(re, snippet + '\n\n');
      else md = md.trimEnd() + '\n\n' + snippet + '\n';
      fs.writeFileSync('$target', md.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
    "
    info "Updated snippet in $target"
  else
    printf '\n%s\n' "$(cat "$SNIPPET")" >> "$target"
    info "Appended CodeIndex snippet to $target"
  fi
}

if [ -f "$HOME/.claude/CLAUDE.md" ]; then
  inject_snippet "$HOME/.claude/CLAUDE.md"
else
  warn "~/.claude/CLAUDE.md not found — create it and re-run, or run \`cat src/claude-md-snippet.md >> ~/.claude/CLAUDE.md\` manually."
fi

echo ""
info "CodeIndex installed."
echo ""
echo "Try it (from inside any project):"
echo "  node ~/.claude/codeindex/codeindex.mjs index    # build the index"
echo "  node ~/.claude/codeindex/codeindex.mjs stats"
echo "  node ~/.claude/codeindex/codeindex.mjs where <SomeSymbol>"
echo ""
echo "The SessionStart hook will keep the index fresh in this and future sessions."
