import type { RuntimeGuardrailsSnapshot } from '../../../shared/runtimeAdminContracts.js';

let heavyProfilingEnabled = false;
let eventLoopHistogram: {
	percentile: (p: number) => number;
	max: number;
	enable: () => void;
	reset: () => void;
} | null = null;

const cpuBaseline = process.cpuUsage();

export async function initRuntimeGuardrails(options: { heavyProfilingEnabled: boolean }): Promise<void> {
	heavyProfilingEnabled = Boolean(options.heavyProfilingEnabled);
	if (!heavyProfilingEnabled) return;

	try {
		const perfHooks = await import('node:perf_hooks');
		eventLoopHistogram = perfHooks.monitorEventLoopDelay({ resolution: 20 }) as unknown as {
			percentile: (p: number) => number;
			max: number;
			enable: () => void;
			reset: () => void;
		};
		eventLoopHistogram.enable();
	} catch (error) {
		console.warn('[RuntimeGuardrails] Heavy profiling could not be initialized:', error);
		heavyProfilingEnabled = false;
		eventLoopHistogram = null;
	}
}

export function getRuntimeGuardrailsSnapshot(): RuntimeGuardrailsSnapshot {
	const memory = process.memoryUsage();
	const cpu = process.cpuUsage(cpuBaseline);

	let eventLoopDelayP95Ms: number | null = null;
	let eventLoopDelayMaxMs: number | null = null;
	if (heavyProfilingEnabled && eventLoopHistogram) {
		// monitorEventLoopDelay values are nanoseconds.
		eventLoopDelayP95Ms = eventLoopHistogram.percentile(95) / 1_000_000;
		eventLoopDelayMaxMs = eventLoopHistogram.max / 1_000_000;
		eventLoopHistogram.reset();
	}

	return {
		uptimeSeconds: process.uptime(),
		memory: {
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
			externalBytes: memory.external,
			arrayBuffersBytes: memory.arrayBuffers
		},
		cpu: {
			userMicros: cpu.user,
			systemMicros: cpu.system
		},
		heavyProfiling: {
			enabled: heavyProfilingEnabled,
			eventLoopDelayP95Ms,
			eventLoopDelayMaxMs
		}
	};
}
