#!/bin/bash
# Start/stop/check llama-server for context summarization
# Usage: bash start-llm.sh [start|stop|status]

PORT=8922
MODEL="$HOME/.claude/summarizer/models/qwen2.5-3b-instruct-q4_k_m.gguf"
LOG="/tmp/llama-summarizer.log"
PID_FILE="/tmp/llama-summarizer.pid"

case "${1:-start}" in
  start)
    # Check if already running
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "llama-server already running on port $PORT (PID $(cat "$PID_FILE"))"
      exit 0
    fi

    # Kill anything on the port
    lsof -ti:$PORT | xargs kill -9 2>/dev/null

    # Start
    nohup llama-server \
      --model "$MODEL" \
      --port $PORT \
      --ctx-size 4096 \
      --n-gpu-layers 99 \
      --log-disable \
      > "$LOG" 2>&1 &

    echo $! > "$PID_FILE"

    # Wait for ready
    for i in {1..10}; do
      sleep 1
      if curl -s http://localhost:$PORT/v1/models > /dev/null 2>&1; then
        echo "llama-server running on port $PORT (PID $(cat "$PID_FILE"))"
        exit 0
      fi
    done

    echo "ERROR: llama-server failed to start. Check $LOG"
    exit 1
    ;;

  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null
      rm -f "$PID_FILE"
      echo "llama-server stopped"
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
