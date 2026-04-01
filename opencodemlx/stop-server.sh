#!/bin/bash
PORT="${PORT:-8899}"
PIDS=$(lsof -ti :"$PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null
  echo "Server stopped on port $PORT"
else
  echo "No server running on port $PORT"
fi
