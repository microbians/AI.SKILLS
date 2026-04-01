"""
OpenCode MLX + TurboQuant Server
OpenAI-compatible API with TurboQuant KV cache compression.
Supports tool calling (Qwen3.5 XML format -> OpenAI format).
"""

import argparse
import copy
import json
import re
import time
import uuid
import sys
import os
from pathlib import Path
from typing import Optional

import mlx.core as mx
from mlx_lm import load
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

# TurboQuant imports
from turbomlx import (
    TurboQuantConfig,
    ScorerMode,
    generate_with_backend,
    convert_prompt_cache,
    save_prompt_cache,
    load_prompt_cache,
)
from turbomlx.mlx_runtime.patching import patch_attention_dispatch

try:
    from mlx_lm.models.cache import make_prompt_cache
except ImportError:
    from mlx_lm.utils import make_prompt_cache


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
app = FastAPI(title="OpenCode MLX + TurboQuant")

model = None
tokenizer = None
turbo_config = None
prompt_cache = None
cache_prefix_tokens = []
cache_prefix_text = ""
model_name = ""
server_start_time = 0
stats = {
    "queries": 0,
    "total_output_tokens": 0,
    "cache_build_time": 0,
    "doc_tokens": 0,
}


# ---------------------------------------------------------------------------
# Tool calling: Qwen3.5 XML <-> OpenAI format conversion
# ---------------------------------------------------------------------------
TOOL_SYSTEM_TEMPLATE = """# Tools

You have access to the following functions:

<tools>
{tool_definitions}
</tools>

If you choose to call a function ONLY reply in the following format with NO suffix:

<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
</function>
</tool_call>

Reminder:
- Function calls MUST follow the specified format
- Required parameters MUST be specified
- You can call one or more functions at a time
- If no function call is needed, just reply normally"""


def format_tools_for_prompt(tools: list) -> str:
    """Convert OpenAI tool definitions to Qwen3.5 format for the system prompt."""
    if not tools:
        return ""
    defs = []
    for t in tools:
        if t.get("type") == "function":
            fn = t["function"]
            defs.append(json.dumps({
                "type": "function",
                "function": {
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {}),
                }
            }))
    if not defs:
        return ""
    return TOOL_SYSTEM_TEMPLATE.format(tool_definitions="\n".join(defs))


def parse_tool_calls(text: str) -> tuple[str, list]:
    """Parse Qwen3.5 XML tool_call blocks from model output.
    Returns (content_text, tool_calls_list).
    """
    tool_call_pattern = re.compile(
        r"<tool_call>\s*<function=([^>]+)>(.*?)</function>\s*</tool_call>",
        re.DOTALL,
    )
    param_pattern = re.compile(
        r"<parameter=([^>]+)>\s*([\s\S]*?)\s*</parameter>"
    )

    matches = list(tool_call_pattern.finditer(text))
    if not matches:
        return text, []

    # Extract content before the first tool_call
    content = text[:matches[0].start()].strip()

    tool_calls = []
    for m in matches:
        fn_name = m.group(1).strip()
        body = m.group(2)
        args = {}
        for pm in param_pattern.finditer(body):
            param_name = pm.group(1).strip()
            param_value = pm.group(2).strip()
            # Try to parse as JSON value (number, bool, etc.)
            try:
                args[param_name] = json.loads(param_value)
            except (json.JSONDecodeError, ValueError):
                args[param_name] = param_value

        tool_calls.append({
            "id": f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": fn_name,
                "arguments": json.dumps(args),
            },
        })

    return content, tool_calls


