#!/bin/bash
PORT="${PORT:-8899}"
echo "=== OpenCode MLX + TurboQuant Status ==="
curl -s "http://localhost:$PORT/v1/cache/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "Server not running on port $PORT"
