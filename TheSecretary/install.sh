#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# The Secretary — Installer
# AI-powered context persistence for Claude Code
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

# Match patterns for identifying our hooks in settings.json
HOOK_MATCH="summarize\|start-llm"
# Match patterns for identifying our sections in CLAUDE.md (old + new names)
SNIPPET_MATCH="ClaudeSumarizer\|The Secretary"

# ─── UNINSTALL ───────────────────────────────────────────────────

if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling The Secretary..."

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
      // Remove permissions
      if (s.permissions?.allow) {
        s.permissions.allow = s.permissions.allow.filter(p => !p.includes('summarize') && !p.includes('start-llm'));
      }
      fs.writeFileSync('$SETTINGS', JSON.stringify(s, null, 2) + '\n');
    " 2>/dev/null && info "Hooks removed from settings.json" || warn "Could not clean settings.json — remove hooks manually"
  fi

  # Remove CLAUDE.md snippet (handles both old and new section names)
  for f in "$HOME/.claude/CLAUDE.md" ".claude/CLAUDE.md" "CLAUDE.md"; do
    if [ -f "$f" ] && grep -qE "ClaudeSumarizer|The Secretary" "$f" 2>/dev/null; then
      node -e "
        const fs = require('fs');
        let md = fs.readFileSync('$f', 'utf-8');
        // Remove old ClaudeSumarizer section
        md = md.replace(/\n*## ClaudeSumarizer[\s\S]*?(?=\n## [^C]|\n## $|$)/, '');
        // Remove new The Secretary section
        md = md.replace(/\n*## The Secretary[\s\S]*?(?=\n## [^T]|\n## $|$)/, '');
        md = md.trimEnd();
        if (md.length === 0) { fs.unlinkSync('$f'); } else { fs.writeFileSync('$f', md + '\n'); }
      " 2>/dev/null && info "Removed section from $f" || warn "Could not clean $f"
    fi
  done

  # Remove directory
  rm -rf "$DEST"
  info "Removed $DEST"
  info "The Secretary uninstalled successfully."
  exit 0
fi

# ─── INSTALL ─────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
echo "  The Secretary — Installer"
echo "════════════════════════════════════════════════"
echo ""

# Check prerequisites
command -v node &>/dev/null || error "Node.js is required but not found. Install it first."
command -v npm &>/dev/null || error "npm is required but not found. Install it first."

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VERSION" -ge 18 ] 2>/dev/null || error "Node.js 18+ is required (found: $(node -v))"

# Detect LLM backend
HAS_MLX=false
HAS_LLAMA=false
if python3 -c "import mlx_lm" 2>/dev/null; then
  HAS_MLX=true
  info "MLX backend detected (Apple Silicon optimized)"
fi
if command -v llama-server &>/dev/null; then
  HAS_LLAMA=true
  info "llama.cpp backend detected"
fi
if [ "$HAS_MLX" = false ] && [ "$HAS_LLAMA" = false ]; then
  warn "No LLM backend found."
  echo "  Option 1 (recommended for Apple Silicon): pip install mlx-lm"
  echo "  Option 2: brew install llama.cpp"
  echo "  The Secretary will be installed but won't work until a backend is available."
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

# 4. Download model
if [ "$HAS_MLX" = true ]; then
  info "MLX will download the model automatically on first use (mlx-community/Qwen2.5-3B-Instruct-4bit)"
  info "Skipping GGUF model download."
elif [ ! -f "$DEST/models/$MODEL_FILE" ]; then
  echo ""
  warn "Downloading GGUF model (~2GB). This may take a few minutes..."
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
  info "GGUF model already present."
fi

# 5. Merge hooks and permissions into settings.json
info "Configuring Claude Code hooks and permissions..."

if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  echo '{}' > "$SETTINGS"
fi

HOOKS_FILE="$SCRIPT_DIR/hooks.json"

node -e "
  const fs = require('fs');

  const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
  const newHooks = JSON.parse(fs.readFileSync('$HOOKS_FILE', 'utf-8'));

  if (!settings.hooks) settings.hooks = {};

  for (const [event, matchers] of Object.entries(newHooks)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Remove existing summarizer hooks (avoid duplicates on re-install)
    settings.hooks[event] = settings.hooks[event].filter(m =>
      !m.hooks?.some(h => h.command?.includes('summarize') || h.command?.includes('start-llm'))
    );

    settings.hooks[event].push(...matchers);
  }

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const perms = [
    'Bash(node ~/.claude/summarizer/summarize.mjs*)',
    'Bash(bash ~/.claude/summarizer/start-llm.sh*)'
  ];

  for (const perm of perms) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }

  fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2) + '\n');