def format_tool_results_message(msg: dict) -> str:
    """Convert an OpenAI tool result message to Qwen3.5 format."""
    content = msg.get("content", "")
    tool_call_id = msg.get("tool_call_id", "")
    return f"<tool_response>\n{content}\n</tool_response>"


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------
def build_cache(text: str, cache_file: Optional[str] = None):
    """Pre-fill the KV cache with document text using TurboQuant."""
    global prompt_cache, cache_prefix_tokens, cache_prefix_text

    print(f"[cache] Tokenizing {len(text)} chars...")
    tokens = tokenizer.encode(text)
    token_count = len(tokens)
    print(f"[cache] {token_count} tokens to process")

    stats["doc_tokens"] = token_count

    prompt_cache = make_prompt_cache(model)
    patch_attention_dispatch()

    prefill_step = 2048
    processed = 0
    t0 = time.time()

    while processed < token_count - 1:
        remaining = (token_count - processed) - 1
        n = min(prefill_step, remaining)
        chunk = mx.array(tokens[processed : processed + n])[None]
        model(chunk, cache=prompt_cache)
        convert_prompt_cache(prompt_cache, turbo_config, backend="turbomlx")
        mx.eval([c.state for c in prompt_cache])
        processed += n
        elapsed = time.time() - t0
        tps = processed / elapsed if elapsed > 0 else 0
        print(f"[cache] {processed}/{token_count} tokens ({tps:.1f} tok/s)", end="\r")

    elapsed = time.time() - t0
    stats["cache_build_time"] = elapsed
    print(f"\n[cache] Done in {elapsed:.1f}s ({token_count / elapsed:.1f} tok/s)")

    cache_prefix_tokens = tokens
    cache_prefix_text = text

    if cache_file:
        print(f"[cache] Saving to {cache_file}...")
        save_prompt_cache(cache_file, prompt_cache)
        print(f"[cache] Saved.")


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------
def _build_prompt(messages: list, tools: list = None) -> str:
    """Build a ChatML prompt from messages, with optional tool definitions."""
    parts = []
    tool_text = format_tools_for_prompt(tools) if tools else ""
    system_injected = False

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            if prompt_cache is not None:
                continue  # system prompt is in the cache
            # Append tool definitions to system prompt
            if tool_text and not system_injected:
                content = f"{content}\n\n{tool_text}"
                system_injected = True
            parts.append(f"<|im_start|>system\n{content}<|im_end|>")

        elif role == "assistant":
            # Check if this message has tool_calls (multi-turn tool use)
            tool_calls = msg.get("tool_calls", [])
            if tool_calls:
                tc_text = ""
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    fn_name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments", "{}"))
                    except json.JSONDecodeError:
                        args = {}
                    params = ""
                    for k, v in args.items():
                        params += f"\n<parameter={k}>\n{v}\n</parameter>"
                    tc_text += f"\n<tool_call>\n<function={fn_name}>{params}\n</function>\n</tool_call>"
                full_content = (content or "") + tc_text
                parts.append(f"<|im_start|>assistant\n{full_content}<|im_end|>")
            else:
                parts.append(f"<|im_start|>assistant\n{content}<|im_end|>")

        elif role == "tool":
            # Tool results go as user message with <tool_response> tags
            tr = format_tool_results_message(msg)
            parts.append(f"<|im_start|>user\n{tr}<|im_end|>")

        else:  # user
            parts.append(f"<|im_start|>{role}\n{content}<|im_end|>")

    # If tools were provided but no system message existed, inject as system
    if tool_text and not system_injected:
        parts.insert(0, f"<|im_start|>system\n{tool_text}<|im_end|>")

    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------
def _generate_tokens(prompt_text: str, max_tokens: int, temperature: float) -> str:
    """Core token generation loop. Returns raw text."""
    query_tokens = tokenizer.encode(prompt_text)

    if prompt_cache is not None:
        working_cache = copy.deepcopy(prompt_cache)
    else:
        working_cache = make_prompt_cache(model)

    query_mx = mx.array(query_tokens)[None]
    logits = model(query_mx, cache=working_cache)
    mx.eval(logits)

    generated_tokens = []
    eos_token = tokenizer.eos_token_id
    im_end_token = tokenizer.encode("<|im_end|>")[-1] if "<|im_end|>" in tokenizer.get_vocab() else None

    for _ in range(max_tokens):
        if temperature <= 0:
            token = mx.argmax(logits[:, -1, :], axis=-1)
        else:
            probs = mx.softmax(logits[:, -1, :] / temperature, axis=-1)
            token = mx.random.categorical(mx.log(probs))

        token_id = token.item()
        if token_id == eos_token or token_id == im_end_token:
            break

        generated_tokens.append(token_id)
        logits = model(token[None], cache=working_cache)
        mx.eval(logits)

    stats["queries"] += 1
    stats["total_output_tokens"] += len(generated_tokens)

    result = tokenizer.decode(generated_tokens)
    # Strip thinking tags
    result = re.sub(r"<think>.*?</think>\s*", "", result, flags=re.DOTALL)
    return result


