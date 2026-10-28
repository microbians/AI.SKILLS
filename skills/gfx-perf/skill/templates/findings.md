# Performance findings

What has been measured in this project, and what was decided from it. Newest
first. An idea that was tried and dropped stays here with the reason: it is
what stops the same dead end being tried again.

Each entry answers one question. Numbers are medians in ms unless they say
otherwise, with what they ran on.

---

## YYYY-MM-DD — The question, in one line

**Decision:** kept / dropped / needs more data — and the one-line reason.

**Scene:** what was drawn (element count, canvas size, device pixel ratio),
the page that measures it.

**Ran on:** browser and version, backend (Canvas2D / WebGPU), machine.

| Case | Median | p95 | Note |
|------|--------|-----|------|
| Baseline | | | |
| Candidate | | | |

**Counts:** what changed per frame besides time (draw calls, bytes uploaded,
allocations, passes).

**Output:** identical / differs (how) — checked how.

**Why:** what the numbers mean; what would change the decision.
