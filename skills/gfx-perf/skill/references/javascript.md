# JavaScript in hot loops

What runs per frame or per element. Everything here is about two costs: work
the engine has to do that the program did not need, and memory the garbage
collector has to take back.

## Allocation

**Allocate nothing per frame.** Every array, object, closure or string made
inside the loop is garbage a moment later. Collecting it does not cost a
little on every frame: it costs nothing for a while and then a pause, which is
exactly what a dropped frame is. On a render loop that built its working
arrays on every pass, creating them once and reusing them was the largest
single improvement the loop ever got — larger than any change to the drawing
itself.

```js
// Slow: three arrays and N objects per frame
function frame(shapes) {
	const visible = shapes.filter(s => s.visible);
	const points = visible.map(s => ({ x: s.x, y: s.y }));
	draw([...points, ...extra]);
}

// Fast: storage made once, filled each frame
const points = new Float32Array(MAX * 2);
function frame(shapes) {
	let n = 0;
	for (let i = 0; i < shapes.length; i++) {
		const s = shapes[i];
		if (!s.visible) continue;
		points[n++] = s.x;
		points[n++] = s.y;
	}
	draw(points, n);
}
```

Rules:

- **Create working storage once**, outside the loop — at module level, in the
  constructor, or lazily on first use — and reuse it every pass.
- **Grow by doubling, never shrink.** When a buffer is too small, allocate one
  twice the size and copy; keep it for good. A buffer sized to each frame's
  need reallocates every time the need changes.
- **Pass a count, not a slice.** `array.length = 0` followed by `push` is
  fine for a plain array that keeps its capacity; `slice`, `concat`, spread
  and `Array.from` all allocate.
- **Write into an out parameter** instead of returning `{ x, y }` or
  `[x, y]`. A function called per element that returns a fresh object
  allocates per element.
- **No closures in the loop.** `forEach(s => …)`, `sort((a, b) => …)` and
  inline callbacks create a function object each pass when they capture
  loop variables. Hoist the function.
- **`subarray` allocates a view object.** Pass the buffer and an offset.
- **A getter can allocate.** Testing a capability by calling a getter
  (`el.commandData !== undefined`, where the getter returns a `subarray`)
  makes the object every time, only to throw it away: test with
  `'commandData' in el`. One such test called a few times per element on
  every rebuild cost 12 of 19 ms over 84K elements.
- **No strings per element:** keys built by concatenation, `toFixed`,
  template literals, colour strings. Build them once and cache by the value
  they depend on.
- **Pool what must be an object** (particles, events): take from a free list,
  return on release. Taking one back must reset **everything** its last life
  changed — a recycled object that keeps one stale field is a bug that looks
  random.

The small ones count as much as the large: a four-number colour array built
on every clear, a typed-array view made over the same buffer on every call, a
callback created for every shape drawn. A render path is done when it
allocates **nothing** in steady state, not when it allocates little.

Hidden allocations worth knowing: destructuring an array (`const [a, b] = f()`
creates the array `f` returns), `arguments`, rest parameters, `Object.keys` /
`entries`, `JSON` round trips, boxed numbers in a `Map` with object values,
iterating a `Map` or `Set` with `for…of` (an iterator and an entry array per
step in some engines).

## Do less

Before making work faster, look for work that need not happen.

- **Dirty tracking:** recompute and redraw only what changed since the last
  frame. Setters mark; the loop reads the marks.
- **Idle costs nothing.** When nothing changed, nothing is recomputed,
  uploaded or drawn. An update step reports whether it changed anything, and
  the frame is skipped when none did.
- **Culling:** skip what is outside the view, by a bounding box checked
  before any real work.
- **Occlusion:** skip what is fully covered by something opaque in front.
- **Spatial index** (a grid, a tree) when each element needs its neighbours:
  it turns N² pair checks into N × a few.
- **Cursor instead of scan.** When a loop walks forward and, for each step,
  searches a sorted list for the entries near it, it does not need to start
  from the beginning: keep an index that only moves forward. One per-item
  scan over a list of hundreds is easy to write and easy to miss.
- **Cache derived values** by what they depend on: a tessellation by its
  shape and scale, a measured text by its string and font. A cache keyed by
  an object's identity misses every time when that object is rebuilt — and
  then also grows without end. Key by the values, and bound the cache.
- **Give bounds instead of measuring them.** A container whose extent is
  known (a layer the size of the view) should be told it, not have it
  recomputed from its children each frame.
- **Level of detail:** fewer segments, a smaller mip, a cheaper path for what
  is small on screen.
- **Early out** on the cheapest test first.

## Shapes and kinds

Engines compile fast code for an object layout or an array's element kind
they have seen, and fall back to slow generic code when the next one differs.

- **Set every field in the constructor, in the same order**, with a value of
  the type it will keep. Never add a property later, never `delete` one (set
  it to `null`).
- **One shape per call site.** A hot function that receives objects of many
  different layouts stops being optimized. Give variants the same fields.
- **Keep arrays packed and of one kind:** no holes, no `undefined`, not
  integers mixed with floats mixed with objects. Preallocating with
  `new Array(n)` makes a holey array; fill it, or use a typed array.
