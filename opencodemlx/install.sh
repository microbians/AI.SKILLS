#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "=== OpenCode MLX + TurboQuant Installer ==="
echo ""

# Check requirements
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: This only works on macOS with Apple Silicon."
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Error: Apple Silicon (M1/M2/M3/M4+) required."
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 not found. Install with: brew install python@3.12"
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [[ "$PY_MAJOR" -lt 3 ]] || [[ "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 11 ]]; then
  echo "Error: Python 3.11+ required (found $PY_VER). Install with: brew install python@3.12"
  exit 1
fi

RAM_GB=$(sysctl -n hw.memsize | awk '{printf "%.0f", $1/1073741824}')
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
echo "System: $CHIP / ${RAM_GB}GB RAM / Python $PY_VER"
echo ""

if [[ "$RAM_GB" -lt 16 ]]; then
  echo "Warning: ${RAM_GB}GB RAM detected. 16GB+ recommended for good performance."
  echo ""
fi

# 1. Create virtualenv
if [ ! -d "$VENV_DIR" ]; then
  echo "[1/5] Creating Python virtualenv..."
  python3 -m venv "$VENV_DIR"
else
  echo "[1/5] Virtualenv already exists, skipping..."
fi

PIP="$VENV_DIR/bin/pip"
PYTHON="$VENV_DIR/bin/python3"

# 2. Install MLX + mlx-lm
echo "[2/5] Installing mlx and mlx-lm..."
"$PIP" install --upgrade pip -q
"$PIP" install "mlx>=0.31.1,<0.32" "mlx-lm>=0.31.1,<0.32" -q

# 3. Install turbomlx
echo "[3/5] Installing turbomlx (TurboQuant for MLX)..."
TURBO_DIR="$SCRIPT_DIR/turbomlx-src"
if [ ! -d "$TURBO_DIR" ]; then
  git clone --depth 1 https://github.com/alicankiraz1/Qwen3.5-TurboQuant-MLX-LM.git "$TURBO_DIR"
fi
"$PIP" install "$TURBO_DIR[mlx]" -q

# 4. Install server dependencies
echo "[4/5] Installing server dependencies..."
"$PIP" install fastapi uvicorn -q

# 5. Download model
echo "[5/5] Downloading model (first time only, ~5GB)..."
"$PYTHON" -c "from mlx_lm import load; load('mlx-community/Qwen3.5-4B-MLX-8bit')"

# Verify
echo ""
"$PYTHON" -c "import turbomlx; import mlx; from mlx_lm import load; print('[OK] All imports verified')"

# Configure OpenCode if installed
if command -v opencode &>/dev/null; then
  OPENCODE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
  echo ""
  read -p "Configure OpenCode to use this server? [Y/n] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    mkdir -p "$(dirname "$OPENCODE_CONFIG")"
    cat > "$OPENCODE_CONFIG" << 'OCEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "mlx-turbo": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qwen3.5-4B TurboQuant (MLX Local)",
      "options": {
        "baseURL": "http://127.0.0.1:8899/v1"
      },
      "models": {
        "Qwen3.5-4B-MLX-8bit": {
          "name": "Qwen3.5-4B-MLX-8bit",
          "limit": {
            "context": 262144,
            "output": 8192
          }
        }
      }
    }
  },
  "model": "mlx-turbo/Qwen3.5-4B-MLX-8bit"
}
OCEOF
    echo "[OK] OpenCode configured -> localhost:8899"
  fi
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Usage:"
echo "  ./start-server.sh                              # Start server"
echo "  ./stop-server.sh                               # Stop server"
echo "  ./status.sh                                    # Check status"
echo "  PRELOAD_DIR=/path/to/code ./start-server.sh    # Pre-load codebase"
echo ""
echo "Then run 'opencode' and start coding!"
