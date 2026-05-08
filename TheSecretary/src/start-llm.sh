#!/bin/bash
# Start/stop/check LLM server for context summarization
# Supports MLX (Apple Silicon) or llama.cpp as fallback
# Usage: bash start-llm.sh [start|stop|status]

PORT=8922
LOG="/tmp/the-secretary-llm.log"
PID_FILE="/tmp/the-secretary-llm.pid"

# Auto-select MLX model by unified memory size (Apple Silicon).
# Override with env var SECRETARY_MLX_MODEL=<repo> to force a specific model.
#   ≥32 GB → Qwen2.5-7B-Instruct-4bit (~4.5 GB RAM, ~50 tok/s, lowest hallucination)
#   16–31 GB → Qwen2.5-3B-Instruct-4bit (~2 GB RAM, ~80 tok/s, balanced)
#   <16 GB / Linux / Intel → Qwen2.5-1.5B-Instruct-4bit (~1 GB RAM, fastest)
pick_mlx_model() {
  local ram_gb=0
  if command -v sysctl &>/dev/null; then
    local bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    ram_gb=$(( bytes / 1024 / 1024 / 1024 ))
  fi
  if   [ "$ram_gb" -ge 32 ]; then echo "mlx-community/Qwen2.5-7B-Instruct-4bit"
  elif [ "$ram_gb" -ge 16 ]; then echo "mlx-community/Qwen2.5-3B-Instruct-4bit"
  else                            echo "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
  fi
}
MLX_MODEL="${SECRETARY_MLX_MODEL:-$(pick_mlx_model)}"
GGUF_MODEL="$HOME/.claude/the-secretary/models/qwen2.5-3b-instruct-q4_k_m.gguf"

# Detect backend: prefer MLX on Apple Silicon, fallback to llama.cpp
detect_backend() {
  if python3 -c "import mlx_lm" 2>/dev/null; then
    echo "mlx"
  elif command -v llama-server &>/dev/null; then
    echo "llama"
  else
    echo "none"
  fi
}

case "${1:-start}" in
  start)
    # Check if already running
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "LLM server already running on port $PORT (PID $(cat "$PID_FILE"))"
      exit 0
    fi

    # Kill anything on the port
    lsof -ti:$PORT | xargs kill -9 2>/dev/null

    BACKEND=$(detect_backend)

    if [ "$BACKEND" = "mlx" ]; then
      echo "Starting MLX server with $MLX_MODEL..."
      nohup python3 -m mlx_lm server \
        --model "$MLX_MODEL" \
        --port $PORT \
        > "$LOG" 2>&1 &

    elif [ "$BACKEND" = "llama" ]; then
      echo "Starting llama-server with $GGUF_MODEL..."
      nohup llama-server \
        --model "$GGUF_MODEL" \
        --port $PORT \
        --ctx-size 4096 \
        --n-gpu-layers 99 \
        --log-disable \
        > "$LOG" 2>&1 &

    else
      echo "ERROR: No LLM backend found. Install mlx-lm (pip install mlx-lm) or llama.cpp."
      exit 1
    fi

    echo $! > "$PID_FILE"

    # Wait for ready. First-run downloads the MLX model (1–5 GB) so allow up
    # to 10 minutes; subsequent starts are near-instant.
    for i in $(seq 1 600); do
      sleep 1
      if curl -s http://localhost:$PORT/v1/models > /dev/null 2>&1; then
        echo "LLM server running on port $PORT (PID $(cat "$PID_FILE"), backend: $BACKEND, model: $MLX_MODEL)"
        exit 0
      fi
      # Bail out early if the launched process died.
      if [ -f "$PID_FILE" ] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "ERROR: LLM server process exited. Check $LOG"
        exit 1
      fi
    done

    echo "ERROR: LLM server did not become ready within 600s. Check $LOG"
    exit 1
    ;;

  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null
      rm -f "$PID_FILE"
      echo "LLM server stopped"
    else
      echo "No PID file found"
    fi
    lsof -ti:$PORT | xargs kill -9 2>/dev/null
    ;;

  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (PID $(cat "$PID_FILE"), port $PORT)"
    else
      echo "not running"
    fi
    ;;
esac
