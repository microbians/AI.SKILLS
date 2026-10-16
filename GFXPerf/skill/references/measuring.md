# Measuring

How a number about graphics performance is produced so that it can be
believed, repeated and compared.

## Where

**A real browser, on the real display, with the page visible.** Not a
headless browser:

- Its device pixel ratio is usually 1 where a high-density display is 2, so
  it fills a quarter of the pixels. Coverage, antialiasing and pixel-diff
  counts change with it as well as timings.
- It may render through a software path or another GPU backend.
- Its frame pacing is not the display's.

The same scene and code have measured 10× slower in headless than in the
browser, and 20× faster — wrong in both directions, so a headless timing can
neither confirm nor rule out a regression.

Headless is safe only for values that cannot depend on the display:
validation errors, and deterministic integers such as element counts, culled
counts, buffer sizes and flags. Even those are better shown on the page.

A background tab is throttled; a window on a second display may run at
another refresh rate. State where it ran.

## The page

- **A button starts every measurement.** The page may build and show its
  scene on load; nothing is timed until Run is pressed.
- **Warn before running,** so the user can close other GPU work. A second
  browser, a video, a game or another benchmark sharing the GPU invalidates
  the numbers.
- **Results on the page:** a table with one row per case, next to what was
  drawn. A number only in the console, or only in a log, is not a result the
  user can check.
- **Measure what is still in question.** Re-running what is settled spends the
  user's time and buries the row that matters.
- **Say what it ran on:** browser and version, backend (Canvas2D / WebGPU),
  canvas size, device pixel ratio, machine.

## The loop

```js
// Wrong: clamped to the display's refresh — 2 ms and 15 ms both read 16.7
requestAnimationFrame(function tick(t) { samples.push(t - last); last = t; requestAnimationFrame(tick); });

// Right: a plain loop, each frame finished before the next is timed
for (let i = 0; i < count; i++) {
	const start = performance.now();
	renderFrame();
	await device.queue.onSubmittedWorkDone();   // WebGPU: wait for the GPU
	samples.push(performance.now() - start);
}
```

- **Do not time inside `requestAnimationFrame`.** It runs once per display
  refresh, so every frame under the refresh interval measures as the
  interval, and a scene ten times heavier looks identical.
- **Warm up before every timed case** — about 2 seconds of the same frames,
  unmeasured. Shader and pipeline compilation, buffers growing to size, the
  JIT, and anything read back a frame late all land in the first frames.
- **Yield now and then** (`await` a timeout every few dozen frames) so the
  page stays alive and the browser can present.
- **Enough samples:** 60 at the very least; more when frames are short.

## The statistic

- **Median** as the headline: one hitch does not decide it.
- **p95 or the worst frame** beside it when smoothness is the question — a
  loop with a fine median and a pause every second is not fine.
- **Never a single run,** and never the mean alone.
- Report **frame time in ms**, not frames per second: differences in fps are
  not proportional to differences in work.

## Comparing

- **Interleave:** A, B, A, B, each with its own warm-up. All of A followed by
  all of B hands B a warmer JIT, warmer caches and a GPU at another clock
  speed; differences of 2× have come from order alone.
- **One variable at a time,** same scene, same seed, same canvas size, same
  device pixel ratio.
- **Same output.** Compare what was drawn (a pixel difference, or by eye at
  the least) before comparing times. Faster and different is not faster.
- **Noise first:** run A against A. The spread between identical runs is the
  smallest difference worth believing.
- **Thermal and power state:** a laptop on battery, or hot after a long run,
  slows down. Long sessions drift; interleaving absorbs it.

## Timing the GPU

`performance.now()` around the render call measures the CPU recording
commands. To include the GPU:

- **`await device.queue.onSubmittedWorkDone()`** after `submit`: resolves
  when the GPU has finished what was submitted. Wall time from before the
  frame to after this is CPU + GPU for that frame. It is the simple, portable
  way, and what the harness template does.
- **Timestamp queries** (the `timestamp-query` feature, when the device has
  it): `timestampWrites` on a pass gives that pass's GPU time alone. Resolve
  the query set into a buffer and read it back outside the timed loop.
  Browsers may quantize the values.
- **Canvas2D on an accelerated canvas is also deferred:** the calls record
  and the raster happens later. A read of one pixel (`getImageData(0, 0, 1,
  1)`) forces it to finish — usable to bracket a 2D frame in a measuring
  page, never in a real frame.

## Counting

Before timing anything, count — per frame, on the page:

- elements considered, culled, drawn;
- draw calls, pipeline and bind group changes;
- bytes uploaded, buffers created;
- render passes and their attachments' sizes;
- for Canvas2D: fills and strokes issued, style changes.

Counts are exact and repeatable. A count that is not what was expected (a
buffer created every frame, a "fragment" of 300 KB, a draw per element where
one was intended) is the finding; no timing is needed to act on it.

## Reading a profile

The browser's performance panel, recording a few seconds of the scene:

- **Script** tall and steady → the per-frame JavaScript; look at the
  self-time of the functions under the frame callback.
- **Minor or major GC** entries, sawtooth memory → allocation in the loop.
- **Little script, long frames** → the GPU or the compositor; the panel's GPU
  track, or the timing above.
- **Layout or style recalculation inside the frame** → something reads or
  writes the page per frame.

## Writing it down

Every result that changed a decision goes into the project's findings log
(`templates/findings.md`): the question, the cases, the numbers with what
they ran on, and the decision. A dropped idea is recorded with the reason it
was dropped.
