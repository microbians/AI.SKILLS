#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# ClaudeSumarizer Installer
# Installs the local LLM summarizer for Claude Code
# Usage: bash install.sh [--uninstall]
# ═══════════════════════════════════════════════════════════════════

set -e

DEST="$HOME/.claude/summarizer"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
MODEL_FILE="qwen2.5-3b-instruct-q4_k_m.gguf"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling ClaudeSumarizer..."

  # Stop LLM server
  if [ -f "$DEST/start-llm.sh" ]; then
    bash "$DEST/start-llm.sh" stop 2>/dev/null || true
  fi

  # Remove hooks from settings.json
  if [ -f "$SETTINGS" ] && command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
      if (s.hooks) {
        for (const [event, matchers] of Object.entries(s.hooks)) {
          s.hooks[event] = matchers.filter(m =>
            !m.hooks?.some(h => h.command?.includes('summarize') || h.command?.includes('start-llm'))
          );
          if (s.hooks[event].length === 0) delete s.hooks[event];
        }
        if (Object.keys(s.hooks).length === 0) delete s.hooks;
      }
      // Remove summarizer permissions
      if (s.permissions?.allow) {
        s.permissions.allow = s.permissions.allow.filter(p => !p.includes('summarize') && !p.includes('start-llm'));
      }
      fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
    " 2>/dev/null && info "Hooks removed from settings.json" || warn "Could not clean settings.json — remove hooks manually"
  fi

  # Remove CLAUDE.md snippet if present
  for f in ".claude/CLAUDE.md" "CLAUDE.md"; do
    if [ -f "$f" ] && grep -q "ClaudeSumarizer" "$f" 2>/dev/null; then
      node -e "
        const fs = require('fs');
        let md = fs.readFileSync('$f', 'utf-8');
        md = md.replace(/\n*## ClaudeSumarizer[\s\S]*?(?=\n## [^C]|\n## $|$)/, '');
        fs.writeFileSync('$f', md.trimEnd() + '\n');
      " 2>/dev/null && info "Removed ClaudeSumarizer section from $f" || warn "Could not clean $f"
    fi
  done

  # Remove directory
  rm -rf "$DEST"
  info "Removed $DEST"
  info "ClaudeSumarizer uninstalled successfully."
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
echo "  ClaudeSumarizer — Installer"
echo "════════════════════════════════════════════════"
echo ""

# Check prerequisites
command -v node &>/dev/null || error "Node.js is required but not found. Install it first."
command -v npm &>/dev/null || error "npm is required but not found. Install it first."

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VERSION" -ge 18 ] 2>/dev/null || error "Node.js 18+ is required (found: $(node -v))"

if ! command -v llama-server &>/dev/null; then
  warn "llama-server not found in PATH."
  echo "  Install it with: brew install llama.cpp (macOS) or build from source."
  echo "  The summarizer will be installed but won't work until llama-server is available."
  echo ""
fi

# 1. Create directory structure
info "Creating $DEST"
mkdir -p "$DEST/models"

# 2. Copy source files
info "Copying source files..."
cp "$SCRIPT_DIR/src/summarize.mjs" "$DEST/"
cp "$SCRIPT_DIR/src/start-llm.sh" "$DEST/"
cp "$SCRIPT_DIR/src/config.json" "$DEST/"
cp "$SCRIPT_DIR/src/package.json" "$DEST/"
chmod +x "$DEST/start-llm.sh"

# 3. Install npm dependencies
info "Installing dependencies..."
cd "$DEST" && npm install --production --silent 2>/dev/null
cd "$SCRIPT_DIR"
info "Dependencies installed."

# 4. Download model (if not already present)
if [ ! -f "$DEST/models/$MODEL_FILE" ]; then
  echo ""
  warn "Downloading model (~2GB). This may take a few minutes..."
  echo "  URL: $MODEL_URL"
  echo ""

  if command -v curl &>/dev/null; then
    curl -L --progress-bar -o "$DEST/models/$MODEL_FILE" "$MODEL_URL"
  elif command -v wget &>/dev/null; then
    wget --show-progress -O "$DEST/models/$MODEL_FILE" "$MODEL_URL"
  else
    error "Neither curl nor wget found. Download the model manually to: $DEST/models/$MODEL_FILE"
  fi

  if [ -f "$DEST/models/$MODEL_FILE" ]; then
    SIZE=$(du -h "$DEST/models/$MODEL_FILE" | cut -f1)
    info "Model downloaded ($SIZE)"
  else
    error "Model download failed. Download manually from: $MODEL_URL"
  fi
else
  info "Model already present."
fi

# 5. Merge hooks and permissions into settings.json
info "Configuring Claude Code hooks and permissions..."

# Ensure settings.json exists
if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  echo '{}' > "$SETTINGS"
fi

HOOKS_FILE="$SCRIPT_DIR/hooks.json"

node -e "
  const fs = require('fs');

  const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
  const newHooks = JSON.parse(fs.readFileSync('$HOOKS_FILE', 'utf-8'));

  // Initialize hooks object if missing
  if (!settings.hooks) settings.hooks = {};

  // For each hook event, remove any existing summarizer entries then add new ones
  for (const [event, matchers] of Object.entries(newHooks)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Remove existing summarizer hooks (to avoid duplicates on re-install)
    settings.hooks[event] = settings.hooks[event].filter(m =>
      !m.hooks?.some(h => h.command?.includes('summarize') || h.command?.includes('start-llm'))
    );

    // Add new hooks
    settings.hooks[event].push(...matchers);
  }

  // Add auto-allow permissions so the user isn't prompted for every hook execution
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const summarizerPermissions = [
    'Bash(node ~/.claude/summarizer/summarize.mjs*)',
    'Bash(bash ~/.claude/summarizer/start-llm.sh*)'
  ];

  for (const perm of summarizerPermissions) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }

  fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2) + '\n');
