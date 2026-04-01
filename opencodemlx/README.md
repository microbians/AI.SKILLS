# OpenCode MLX + TurboQuant

Local AI coding assistant powered by Apple Silicon. Runs Qwen3.5-4B with TurboQuant KV cache compression for fast, private inference.

```
┌─────────────────────────────────────────────────┐
│  OpenCode (TUI)                                 │
│  ├── /v1/chat/completions (OpenAI-compatible)   │
│  └── Tool calling (bash, edit, read, write...)  │
├─────────────────────────────────────────────────┤
│  MLX + TurboQuant Server (localhost:8899)       │
│  ├── Qwen3.5-4B-MLX-8bit                       │
│  ├── TurboQuant KV cache (3-6x compression)    │
│  ├── Tool calling (Qwen XML -> OpenAI format)   │
│  └── Optional document/codebase pre-loading     │
├─────────────────────────────────────────────────┤
│  Apple Silicon GPU (Metal)                      │
└─────────────────────────────────────────────────┘
```

## Performance

| Metric | Value |
|--------|-------|
| Prefill | ~78 tok/s |
| Decode | ~42 tok/s |
| TTFT | ~500ms |
| Max context | 262,144 tokens (256K) |
| Model size | ~5 GB |
| KV cache (TurboQuant 4-bit) | 3-6x smaller than FP16 |

Tested on Apple M4 Pro / 64GB RAM.

## Requirements

- macOS with Apple Silicon (M1/M2/M3/M4+)
- Python 3.11+
- ~10 GB disk space (model + dependencies)
- 16 GB+ RAM recommended (64 GB+ for full 256K context)

## Install

```bash
git clone <this-repo>
cd opencodemlx
./install.sh
```

The installer will:
1. Create a Python virtualenv
2. Install MLX, mlx-lm, and TurboQuant
3. Download the Qwen3.5-4B-MLX-8bit model (~5 GB)
4. Optionally configure OpenCode

## Usage

### Start the server

```bash
./start-server.sh
```

### Use with OpenCode

```bash
opencode
```

OpenCode connects to `localhost:8899` automatically (configured during install).

### Pre-load a codebase for instant queries

```bash
# Pre-load at startup
PRELOAD_DIR=/path/to/your/project ./start-server.sh

# Or load via API after startup
curl -X POST http://localhost:8899/v1/cache/load-dir \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/your/project"}'
```

### Pre-load a document

```bash
PRELOAD=/path/to/document.pdf ./start-server.sh

# Or via API
curl -X POST http://localhost:8899/v1/cache/load \
  -H "Content-Type: application/json" \
  -d '{"file": "/path/to/document.txt"}'
```

### Check status

```bash
./status.sh
```

### Stop

```bash
./stop-server.sh
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `mlx-community/Qwen3.5-4B-MLX-8bit` | HuggingFace model ID |
| `PORT` | `8899` | Server port |
| `BITS` | `4` | TurboQuant KV cache bits (1-4) |
| `PRELOAD` | - | File to pre-load into cache |
| `PRELOAD_DIR` | - | Directory to pre-load into cache |
| `CACHE_FILE` | - | Save/load KV cache to disk |

## API

OpenAI-compatible endpoints:

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Chat completions (streaming + tool calling) |
| `GET /v1/models` | List models |
| `POST /v1/cache/load` | Load document into KV cache |
| `POST /v1/cache/load-dir` | Load directory into KV cache |
| `GET /v1/cache/status` | Cache and server stats |
| `GET /health` | Health check |

## How TurboQuant works

TurboQuant (Google Research, ICLR 2026) compresses the KV cache during inference using randomized Hadamard rotation + Lloyd-Max scalar quantization. This means:

- **3-6x KV cache compression** with near-zero accuracy loss
- **Longer contexts** on the same hardware (256K tokens on 64GB Mac)
- **Faster subsequent queries** when documents are pre-loaded (cached prefill)

The model weights stay at 8-bit; only the KV cache is further compressed.

## Files

```
opencodemlx/
  install.sh          # One-command installer
  start-server.sh     # Start the server
  stop-server.sh      # Stop the server
  status.sh           # Check server status
  server.py           # FastAPI server with TurboQuant + tool calling
  turbomlx-src/       # TurboQuant library (cloned during install)
  .venv/              # Python virtualenv (created during install)
```
