---
name: gfx-perf
description: Performance work on graphics code in the browser — JavaScript hot loops, Canvas2D and WebGPU. Use BEFORE optimizing, profiling or benchmarking a render loop, a stroke/particle/shape pipeline, a shader, a buffer upload, or any code that runs per frame or per element; when a page stutters, drops frames or a change "should be faster"; and when writing a page that measures frame time. Gives the measuring protocol (real browser, warm-up, median, interleaved A/B), a symptom → cause guide, and the rules for allocation-free JavaScript, Canvas2D state and fill rate, and WebGPU pipelines, buffers, passes and shaders.
version: 1.0.0
updated: 2026-10-11
license: MIT
compatibility: opencode
metadata:
  type: methodology
  scope: client-side graphics
  stacks: [javascript, canvas2d, webgpu, wgsl]
---

# gfx-perf

Rules for making graphics code fast in the browser, and for proving that it
got faster. Three layers, cheapest to check first: the **JavaScript** that
decides what to draw, the **Canvas2D** calls or **WebGPU** commands that draw
it, and the **pixels** the GPU has to fill.

The rule underneath all of them:

> **A number you did not measure is a guess. A number measured the wrong way
> is worse: it is a guess you believe.**

## The loop

Every optimization goes through these steps, in this order. Skipping one is
how a week goes into making the wrong thing faster.

1. **Reproduce and count.** One fixed scene, one fixed input. Write down what
   it does per frame: elements, draw calls, bytes uploaded, passes, pixels.
   Counts are deterministic and often show the problem before any timing does.
2. **Measure the baseline** with the protocol in
   [references/measuring.md](references/measuring.md): real browser, warm-up,
   median of many frames, started by a button.
3. **Find where the time goes** — CPU script, garbage collection, raster, or
   GPU (the guide below). Do not optimize a layer until you know it is the
   slow one.
4. **Change one thing.** The smallest change that tests the hypothesis.
5. **Measure again, interleaved with the baseline** (A, B, A, B — never all of
   A and then all of B: the JIT and the GPU warm up along the way and the
   second one measured looks faster or slower for no reason of its own).
6. **Keep it or delete it.** A change that does not move the median is
   removed, not left "just in case". Faster code that draws something
   different is not an optimization: compare the output too.
7. **Write the finding down** ([templates/findings.md](templates/findings.md)):
   what was tried, the numbers, kept or dropped, and why. The dropped ones
   matter most — they are what stops the same dead end being tried again.

## Where the time goes

| Symptom | Likely layer | Look at |
|---------|-------------|---------|
| Frame time grows with the number of elements, steady | CPU script | The per-element loop: work that could be skipped, cached or hoisted ([javascript.md](references/javascript.md)) |
| Mostly smooth, with a hitch every few hundred ms | Garbage collection | Allocations inside the loop — arrays, objects, closures, strings ([javascript.md](references/javascript.md) § Allocation) |
| Frame time grows with the canvas size or the zoom, not with the element count | Fill rate | Pixels painted more than once, device pixel ratio, blur and shadow, full-screen passes ([canvas2d.md](references/canvas2d.md), [webgpu.md](references/webgpu.md) § Fill rate) |
| Frame time grows with the number of *different* styles, textures or materials | State changes | Batching and ordering ([canvas2d.md](references/canvas2d.md) § State, [webgpu.md](references/webgpu.md) § Draw calls) |
| The first frames are slow, then it settles | Warm-up | Shader and pipeline compilation, buffers growing, JIT ([webgpu.md](references/webgpu.md) § Create once) |
| A freeze the first time something appears, never again | Lazy creation | A pipeline compiled or a texture uploaded on its first draw: create and upload ahead ([webgpu.md](references/webgpu.md) § Lifetime) |
| Draw calls far above the number of *kinds* of thing drawn | Broken batches | Kinds interleaved in draw order ([webgpu.md](references/webgpu.md) § Draw calls) |
| Slow only on some machines | Another path | A fallback or software adapter, a missing feature, another device pixel ratio ([webgpu.md](references/webgpu.md) § Limits and features) |
| Memory grows the longer it runs | Leaked resources | GPU objects never destroyed, caches that only grow ([webgpu.md](references/webgpu.md) § Lifetime) |
| Costs the same when nothing moves | No idle path | Redrawing without a change ([javascript.md](references/javascript.md) § Do less) |
| Script time is small but frames are still late | GPU, or the compositor | Passes, overdraw, texture formats; time the GPU itself ([measuring.md](references/measuring.md) § Timing the GPU) |
| Fast when measured alone, slow in the app | Something else per frame | Layout reads, event handlers that render, a second loop |
| Slow only while a value is read back | Readback | `getImageData`, `mapAsync`, `readPixels` in the frame path |

