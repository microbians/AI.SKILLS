# WebGPU

The CPU side records commands; the GPU runs them later. Costs fall in four
places: objects created when they should have been reused, data uploaded,
commands issued, and pixels shaded.

## Create once

Nothing in this list belongs inside the frame:

- **Shader modules and pipelines.** Creating a pipeline compiles shaders:
  milliseconds to tens of milliseconds each, and the first use may still
  stall. Create every pipeline at start-up (`createRenderPipelineAsync` /
  `createComputePipelineAsync` do it without blocking), keyed by what varies
  (format, blend, sample count) in a cache.
- **Bind group layouts, pipeline layouts, samplers.**
- **Bind groups.** One per set of resources, kept in a cache keyed by those
  resources. Creating a bind group per draw allocates and validates per draw.
- **Buffers and textures.** Sized for the most they will hold; grown by
  doubling when they are too small, never recreated at each frame's exact
  size. Destroy what is replaced.
- **Texture views** used every frame (except the canvas's current texture,
  which is new each frame).

A first frame much slower than the rest is this list not yet done: warm it up
before measuring, and before the user sees it.

## Uploads

- **One `writeBuffer` per buffer per frame**, from a CPU-side typed array made
  once and refilled. Many small writes cost a call each and a copy each.
- **Upload only the range that changed** (the offset and size arguments).
- **Keep what changes apart from what does not.** Per-instance data that is
  set once (a size, a colour, texture coordinates) in one buffer, what moves
  every frame (a position) in another: only the second is uploaded each
  frame.
- **Do not build the CPU array per frame** — the allocation rules of the
  JavaScript reference apply to it in full.
- **The CPU array's layout is the shader struct's, alignment included.** In
  WGSL a `vec2f` aligns to 8 bytes and a `vec3f` or `vec4f` to 16, so fields
  do not always sit one after another. A struct filled as if they did is
  read shifted — every field holds its neighbour's value — and it looks like
  a logic bug in the shader, not a layout one. Write the offsets down next
  to the struct.
- **Textures:** `copyExternalImageToTexture` for images and canvases,
  `writeTexture` for pixel data; neither per frame for content that has not
  changed. `copyTextureToTexture` of a full-screen texture is a full-screen
  cost.
- **Instance data over uniforms per draw.** Per-object values in an instance
  buffer read by one draw, instead of a uniform buffer and bind group each.
  Where bind groups must vary, dynamic offsets into one buffer avoid creating
  them.

## Draw calls

- **Every encoder call is CPU time**, before the GPU does anything. Three
  calls per shape for 15,000 shapes has measured 8 ms of pure command
  recording per frame, growing in step with the shape count. A draw per
  element does not scale whatever the GPU.
- **Instancing** for anything drawn more than a few times: one draw, one
  buffer of per-instance data.
- **Order by pipeline, then by bind group.** Each `setPipeline` and
  `setBindGroup` is a state change; consecutive draws that share them cost
  nothing extra.
- **A batch breaks where the kind changes:** another pipeline, texture, blend
  mode or topology. Drawn A, B, A, B, two kinds cost four draws; grouped,
  two. Where the picture's own order (what is in front) forces the
  interleaving, make the kinds one: a shared pipeline with a per-instance
  flag, textures in one atlas or array.
- **Clip by the cheapest means that fits:** a scissor rectangle costs
  nothing, a stencil mask a pass over the mask's shape, a mask rendered to a
  texture a whole surface and another pass.
- **Put what varies least in the lowest bind group index** (group 0: per
  frame; group 1: per material; group 2: per object).
- **Indirect draws** when the counts come from the GPU.
- Record the frame in **one command encoder** and submit once.

## Passes

- **Few passes.** Each render pass has a fixed cost, and on tile-based GPUs
  (phones, tablets, Apple silicon) a large one: every attachment is loaded
  into tile memory at the start and stored at the end.
- **`loadOp: 'clear'` instead of `'load'`** whenever the previous contents are
  not needed — a load reads the whole attachment back.
- **`storeOp: 'discard'`** for depth, stencil and multisampled attachments
  that nothing reads afterwards.
- **Do not alternate targets** (A, B, A, B). Finish everything that goes to
  one target before moving to the next: each switch ends a pass and starts
  another.
- A full-screen pass that only copies or blends is still a full-screen cost.
  Fold it into the pass before or after when the result is the same.

## Fill rate

