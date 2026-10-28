# GFXPerf

A skill for AI agents doing performance work on graphics code in the browser:
JavaScript hot loops, Canvas2D and WebGPU. It loads as `gfx-perf`.

## What is it

A method and a set of rules, not a tool. It makes the agent do three things
it otherwise skips:

1. **Measure properly before and after** — in a real browser on the real
   display, after a warm-up, in a plain loop, reporting the median, with the
   variants interleaved.
2. **Find the slow layer first** — script, garbage collection, state changes,
   fill rate or the GPU — instead of optimizing whatever looks slow.
3. **Write the result down**, including what was tried and dropped.

Under those it carries the rules for each layer: allocation-free JavaScript,
Canvas2D state and pixels, and WebGPU objects, uploads, draw calls, passes and
shaders.

It is deliberately general. It names no library and assumes no framework: the
rules hold for any code that draws many things per frame.

## What it covers

| Layer | Reference | The headline |
|-------|-----------|--------------|
| Method | [`skill/SKILL.md`](skill/SKILL.md) | Reproduce and count → baseline → locate → change one thing → measure interleaved → keep or delete → write down |
| JavaScript | [`skill/references/javascript.md`](skill/references/javascript.md) | Allocate nothing per frame: create arrays and objects once and reuse them. Do less before doing it faster |
| Canvas2D | [`skill/references/canvas2d.md`](skill/references/canvas2d.md) | Group by style, one path for many shapes, cache static layers, never read pixels back in the frame |
| WebGPU | [`skill/references/webgpu.md`](skill/references/webgpu.md) | Create pipelines, bind groups and buffers once; one upload per buffer; few draws and passes; fragments are the bill |
| Measuring | [`skill/references/measuring.md`](skill/references/measuring.md) | Never headless, never inside `requestAnimationFrame`; warm up, median, interleave, show it on the page |

The first JavaScript rule comes from a canvas renderer whose loop rebuilt its
working arrays on every pass. Creating them once and reusing them was the
largest single gain that loop ever had — the engine stops allocating and the
garbage collector stops interrupting. It is the first thing the skill checks.

## What is in the box

| Path | What it is |
|------|------------|
| `skill/SKILL.md` | The skill: the loop, the symptom → cause guide, the rules by layer |
| `skill/references/` | The four references above, loaded when their layer is the one in question |
| `skill/templates/measure.js` | A measuring harness for a page with a Run button: warm-up, plain loop, wait for the GPU, median, interleaved comparison |
| `skill/templates/findings.md` | The findings log's format: question, cases, numbers, what it ran on, decision |
| `skill/scripts/fetch-specs.sh` | Downloads the WebGPU and WGSL specifications for local search |
| `src/claude-md-snippet.md` | The section the installer adds to `CLAUDE.md` so the skill is used without being asked for |
| `install.sh` | The installer |

## Install

```bash
# For every project (~/.claude)
./install.sh

# For one project (run from the project's folder)
/path/to/AI.SKILLS/skills/gfx-perf/install.sh --project

# The skill alone, leaving CLAUDE.md as it is
/path/to/AI.SKILLS/skills/gfx-perf/install.sh --project --skill-only

# Remove
./install.sh --uninstall
```

The installer copies `skill/` to `<base>/skills/gfx-perf/` and adds a short
"Graphics performance" section to `<base>/CLAUDE.md`. Re-running it upgrades
in place. The version is read from the skill's own frontmatter.

To install by hand, copy the `skill/` folder to `.claude/skills/gfx-perf/`.

## Using it

The agent invokes the skill when the work is performance work on graphics
code. To call it yourself:

```
/gfx-perf
```

### The measuring harness

Copy `templates/measure.js` next to the page that measures, and start it from
a button:

```js
import { compare, environment } from './measure.js';

runButton.addEventListener('click', async () => {
	const results = await compare({
		baseline: () => renderA(),
		candidate: () => renderB(),
	}, { settle: () => device.queue.onSubmittedWorkDone() });
	show(results, environment(canvas));   // on the page, not only in the console
});
```

`settle` is what makes the time include the GPU: `queue.submit` returns as
soon as the work is queued.

### The specifications

```bash
sh ~/.claude/skills/gfx-perf/scripts/fetch-specs.sh
grep -n "maxColorAttachments" ~/.cache/gfx-perf/specs/webgpu.bs
```

Downloaded from the `gpuweb/gpuweb` repository, kept in
`~/.cache/gfx-perf/specs/` (override with `GFX_PERF_SPECS`), refreshed when
older than 30 days or with `--force`.

### The findings log

Copy `templates/findings.md` into the project (for example
`docs/perf-findings.md`) and add an entry for every measurement that changed
a decision — the dropped ideas included.

## What it is not

- Not for page-load performance (bundle size, Core Web Vitals, Lighthouse).
- Not for server performance.
- Not tied to any rendering library; a library's own guide comes first for
  that library's API.

## License

MIT
