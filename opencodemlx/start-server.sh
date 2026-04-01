#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODEL="${MODEL:-mlx-community/Qwen3.5-4B-MLX-8bit}"
PORT="${PORT:-8899}"
BITS="${BITS:-4}"

EXTRA_ARGS=""
[ -n "$PRELOAD" ] && EXTRA_ARGS="$EXTRA_ARGS --preload $PRELOAD"
[ -n "$PRELOAD_DIR" ] && EXTRA_ARGS="$EXTRA_ARGS --preload-dir $PRELOAD_DIR"
[ -n "$CACHE_FILE" ] && EXTRA_ARGS="$EXTRA_ARGS --cache-file $CACHE_FILE"

echo "=== OpenCode MLX + TurboQuant ==="
echo "Model: $MODEL"
echo "Port:  $PORT"
echo "Bits:  $BITS"
echo ""

PYTHONUNBUFFERED=1 "$SCRIPT_DIR/.venv/bin/python3" "$SCRIPT_DIR/server.py" \
  --model "$MODEL" \
  --port "$PORT" \
  --bits "$BITS" \
  $EXTRA_ARGS