def _generate_tokens_stream(prompt_text: str, max_tokens: int, temperature: float):
    """Core streaming token generation. Yields text chunks, filtering <think> blocks."""
    query_tokens = tokenizer.encode(prompt_text)

    if prompt_cache is not None:
        working_cache = copy.deepcopy(prompt_cache)
    else:
        working_cache = make_prompt_cache(model)

    query_mx = mx.array(query_tokens)[None]
    logits = model(query_mx, cache=working_cache)
    mx.eval(logits)

    eos_token = tokenizer.eos_token_id
    im_end_token = tokenizer.encode("<|im_end|>")[-1] if "<|im_end|>" in tokenizer.get_vocab() else None
    generated_count = 0
    accumulated = ""
    in_think = False
    think_indicator_sent = False
    think_dots = 0

    for _ in range(max_tokens):
        if temperature <= 0:
            token = mx.argmax(logits[:, -1, :], axis=-1)
        else:
            probs = mx.softmax(logits[:, -1, :] / temperature, axis=-1)
            token = mx.random.categorical(mx.log(probs))

        token_id = token.item()
        if token_id == eos_token or token_id == im_end_token:
            break

        generated_count += 1
        text = tokenizer.decode([token_id])
        logits = model(token[None], cache=working_cache)
        mx.eval(logits)

        accumulated += text

        if in_think:
            if "</think>" in accumulated:
                after = accumulated.split("</think>", 1)[1].lstrip()
                accumulated = ""
                in_think = False
                # End thinking indicator with newline
                if think_indicator_sent:
                    yield "\n\n"
                if after:
                    yield after
            else:
                # Send animated dots while thinking
                think_dots += 1
                if think_dots % 8 == 0:  # every ~8 tokens
                    if not think_indicator_sent:
                        yield "> *thinking"
                        think_indicator_sent = True
                    yield "."
        else:
            if "<think>" in accumulated:
                before = accumulated.split("<think>")[0]
                if before:
                    yield before
                accumulated = "<think>" + accumulated.split("<think>", 1)[1]
                in_think = True
                think_dots = 0
            else:
                yield text
                accumulated = ""

    stats["queries"] += 1
    stats["total_output_tokens"] += generated_count


# ---------------------------------------------------------------------------
# API Endpoints (OpenAI-compatible)
# ---------------------------------------------------------------------------
@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": model_name,
                "object": "model",
                "created": int(server_start_time),
                "owned_by": "local",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    max_tokens = body.get("max_tokens", 1024)
    temperature = body.get("temperature", 0.7)
    stream = body.get("stream", False)
    tools = body.get("tools", None)
    req_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    prompt_text = _build_prompt(messages, tools)

    if stream and not tools:
        # Streaming without tools (simple text streaming)
        async def event_stream():
            import asyncio, queue, threading
            # Send initial role chunk immediately so client shows activity indicator
            yield f"data: {json.dumps({'id': req_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_name, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]})}\n\n"
            # Run generation in a thread so the role chunk flushes immediately
            q = queue.Queue()
            def _run():
                try:
                    for chunk_text in _generate_tokens_stream(prompt_text, max_tokens, temperature):
                        q.put(chunk_text)
                finally:
                    q.put(None)
            threading.Thread(target=_run, daemon=True).start()
            while True:
                # Poll queue, yielding control to asyncio between checks
                try:
                    item = q.get(timeout=0.05)
                except queue.Empty:
                    continue
                if item is None:
                    break
                chunk_text = item
                chunk = {
                    "id": req_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model_name,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": chunk_text},
                            "finish_reason": None,
                        }
                    ],
                }
                yield f"data: {json.dumps(chunk)}\n\n"
            final = {
                "id": req_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model_name,
                "choices": [
                    {"index": 0, "delta": {}, "finish_reason": "stop"}
                ],
            }
            yield f"data: {json.dumps(final)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    # Non-streaming (or streaming with tools — generate full then parse)
    raw_text = _generate_tokens(prompt_text, max_tokens, temperature)

    # Check for tool calls in the response
    if tools:
        content_text, tool_calls = parse_tool_calls(raw_text)
    else:
        content_text = raw_text
        tool_calls = []

    if tool_calls:
        # Return tool call response
        message = {"role": "assistant", "content": content_text or None, "tool_calls": tool_calls}
        finish_reason = "tool_calls"

        if stream:
            # Stream tool calls as SSE chunks
            async def tool_event_stream():
                # First chunk: role
                yield f"data: {json.dumps({'id': req_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_name, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': None}, 'finish_reason': None}]})}\n\n"
                # Tool call chunks
                for i, tc in enumerate(tool_calls):
                    yield f"data: {json.dumps({'id': req_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_name, 'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': i, 'id': tc['id'], 'type': 'function', 'function': {'name': tc['function']['name'], 'arguments': tc['function']['arguments']}}]}, 'finish_reason': None}]})}\n\n"
                # Final
                yield f"data: {json.dumps({'id': req_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_name, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]})}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(tool_event_stream(), media_type="text/event-stream")

        return {
            "id": req_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_name,
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": finish_reason,
                }
            ],
            "usage": {
                "prompt_tokens": len(tokenizer.encode(prompt_text)),
                "completion_tokens": len(tokenizer.encode(raw_text)),
                "total_tokens": len(tokenizer.encode(prompt_text)) + len(tokenizer.encode(raw_text)),
            },
        }

    # Regular text response
    if stream:
        # Already generated full text, stream it in one chunk
        async def text_event_stream():
            yield f"data: {json.dumps({'id': req_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_name, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': content_text}, 'finish_reason': None}]})}\n\n"
            yield f"data: {json.dumps({'id': req_id, 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': model_name, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(text_event_stream(), media_type="text/event-stream")

    return {
        "id": req_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": len(tokenizer.encode(prompt_text)),
            "completion_tokens": len(tokenizer.encode(raw_text)),
            "total_tokens": len(tokenizer.encode(prompt_text)) + len(tokenizer.encode(raw_text)),
        },
    }