Tell CPU from GPU before anything else: halve the canvas's pixel count (or the
device pixel ratio). Frame time halves → fill rate. Unchanged → CPU or draw
calls. Then halve the element count the same way.

## The rules, by layer

Each has its own reference with the reasons and the code. The headlines:

### JavaScript — [references/javascript.md](references/javascript.md)

- **Allocate nothing per frame.** Create arrays, typed arrays and objects
  once, outside the loop, and reuse them; grow a buffer by doubling and never
  shrink it. Building and discarding them every pass is the single most common
  cause of stutter, and on a render loop removing it is often the largest win
  available. This includes the hidden ones: `map` / `filter` / spread,
  `[x, y]` return values, closures, `subarray`, string keys.
- **Do less before doing it faster.** Skip what did not change (dirty flags),
  what is off screen (culling), what is behind something opaque. A scan over
  a whole list that only needs its neighbours becomes a cursor.
- **Keep objects one shape and arrays one kind.** Every field set in the
  constructor, in the same order, never added or deleted later; numbers in
  typed arrays.
- **Hoist what does not change** out of the loop: property chains, lengths,
  trigonometry of a constant angle, anything parsed from a string.

### Canvas2D — [references/canvas2d.md](references/canvas2d.md)

- **Group by style, then draw.** One `beginPath`, many shapes, one `fill`.
  Setting `fillStyle` parses a colour string each time: set it only when it
  changes.
- **Cache what is static** in a canvas of its own and blit it; redraw only the
  rectangle that changed.
- **Pay for pixels knowingly.** Canvas size × device pixel ratio squared is
  the bill. Shadows, blur and filters multiply it.
- **Never read pixels back in the frame path.**

### WebGPU — [references/webgpu.md](references/webgpu.md)

- **Create once:** shader modules, pipelines, bind group layouts, samplers,
  bind groups, buffers, textures. Nothing of these inside the frame.
- **One upload per buffer per frame**, from a reused CPU array.
- **Few draw calls, few passes.** Instancing; order by pipeline, then by bind
  group. Every pass has a cost of its own, large on tile-based GPUs.
- **Fragments are the bill:** tight geometry instead of full-screen quads,
  scissor, cheap fragment shaders, the smallest texture format that holds the
  data.
- **`queue.submit` returns at once** — timing around it measures nothing. See
  the measuring reference.

## Measuring — [references/measuring.md](references/measuring.md)

The short form, binding on every number reported:

- A **real browser on the real display**, not a headless one: headless has
  another device pixel ratio and often another GPU path, and has been seen off
  by 10× in both directions.
- **A button starts it**; nothing measures on load. Tell the user before
  running, so other GPU work can be closed.
- **Warm up** (~2 s) before every timed case.
- **Do not time inside `requestAnimationFrame`**: it is clamped to the display
  refresh, so everything under 16.7 ms looks the same.
- **Median**, with the count of samples; never one run, never the mean alone.
- **Interleave** the variants and keep the scene identical.
- **Show the numbers on the page**, next to what was drawn.

[templates/measure.js](templates/measure.js) is a small harness that does the
warm-up, the plain loop, the wait for the GPU and the median.

## Specifications

`scripts/fetch-specs.sh` downloads the WebGPU and WGSL specifications (the
sources the W3C documents are built from) into `~/.cache/gfx-perf/specs/`, to
search instead of recalling a limit, a built-in's signature or a validation
rule from memory:

```bash
sh scripts/fetch-specs.sh            # downloads, or refreshes if older than 30 days
grep -n "maxBindGroups" ~/.cache/gfx-perf/specs/webgpu.bs
```

## What not to do

- **Optimize by reading.** Code that looks slow often is not, and the slow
  line usually looks innocent. Measure first. A confident diagnosis — "that
  loop is quadratic" — has been fixed correctly and moved the frame time by
  nothing, because the loop was never the cost.
- **Report a number the user cannot see** on their own screen.
- **Trade correctness for speed without saying so.** If the output changes,
  that is a different feature, and the user decides.
- **Keep a change that did not help.** It is complexity with no return, and it
  hides the next real cause.
- **Make the consumer tolerate a slow producer** (throttle, debounce, skip
  frames) when the producer can be fixed.
- **Generalize from one machine.** Integrated and tile-based GPUs, 60 and
  120 Hz displays, and each browser's engine behave differently: say what the
  number was measured on.