Fragment cost × pixels covered × times covered. Usually the real limit.

- **Tight geometry.** A full-screen quad that discards most of its pixels
  still runs the fragment shader on all of them. Bound each element with a
  quad or polygon that fits it.
- **Scissor** (`setScissorRect`) to the region that changes.
- **Overdraw:** opaque geometry front to back with a depth test rejects
  hidden fragments before they are shaded. Blended geometry cannot be
  rejected that way — every layer is shaded — so keep blended layers few and
  their areas small.
- **`discard` and writing depth from the fragment shader** turn off early
  depth rejection for that pipeline.
- **Device pixel ratio** multiplies everything here by its square, and
  multisampling multiplies the attachment's memory and resolve cost by its
  sample count. Both are choices to measure, not defaults to inherit.
- **Render at a lower resolution** what is blurred or soft anyway.

## Shaders

- **Per vertex or per instance, not per fragment,** for anything that is the
  same across the primitive; pass it with `@interpolate(flat)`.
- **Texture samples are the expensive operation.** Count them per fragment.
  `textureLoad` (no filtering) where no filtering is wanted.
- **Loops with a small fixed bound.** A loop whose bound comes from data runs
  at its worst case on some drivers.
- **Branches on uniform or per-instance values are cheap;** branches on
  values computed per fragment may run both sides.
- **Derivatives (`dpdx`, `fwidth`) need uniform control flow:** compute them
  before branching.
- **Precision is in the maths, not only the format:** `f32` loses accuracy on
  large coordinates and nearly-cancelling differences. A solve that is exact
  on paper may need a different form to be stable in `f32`.

## Textures and formats

- **The smallest format that holds the data.** `r8unorm` for a mask instead of
  `rgba8unorm`; `rgba16float` costs twice the memory and bandwidth of
  `rgba8unorm`, `rgba32float` four times, and float formats may not be
  filterable or blendable without a feature.
- **Mipmaps** for textures drawn smaller than they are: fewer cache misses
  and no aliasing.
- **Atlases or array textures** let different images share one bind group and
  one draw.

## Lifetime

- **The garbage collector does not free GPU memory in time.** A texture or
  buffer no longer used is released with `destroy()`, when it is replaced —
  not left for the collector, which knows nothing of how large it is.
- **Create and upload ahead of the first draw.** A pipeline compiled or a
  texture uploaded the first time it is drawn stalls that one frame — a
  freeze that happens once and never again. Do it at start-up or behind a
  loading step.
- **Spread bulk work over frames.** Creating, uploading or destroying
  hundreds of resources in one frame is a hitch; a few per frame is not.
- **Bound every cache** (pipelines, bind groups, cached layers, glyphs) and
  evict; one that only grows is a leak with a delay.

## Limits and features

- **Read the limits, do not assume them:** `device.limits`
  (`maxTextureDimension2D` before rendering anything into a cached texture,
  `maxBindGroups`, buffer sizes). Request a higher limit only when it is
  needed, and only after checking the adapter offers it — asking for the
  most hides that the code will not run on a weaker GPU.
- **Check a feature before relying on it** (`float32-filterable`,
  `float32-blendable`, `timestamp-query`, `shader-f16`, the texture
  compression formats) and keep a path for when it is absent.
- **Know which adapter was given.** A fallback or software adapter runs the
  same code many times slower; "slow only on that machine" is often this.
  Show the adapter's description on the measuring page.
- **Listen for `device.lost`.** It follows driver trouble and memory
  pressure, and a shader or compute step that runs for seconds can trigger
  it by itself.

## Readback

- **`mapAsync` resolves a frame or more later.** Never `await` it in the
  frame path; issue it, carry on, and use the result when it arrives — the
  value read is at least one frame old by design.
- **Do not read the canvas back** to make a decision the CPU could make from
  the data it already has.

## Validation and errors

- Listen for `uncapturederror` on the device and surface it; a validation
  error silently skips the draw and looks like a performance or logic bug.
- `pushErrorScope` / `popErrorScope` are for debugging and tests, not for the
  frame path.

## Timing

`queue.submit` returns immediately: the work has only been queued. Timing
around it, or around the encoder, measures the cost of *recording* commands.
See [measuring.md](measuring.md) § Timing the GPU.

## Checking the specification

Limits, built-in signatures and validation rules are in the specifications,
not in memory: `scripts/fetch-specs.sh` downloads both, then search them.
