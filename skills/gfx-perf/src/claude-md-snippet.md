<!-- skill: gfx-perf vSKILL_VERSION -->
## Graphics performance (JavaScript, Canvas2D, WebGPU)

Invoke the `gfx-perf` skill BEFORE any perf work on per-frame/per-element JS or graphics: render loops, slow loads/first frames, shaders, buffer uploads, render passes, frame-time pages, or "is this faster?".

**A number you did not measure is a guess.** Real browser on the real display (never headless), warm-up, plain loop (never inside `requestAnimationFrame`), median, interleaved A/B. Count before timing (draw calls, bytes, allocations, passes). Allocate nothing per frame. Keep a change that makes no measured number worse and improves at least one (a step's own time counts even when the frame doesn't move — it frees budget); delete it only if it worsens something or improves nothing; decisive results go to the findings log.

**Hot loops live in small functions.** JITs leave loops of huge functions (1000+ lines) at lower tiers (40–80 ns/step vs 5–10). Move EVERY loop into its own function; find it by timing steps behind a debug flag.
