# Canvas2D

A 2D context is a state machine in front of a rasterizer. Its costs are the
state changes, the number of separate drawing operations, and the pixels each
one touches.

## State

- **Group by style, then draw.** Sort or bucket what is to be drawn by fill,
  stroke and line width; set the style once per group.
- **Assigning `fillStyle` or `strokeStyle` parses the string** every time,
  even when it is the same colour. Keep the last value set and skip the
  assignment when it has not changed.
- **Few distinct colours.** A colour of its own per element is a style
  change per element and no grouping at all: 360 unique colours against a
  palette of 10 has measured twice as slow for the same shapes. Quantize to
  a palette where the picture allows it.
- **One path, many shapes.** `beginPath`, then every shape of the group
  (`moveTo` / `arc` / `rect` …), then a single `fill` or `stroke`. A fill per
  shape costs a rasterizer call per shape.
- **`save` / `restore` copy the whole state.** In a hot loop set the
  transform directly with `setTransform(a, b, c, d, e, f)` and restore the
  few properties changed by hand.
- **Gradients and patterns are objects to create once** and reuse, not per
  draw.
- **Reuse `Path2D` objects** for geometry drawn again and again; the browser
  can keep their tessellation.
- **`setLineDash` and wide joins are expensive** per segment; avoid them on
  paths with thousands of points.

## Pixels

- **The bill is width × height × (device pixel ratio)².** A canvas at ratio 2
  has four times the pixels of the same canvas at 1. Choose the ratio; do not
  inherit it.
- **`shadowBlur`, `filter` and `globalCompositeOperation` other than
  `source-over`** make the browser render to an intermediate surface.
  Shadows on many small shapes are among the slowest things a 2D context
  does: pre-render the shadowed shape once and blit it.
- **Overdraw counts.** Painting a background, then a panel over it, then
  shapes over that fills the same pixels three times. Draw opaque things
  front to back with clipping, or skip what is covered.
- **Clear only what changes.** `clearRect` of the dirty rectangle and a clip
  to it, then redraw what intersects — instead of the whole canvas.
- **`canvas.width = w` reallocates the backing store** and resets all state.
  Do it on resize, never per frame.
- **An opaque canvas** (`getContext('2d', { alpha: false })`) saves the
  compositor a blend with the page behind it.

## Caching

- **Static layers in a canvas of their own.** Whatever does not change between
  frames (a background, a grid, finished strokes) is drawn once into an
  offscreen canvas and copied with one `drawImage`.
- **Sprites for repeated shapes:** rasterize once at the size needed, blit
  many times.
- **A cache has a price and a duty:** it holds width × height × 4 bytes for
  as long as it lives, a canvas has a largest size the browser allows, and
  it must be redrawn whenever what it holds changes. Cache what changes
  rarely; something that changes every frame is not worth caching.
- **Clip cheaply.** A rectangle clip is nearly free; a clip to a complex
  path is rasterized per draw; masking through a second canvas and a
  composite operation costs a full surface. Prefer the first that fits.
- **`drawImage` at integer coordinates and at its own size** is a copy; at a
  fractional position or scaled it is a filtered resample. Round the
  position; set `imageSmoothingEnabled = false` when no resampling is wanted.
- **Cache `measureText`** by string and font.

## Readback

- **`getImageData` is a synchronous copy from the GPU** on an accelerated
  canvas: it stalls the pipeline until the pixels arrive. Never in the frame
  path.
- **No trick gets round it.** Drawing the canvas into a 1 × 1 canvas to read
  "just one pixel" still brings the pixels back from the GPU, and adds a
  draw: it has measured 20× slower than `getImageData` on the canvas itself.
- A canvas read often can be created with `{ willReadFrequently: true }`,
  which keeps it in CPU memory: reads become cheap, **and every draw becomes
  slower**. It is for canvases that are mostly read, not mostly drawn.
- **`putImageData` ignores transforms, clipping and blending** and uploads
  the whole rectangle. For per-pixel work done every frame, WebGPU or a
  worker is the tool, not a 2D context.

## Text and images

- Text is rasterized per call. Text that does not change is a cached bitmap.
- Decode images ahead of time (`createImageBitmap`, `img.decode()`); the
  first `drawImage` of an undecoded image blocks on the decode.
- An `ImageBitmap` is cheaper to draw than an `<img>` or another canvas.

## When to stop

A 2D context draws thousands of shapes per frame comfortably and tens of
thousands with care. Past that — or when the work is per pixel, or needs
blending the context does not have — the next step is not a cleverer 2D
loop but instanced drawing on the GPU.