# ---------------------------------------------------------------------------
# Cache endpoints
# ---------------------------------------------------------------------------
@app.post("/v1/cache/load")
async def load_cache_endpoint(request: Request):
    """Load a document/codebase into the KV cache."""
    body = await request.json()
    text = body.get("text", "")
    file_path = body.get("file", "")
    cache_file = body.get("cache_file", None)

    if file_path:
        p = Path(file_path)
        if not p.exists():
            return JSONResponse(status_code=404, content={"error": f"File not found: {file_path}"})
        text = p.read_text(encoding="utf-8", errors="ignore")

    if not text:
        return JSONResponse(status_code=400, content={"error": "Provide 'text' or 'file' in body"})

    system_text = f"<|im_start|>system\nYou are a helpful assistant. Use the following context to answer questions accurately.\n\n{text}<|im_end|>\n"
    build_cache(system_text, cache_file)

    return {
        "status": "ok",
        "doc_tokens": stats["doc_tokens"],
        "cache_build_time": f"{stats['cache_build_time']:.1f}s",
    }


@app.post("/v1/cache/load-dir")
async def load_cache_dir(request: Request):
    """Load all files from a directory into the KV cache."""
    body = await request.json()
    directory = body.get("directory", "")
    extensions = body.get("extensions", [".py", ".ts", ".js", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".sh"])
    cache_file = body.get("cache_file", None)
    max_files = body.get("max_files", 500)

    if not directory:
        return JSONResponse(status_code=400, content={"error": "Provide 'directory' in body"})

    dir_path = Path(directory)
    if not dir_path.is_dir():
        return JSONResponse(status_code=404, content={"error": f"Directory not found: {directory}"})

    files = []
    for ext in extensions:
        files.extend(dir_path.rglob(f"*{ext}"))
    files = sorted(files)[:max_files]

    parts = [f"# Codebase: {dir_path.name}\n# Files: {len(files)}\n"]
    for f in files:
        try:
            rel = f.relative_to(dir_path)
            content = f.read_text(encoding="utf-8", errors="ignore")
            parts.append(f"\n--- {rel} ---\n{content}\n")
        except Exception:
            continue

    text = "\n".join(parts)
    system_text = f"<|im_start|>system\nYou are a helpful assistant analyzing a codebase. Use the following source code to answer questions accurately.\n\n{text}<|im_end|>\n"
    build_cache(system_text, cache_file)

    return {
        "status": "ok",
        "files_loaded": len(files),
        "doc_tokens": stats["doc_tokens"],
        "cache_build_time": f"{stats['cache_build_time']:.1f}s",
    }


