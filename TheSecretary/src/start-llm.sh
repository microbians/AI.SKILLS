#!/bin/bash
# Start/stop/check LLM server for context summarization
# Supports MLX (Apple Silicon) or llama.cpp as fallback
# Usage: bash start-llm.sh [start|stop|status]

PORT=8922
LOG="/tmp/llama-summarizer.log"
PID_FILE="/tmp/llama-summarizer.pid"

# Llama-3.2-3B-Instruct-4bit: best speed/quality/RAM tradeoff across
# Apple Silicon in our benchmarks. Override with SECRETARY_MLX_MODEL if needed.
MLX_MODEL="${SECRETARY_MLX_MODEL:-mlx-community/Llama-3.2-3B-Instruct-4bit}"
GGUF_MODEL="$HOME/.claude/summarizer/models/qwen2.5-3b-instruct-q4_k_m.gguf"

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

    # Wait for ready
    for i in {1..30}; do
      sleep 1
      if curl -s http://localhost:$PORT/v1/models > /dev/null 2>&1; then
        echo "LLM server running on port $PORT (PID $(cat "$PID_FILE"), backend: $BACKEND)"
        exit 0
      fi
    done

    echo "ERROR: LLM server failed to start. Check $LOG"
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
