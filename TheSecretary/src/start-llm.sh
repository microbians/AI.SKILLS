#!/bin/bash
# Start/stop/check LLM server for context summarization
# Supports MLX (Apple Silicon) or llama.cpp as fallback
# Usage: bash start-llm.sh [start|stop|stop-if-idle|touch|status]
#
# stop-if-idle is what the Stop hook should call: it keeps the server alive
# between turns (TokenGuard needs it on every prompt, and a cold start costs
# 15-30s) but still reclaims the model's ~8 GB once the machine has genuinely
# stopped using it. Callers mark usage with `touch`.

PORT=8922
LOG="/tmp/the-secretary-llm.log"
PID_FILE="/tmp/the-secretary-llm.pid"
ACTIVITY_FILE="/tmp/the-secretary-llm.activity"
IDLE_TIMEOUT_MIN="${SECRETARY_LLM_IDLE_MIN:-45}"

# Auto-select MLX model by unified memory size (Apple Silicon).
# Override with env var SECRETARY_MLX_MODEL=<repo> to force a specific model.
# Benchmarked on The Secretary's own workloads (intent classification, summaries,
# handoffs — no code): 7B ran the set in 5.0s vs 12.0s for Coder-14B at half the
# RAM, with identical accuracy on the handoff rules. A coder-tuned model buys
# nothing here, so size is chosen for summarization quality alone.
#   ≥32 GB → Qwen2.5-7B-Instruct-4bit (~4 GB RAM, best accuracy/speed balance)
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

    # Mutual exclusion around the whole start sequence. Several callers race to
    # run this (TokenGuard's restart, The Secretary's ensureLLMRunning, manual
    # runs). Without a lock, two of them reach the spawn below at the same time:
    # the loser dies on "Address already in use" but still writes its PID to the
    # PID file, so the next caller sees a dead PID, assumes the server crashed,
    # and kills the healthy one to start over — the self-inflicted crash loop.
    # mkdir is atomic on POSIX, so exactly one caller wins.
    LOCK_DIR="/tmp/the-secretary-llm.lock"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      # Someone else is starting it: wait briefly for the port to come up.
      for _ in $(seq 1 60); do
        sleep 1
        if curl -s --max-time 2 "http://localhost:$PORT/v1/models" > /dev/null 2>&1; then
          echo "LLM server started by a concurrent caller on port $PORT"
          exit 0
        fi
      done
      # Stale lock (previous run died holding it): take it over.
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || true
    fi
    trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

    # A healthy server with no/stale PID file is still a healthy server:
    # killing it because the PID file drifted is what made the port look like
    # it "crashed on its own". Adopt it instead: record its PID and leave it be.
    if curl -s --max-time 3 "http://localhost:$PORT/v1/models" > /dev/null 2>&1; then
      RUNNING_PID=$(lsof -ti:$PORT | head -1)
      [ -n "$RUNNING_PID" ] && echo "$RUNNING_PID" > "$PID_FILE"
      echo "LLM server already serving on port $PORT (adopted PID ${RUNNING_PID:-unknown})"
      exit 0
    fi

    # Nothing serving: clear whatever is squatting the port and start fresh.
    lsof -ti:$PORT | xargs kill -9 2>/dev/null

    # Run from our own dir so port monitors attribute the server to
    # "the-secretary" instead of whatever project invoked the hook.
    cd "$(dirname "$0")"

    BACKEND=$(detect_backend)

    if [ "$BACKEND" = "mlx" ]; then
      echo "Starting MLX server with $MLX_MODEL..."
      # mlx_lm calls mx.distributed.init(), which picks the MPI backend whenever
      # libmpi is installed (Homebrew open-mpi) and then binds a second, unused
      # listener on *:1025 — every interface, not just loopback, for a group of
      # size 1. Pointing MLX_MPI_LIBNAME at a non-existent library makes MLX fall
      # back to the ring backend, which opens no socket. The server then listens
      # only on 127.0.0.1:$PORT.
      # os.setsid() puts the server in its own session and process group, so a
      # group-wide cleanup of the shell that launched it (hook harness tearing
      # down a tool call, a stray `kill -- -PGID`) can't take it down with it.
      # macOS has no setsid(1), hence the Python one-liner.
      # Cap the prompt cache: it grows per distinct conversation and is never
      # reclaimed on its own (observed climbing past 2 GB on top of the model's
      # own ~8 GB during a single session). Bounding it keeps a long-lived
      # server from drifting into memory pressure.
      MLX_MPI_LIBNAME=mlx-mpi-disabled.dylib \
      nohup python3 -c "import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])" \
        python3 -m mlx_lm server \
        --model "$MLX_MODEL" \
        --port $PORT \
        --prompt-cache-size 4 \
        --prompt-cache-bytes 1073741824 \
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
        date +%s > "$ACTIVITY_FILE"
        echo "LLM server running on port $PORT (PID $(cat "$PID_FILE"), backend: $BACKEND, model: $MLX_MODEL)"
        exit 0
      fi
      # Bail out early if the launched process died.
      if [ -f "$PID_FILE" ] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        # Losing an "Address already in use" race means someone else's server
        # is serving the port — adopt it rather than reporting a failure.
        if curl -s --max-time 2 "http://localhost:$PORT/v1/models" > /dev/null 2>&1; then
          RUNNING_PID=$(lsof -ti:$PORT | head -1)
          [ -n "$RUNNING_PID" ] && echo "$RUNNING_PID" > "$PID_FILE"
          echo "LLM server already serving on port $PORT (adopted PID ${RUNNING_PID:-unknown})"
          exit 0
        fi
        # Never leave a dead PID behind: the next caller would read it, assume
        # a crash, and kill whatever healthy server exists to "recover".
        rm -f "$PID_FILE"
        echo "ERROR: LLM server process exited. Check $LOG"
        exit 1
      fi
    done

    rm -f "$PID_FILE"
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
    rm -f "$ACTIVITY_FILE"
    ;;

  touch)
    # Mark the server as in use, so stop-if-idle keeps it alive.
    date +%s > "$ACTIVITY_FILE"
    ;;

  stop-if-idle)
    # Shut down only after IDLE_TIMEOUT_MIN minutes with no recorded use.
    # Anything else (no activity file yet, recent use) leaves it running.
    if [ ! -f "$ACTIVITY_FILE" ]; then
      date +%s > "$ACTIVITY_FILE"
      echo "LLM server left running (no activity recorded yet)"
      exit 0
    fi
    LAST=$(cat "$ACTIVITY_FILE" 2>/dev/null || echo 0)
    IDLE_S=$(( $(date +%s) - LAST ))
    if [ "$IDLE_S" -lt $(( IDLE_TIMEOUT_MIN * 60 )) ]; then
      echo "LLM server left running (idle ${IDLE_S}s < ${IDLE_TIMEOUT_MIN}m)"
      exit 0
    fi
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null
      rm -f "$PID_FILE"
    fi
    lsof -ti:$PORT | xargs kill -9 2>/dev/null
    rm -f "$ACTIVITY_FILE"
    echo "LLM server stopped after ${IDLE_S}s idle"
    ;;

  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (PID $(cat "$PID_FILE"), port $PORT)"
    else
      echo "not running"
    fi
    ;;
esac
