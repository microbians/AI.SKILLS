// gfx-perf — a measuring harness for a page with a Run button.
//
// Times frames in a plain loop (never inside requestAnimationFrame, which is
// clamped to the display's refresh), after a warm-up, waiting for the GPU
// where there is one, and reports the median. Variants are interleaved, so
// none is measured on a warmer JIT or GPU than the others.
//
//   const results = await compare({
//     'baseline': () => renderA(),
//     'candidate': () => renderB(),
//   }, { settle: () => device.queue.onSubmittedWorkDone() });
//   // → { baseline: { median, p95, min, max, samples }, candidate: { … } }
//
// frame: draws one frame (may be async). settle: resolves when that frame's
// work is really done — WebGPU: () => device.queue.onSubmittedWorkDone();
// Canvas2D on an accelerated canvas: () => context.getImageData(0, 0, 1, 1)
// (a measuring page only: it forces the deferred raster to finish).

const pause = () => new Promise(resolve => setTimeout(resolve, 0));

async function oneFrame(frame, settle) {
	const start = performance.now();
	await frame();
	if (settle) await settle();
	return performance.now() - start;
}

// Frames run unmeasured for warmupMs: shader and pipeline compilation,
// buffers growing, the JIT and late readbacks all land here
async function warmUp(frame, settle, warmupMs) {
	const until = performance.now() + warmupMs;
	let n = 0;
	while (performance.now() < until) {
		await oneFrame(frame, settle);
		if (++n % 30 === 0) await pause();
	}
}

function summary(times) {
	const sorted = Float64Array.from(times).sort();
	const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
	return { median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1], samples: sorted.length };
}

// One case alone: { median, p95, min, max, samples } in ms
export async function measure(frame, { settle = null, warmupMs = 2000, samples = 120 } = {}) {
	await warmUp(frame, settle, warmupMs);
	const times = new Float64Array(samples);
	for (let i = 0; i < samples; i++) {
		times[i] = await oneFrame(frame, settle);
		if (i % 30 === 29) await pause();
	}
	return summary(times);
}

// Several cases, interleaved in rounds: each round warms a case up briefly
// and takes a block of samples from it, then moves to the next. onProgress
// (name, round, rounds) lets the page show where it is
export async function compare(cases, { settle = null, warmupMs = 2000, rounds = 6, samplesPerRound = 30, onProgress = null } = {}) {
	const names = Object.keys(cases), times = {};
	for (const name of names) times[name] = [];
	for (let round = 0; round < rounds; round++) {
		for (const name of names) {
			onProgress?.(name, round, rounds);
			// (the full warm-up the first time; afterwards enough to bring the
			// case's own code and buffers back)
			await warmUp(cases[name], settle, round === 0 ? warmupMs : warmupMs / 8);
			for (let i = 0; i < samplesPerRound; i++) times[name].push(await oneFrame(cases[name], settle));
			await pause();
		}
	}
	const out = {};
	for (const name of names) out[name] = summary(times[name]);
	return out;
}

// What the numbers were measured on, for the page's table and the findings log
export function environment(canvas) {
	return {
		userAgent: navigator.userAgent,
		devicePixelRatio: window.devicePixelRatio || 1,
		canvas: canvas ? `${canvas.width} × ${canvas.height}` : null,
		visible: document.visibilityState === 'visible',
	};
}