" || error "Failed to merge hooks into settings.json"

info "Hooks and permissions configured."

# 6. Inject CLAUDE.md snippet into current project (if applicable)
SNIPPET="$SCRIPT_DIR/src/claude-md-snippet.md"
CLAUDE_MD=""

# Look for CLAUDE.md: first .claude/CLAUDE.md, then root CLAUDE.md
if [ -f ".claude/CLAUDE.md" ]; then
  CLAUDE_MD=".claude/CLAUDE.md"
elif [ -f "CLAUDE.md" ]; then
  CLAUDE_MD="CLAUDE.md"
fi

if [ -n "$CLAUDE_MD" ] && [ -f "$SNIPPET" ]; then
  # Check if already injected
  if grep -q "ClaudeSumarizer" "$CLAUDE_MD" 2>/dev/null; then
    # Replace existing section
    node -e "
      const fs = require('fs');
      let md = fs.readFileSync('$CLAUDE_MD', 'utf-8');
      const snippet = fs.readFileSync('$SNIPPET', 'utf-8');
      // Remove old section (from ## ClaudeSumarizer to next ## or EOF)
      md = md.replace(/## ClaudeSumarizer[\\s\\S]*?(?=\\n## [^C]|\\n## \$|\$)/, '');
      // Append new
      md = md.trimEnd() + '\\n\\n' + snippet.trim() + '\\n';
      fs.writeFileSync('$CLAUDE_MD', md);
    "
    info "Updated ClaudeSumarizer section in $CLAUDE_MD"
  else
    # Append snippet
    echo "" >> "$CLAUDE_MD"
    cat "$SNIPPET" >> "$CLAUDE_MD"
    echo "" >> "$CLAUDE_MD"
    info "Added ClaudeSumarizer section to $CLAUDE_MD"
  fi
else
  warn "No CLAUDE.md found in current directory. You can manually add the snippet from:"
  warn "  $SNIPPET"
fi

# 8. Verify installation
echo ""
info "Verifying installation..."

# Check files exist
[ -f "$DEST/summarize.mjs" ] || error "summarize.mjs not found"
[ -f "$DEST/start-llm.sh" ] || error "start-llm.sh not found"
[ -f "$DEST/config.json" ] || error "config.json not found"
[ -d "$DEST/node_modules/better-sqlite3" ] || error "better-sqlite3 not installed"

# Quick test: run summarizer with empty input (should exit cleanly)
echo '{}' | node "$DEST/summarize.mjs" incremental 2>/dev/null
info "Summarizer script works."

# Try to start LLM if llama-server is available
if command -v llama-server &>/dev/null && [ -f "$DEST/models/$MODEL_FILE" ]; then
  echo ""
  info "Starting LLM server..."
  bash "$DEST/start-llm.sh" start
  if curl -s http://localhost:8922/v1/models > /dev/null 2>&1; then
    info "LLM server is running and responding."
  else
    warn "LLM server started but not responding yet. It may need more time to load."
  fi
fi

# Done
echo ""
echo "════════════════════════════════════════════════"
echo "  Installation complete!"
echo "════════════════════════════════════════════════"
echo ""
echo "  Files:    $DEST/"
echo "  Config:   $DEST/config.json"
echo "  Database: $DEST/summaries.db (created on first use)"
echo "  Logs:     /tmp/llama-summarizer.log"
echo ""
echo "  Restart Claude Code to activate the hooks."
echo "  To uninstall: bash $SCRIPT_DIR/install.sh --uninstall"
echo ""