@app.get("/v1/cache/status")
async def cache_status():
    return {
        "model": model_name,
        "cache_loaded": prompt_cache is not None,
        "doc_tokens": stats["doc_tokens"],
        "cache_build_time": f"{stats['cache_build_time']:.1f}s",
        "queries": stats["queries"],
        "total_output_tokens": stats["total_output_tokens"],
        "uptime": f"{time.time() - server_start_time:.0f}s",
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model": model_name}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global model, tokenizer, turbo_config, model_name, server_start_time

    parser = argparse.ArgumentParser(description="OpenCode MLX + TurboQuant Server")
    parser.add_argument("--model", default="mlx-community/Qwen3.5-4B-MLX-8bit", help="HuggingFace model ID")
    parser.add_argument("--port", type=int, default=8899, help="Server port")
    parser.add_argument("--host", default="0.0.0.0", help="Server host")
    parser.add_argument("--bits", type=int, default=4, help="TurboQuant bits (1-4)")
    parser.add_argument("--preload", default=None, help="Pre-load a file into cache on startup")
    parser.add_argument("--preload-dir", default=None, help="Pre-load a directory into cache on startup")
    parser.add_argument("--cache-file", default=None, help="Save/load cache from this file")
    args = parser.parse_args()

    model_name = args.model
    server_start_time = time.time()

    print(f"[server] Loading model: {model_name}")
    model, tokenizer = load(model_name)

    turbo_config = TurboQuantConfig(
        bits_total=args.bits,
        scorer_mode=ScorerMode.NATIVE_MLX,
    )
    print(f"[server] TurboQuant config: {args.bits}-bit KV cache")

    if args.cache_file and Path(args.cache_file).exists():
        print(f"[server] Loading cached KV from {args.cache_file}...")
        prompt_cache_data = load_prompt_cache(args.cache_file)
        print(f"[server] Cache loaded.")
    elif args.preload:
        text = Path(args.preload).read_text(encoding="utf-8", errors="ignore")
        system_text = f"<|im_start|>system\nYou are a helpful assistant. Use the following context to answer questions accurately.\n\n{text}<|im_end|>\n"
        build_cache(system_text, args.cache_file)
    elif args.preload_dir:
        dir_path = Path(args.preload_dir)
        extensions = [".py", ".ts", ".js", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".sh"]
        files = []
        for ext in extensions:
            files.extend(dir_path.rglob(f"*{ext}"))
        files = sorted(files)[:500]
        parts = [f"# Codebase: {dir_path.name}\n# Files: {len(files)}\n"]
        for f in files:
            try:
                rel = f.relative_to(dir_path)
                content = f.read_text(encoding="utf-8", errors="ignore")
                parts.append(f"\n--- {rel} ---\n{content}\n")
            except Exception:
                continue
        text = "\n".join(parts)
        system_text = f"<|im_start|>system\nYou are a helpful assistant analyzing a codebase. Use the following source code to answer questions accurately.\n\n{text}<|im_end|>\n"
        build_cache(system_text, args.cache_file)

    # Warmup: run a dummy inference to compile Metal kernels
    print(f"[server] Warming up Metal kernels...")
    t0 = time.time()
    warmup_tokens = tokenizer.encode("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n")
    warmup_cache = make_prompt_cache(model)
    logits = model(mx.array(warmup_tokens)[None], cache=warmup_cache)
    mx.eval(logits)
    # Generate a few tokens to warm decode path too
    for _ in range(3):
        token = mx.argmax(logits[:, -1, :], axis=-1)
        logits = model(token[None], cache=warmup_cache)
        mx.eval(logits)
    del warmup_cache, logits
    print(f"[server] Warmup done in {time.time() - t0:.1f}s")

    print(f"[server] Starting on {args.host}:{args.port}")
    print(f"[server] API: http://{args.host}:{args.port}/v1/chat/completions")
    print(f"[server] Cache: http://{args.host}:{args.port}/v1/cache/status")
    print(f"[server] Tool calling: enabled (Qwen3.5 XML -> OpenAI format)")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
