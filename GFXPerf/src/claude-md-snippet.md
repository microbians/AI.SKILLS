<!-- skill: gfx-perf vSKILL_VERSION -->
## Graphics performance (JavaScript, Canvas2D, WebGPU)

For any performance work on graphics code, STRICTLY follow the `gfx-perf` skill rules. Invoke it BEFORE: optimizing or profiling a render loop or anything that runs per frame or per element, writing or changing a shader, a buffer upload or a render pass for speed, writing a page that measures frame time, or answering "is this faster?".

**The rule underneath all of them: a number you did not measure is a guess.** Measure in a real browser on the real display (never headless), after a warm-up, in a plain loop (never inside `requestAnimationFrame`), report the median, and interleave the variants (A, B, A, B). Count before timing — draw calls, bytes uploaded, allocations, passes. Allocate nothing per frame: create arrays, typed arrays and objects once and reuse them. A change that does not move the median is deleted, and every result that changed a decision is written into the project's findings log.