- **Numbers in typed arrays.** `Float32Array` / `Uint32Array` store values
  inline, with no boxing and a fixed layout the GPU can take as they are.
  Prefer several parallel typed arrays (structure of arrays) to an array of
  objects for data touched per frame. Updating 100,000 elements straight in
  their typed arrays has measured about 25× faster than walking the objects
  that own them.
- A `Float32Array` rounds on write: arithmetic is still in doubles, so
  accumulate in a local variable, not in the array.

## Function size

**Hot loops live in small functions — never inside a giant method.** A JIT
optimizes function by function, and a very large one (a thousand lines and
up) has its loops left at the lower tiers. The symptom: every step of the
work is slow per element — 40–80 ns where 5–10 is normal — and nothing in the
loop's own code explains it. Measured on JavaScriptCore, a path build of
1,444 lines (flatten, joins, tile binning, fan map, 84K paths, 940K segments):

| Step | Inside the method | In a function of its own |
|------|------------------:|-------------------------:|
| flatten | 51 ms | 6 ms |
| joins | 72 ms | 8 ms |
| segment boxes | 43 ms | 7 ms |
| tile lists | 66 ms | 11 ms |
| the whole build | 482 ms | 170 ms |

Same output to the pixel.

- **Move each loop into a module function.** Pass the arrays in (scratch
  arrays the caller owns and reuses), return a number, and hand several
  results back through one module-level holder object with fixed fields
  (`FLAT.segOff`, `FLAT.minX` …), which allocates nothing.
- **Extract all of them, not one.** Taking a single loop out sped it up
  (40 → 16 ms) and made the loops left behind slower (joins 72 → 115 ms):
  the method's own tier-up changed. Gains show once the method only
  orchestrates.
- **Find it by timing each step inside the function**, behind a debug flag
  (sum `performance.now()` laps per step over all elements), and divide by
  the element count. A profiler that times the method whole shows one big
  number and no cause. A wrapper per method inflates the small calls.
- **Twin loops become one function with a parameter** — two copies of a loop
  differing in one flag are one function, which also halves what the JIT has
  to warm.

## Loops

- **Plain `for` with an index** in hot paths. `for…of` over arrays is close in
  modern engines; `forEach`, `reduce` and `for…in` are not.
- **Hoist invariants:** `const n = list.length`, `const m = this.matrix`,
  `Math.cos(angle)` of an angle that does not change inside the loop.
- **Avoid `shift`, `unshift` and `splice` in loops** — each moves the rest of
  the array. Remove by swapping with the last element when order does not
  matter; use a head index for a queue.
- **Multiply, do not `Math.pow`,** for small integer powers.
  `Math.hypot` is markedly slower than `Math.sqrt(x * x + y * y)` in some
  engines — on JavaScriptCore a per-segment length sum went 16 → 5 ms; in a
  per-element path, measure it.
- **`Math.min` / `Math.max` with more than two arguments** in a per-element
  path: write the comparisons (`if (x < minX) minX = x;`).
- **Work that does not depend on the outer loop** comes out of it, however
  natural it reads inside: a segment's column span is the same for every row
  it crosses, so it is computed once per segment, not once per row and
  segment. Reserve room once, for exactly what will be written, when a
  counting pass can tell how much.
- **Compare squared distances** and skip the square root.
- **Incremental instead of absolute** when stepping evenly: add a delta
  instead of recomputing from the start; rotate by a constant with one
  sine and cosine computed once.
- **No `try` / `catch` or `await` per element.** Wrap the loop, not the
  iteration.
- **Decide once, not per element.** A choice that is the same for the whole
  run (which solver, which backend, which variant) is made at set-up and
  kept as a function reference; the loop calls it with no `if`.
- **A table for an expensive closed form.** A function called millions of
  times over a bounded domain can be read from a precomputed table with
  interpolation. Build it on first use, and measure its error against the
  exact form before trusting it.

## The main thread

- **Render once per frame, from `requestAnimationFrame`** — never from an
  input event. Events set state; the frame reads it. Pointer moves arrive
  faster than frames: use the coalesced events for the data, one render for
  the picture.
- **Hit testing runs on every pointer move.** Test only what can be
  interacted with, by bounding box first and through a spatial index when
  there are many; skip whole groups that hold nothing interactive.
- **Do not read layout in the loop.** `getBoundingClientRect`,
  `offsetWidth`, `getComputedStyle` force the browser to lay out; read once
  on resize and keep the value.
- **Never `await` inside the render loop.** Each `await` hands the frame back
  to the browser; a loop that awaited per step has measured 4 frames a
  second where the same work without it gave 50.
- **Heavy work that is not drawing** goes to a worker; hand buffers over by
  transfer or share them, never by copy. A worker is not free: every message
  is serialized and arrives late, so a small computation is faster where it
  is. Move work out only when it is large and its data can cross without
  being copied.

## Measuring JavaScript

- The JIT compiles a function after it has run many times, and may throw the
  compiled code away when it sees a new type. **Warm up, then measure;
  interleave the variants.** A variant measured second in the same process
  has repeatedly looked twice as slow, or twice as fast, purely from the
  order.
- `performance.now()` is coarse (as much as 1 ms in some browsers). Time a
  batch of iterations, not one.
- A micro-benchmark that the engine can prove has no effect is deleted by the
  optimizer and measures nothing. Use the result.
- Engines differ. A change that helps one may do nothing in another: measure
  in the browser the code ships to.