" || error "Failed to merge hooks into settings.json"

info "Hooks and permissions configured."

# 6. Inject CLAUDE.md snippet
SNIPPET="$SCRIPT_DIR/src/claude-md-snippet.md"
GLOBAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"

inject_snippet() {
  local target="$1"
  local label="$2"

  if [ ! -f "$target" ]; then
    cat "$SNIPPET" > "$target"
    info "Created $label with The Secretary docs"
    return
  fi

  # Remove any existing section (old ClaudeSumarizer or new The Secretary)
  if grep -qE "ClaudeSumarizer|The Secretary" "$target" 2>/dev/null; then
    node -e "
      const fs = require('fs');
      let md = fs.readFileSync('$target', 'utf-8');
      const snippet = fs.readFileSync('$SNIPPET', 'utf-8');
      // Remove old section
      md = md.replace(/## ClaudeSumarizer[\\s\\S]*?(?=\\n## [^C]|\\n## \$|\$)/, '');
      // Remove new section (re-install case)
      md = md.replace(/## The Secretary[\\s\\S]*?(?=\\n## [^T]|\\n## \$|\$)/, '');
      md = md.trimEnd() + '\\n\\n' + snippet.trim() + '\\n';
      fs.writeFileSync('$target', md);
    "
    info "Updated The Secretary section in $label"
  else
    echo "" >> "$target"
    cat "$SNIPPET" >> "$target"
    echo "" >> "$target"
    info "Added The Secretary section to $label"
  fi
}

inject_snippet "$GLOBAL_CLAUDE_MD" "~/.claude/CLAUDE.md (global)"

LOCAL_CLAUDE_MD=""
if [ -f ".claude/CLAUDE.md" ]; then
  LOCAL_CLAUDE_MD=".claude/CLAUDE.md"
elif [ -f "CLAUDE.md" ]; then
  LOCAL_CLAUDE_MD="CLAUDE.md"
fi

if [ -n "$LOCAL_CLAUDE_MD" ]; then
  inject_snippet "$LOCAL_CLAUDE_MD" "$LOCAL_CLAUDE_MD (project)"
fi

# 7. Verify installation
echo ""
info "Verifying installation..."

[ -f "$DEST/summarize.mjs" ] || error "summarize.mjs not found"
[ -f "$DEST/start-llm.sh" ] || error "start-llm.sh not found"
[ -f "$DEST/config.json" ] || error "config.json not found"
[ -d "$DEST/node_modules/better-sqlite3" ] || error "better-sqlite3 not installed"

echo '{}' | node "$DEST/summarize.mjs" incremental 2>/dev/null
info "Secretary script works."

# Try to start LLM
if [ "$HAS_MLX" = true ] || { [ "$HAS_LLAMA" = true ] && [ -f "$DEST/models/$MODEL_FILE" ]; }; then
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
echo ""
echo "  Features:"
echo "    - Conversation summarization (automatic)"
echo "    - User memories: \"recuerda que...\" / \"olvida que...\""
echo "    - Notes: \"toma nota:\" / \"borra la nota de...\""
echo "    - Reminders: \"avísame el viernes...\" / \"ya hice...\""
echo ""
echo "  Restart Claude Code to activate the hooks."
echo "  To uninstall: bash $SCRIPT_DIR/install.sh --uninstall"
echo ""
