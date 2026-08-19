#!/usr/bin/env python3
"""
Embedding helper for The Secretary's semantic fallback.

Reads JSON {"texts": [...]} on stdin, writes JSON {"dim": N, "vectors": [[...]]}
on stdout. Vectors are L2-normalised, so a dot product IS the cosine similarity
and sqlite-vec's default distance orders them correctly.

Kept as a separate process on purpose: the model costs ~600 MB resident, and the
hook path must never pay that. Only `search` and `index-vectors` invoke it, and
only when FTS5 alone could not answer.
"""
import json
import sys

MODEL = "mlx-community/Qwen3-Embedding-0.6B-8bit"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        json.dump({"error": f"bad input: {e}"}, sys.stdout)
        return 1

    texts = payload.get("texts") or []
    if not texts:
        json.dump({"dim": 0, "vectors": []}, sys.stdout)
        return 0

    try:
        import numpy as np
        import mlx.core as mx
        from mlx_embeddings import load, generate
    except ImportError as e:
        json.dump({"error": f"missing dependency: {e}"}, sys.stdout)
        return 1

    try:
        model, tokenizer = load(payload.get("model") or MODEL)
    except Exception as e:
        json.dump({"error": f"model load failed: {e}"}, sys.stdout)
        return 1

    out = []
    batch = int(payload.get("batch") or 32)
    for i in range(0, len(texts), batch):
        chunk = [t[:512] for t in texts[i:i + batch]]
        emb = generate(model, tokenizer, texts=chunk).text_embeds
        # mlx may hand back bfloat16, which numpy cannot view directly.
        arr = np.array(emb.astype(mx.float32))
        out.append(arr)

    V = np.vstack(out).astype("float32")
    norms = np.linalg.norm(V, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    V = V / norms

    json.dump({"dim": int(V.shape[1]), "vectors": V.tolist()}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
