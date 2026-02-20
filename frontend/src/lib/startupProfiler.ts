import { browser } from '$app/environment';

const PREFIX = 'wabi:start:';
const FLAG_KEY = 'wabi_startup_profiler';

let cachedEnabled: boolean | null = null;
let reportScheduled = false;

function isEnabled(): boolean {
	if (!browser || typeof performance === 'undefined') return false;
	if (cachedEnabled !== null) return cachedEnabled;
	let localFlag = false;
	try {
		localFlag = localStorage.getItem(FLAG_KEY) === 'true';
	} catch {
		localFlag = false;
	}
	cachedEnabled = Boolean(import.meta.env.DEV || localFlag);
	return cachedEnabled;
}

function withPrefix(name: string): string {
	return `${PREFIX}${name}`;
}

export function startupMark(name: string): void {
	if (!isEnabled()) return;
	try {
		performance.mark(withPrefix(name));
	} catch {
		// Ignore unsupported/invalid marks.
	}
}

export function startupMeasure(name: string, start: string, end: string): void {
	if (!isEnabled()) return;
	try {
		performance.measure(withPrefix(name), withPrefix(start), withPrefix(end));
	} catch {
		// Ignore missing marks.
	}
}

function collectMeasures(): { name: string; durationMs: number; startMs: number }[] {
	return performance
		.getEntriesByType('measure')
		.filter((entry) => entry.name.startsWith(PREFIX))
		.map((entry) => ({
			name: entry.name.replace(PREFIX, ''),
			durationMs: Math.round(entry.duration * 100) / 100,
			startMs: Math.round(entry.startTime * 100) / 100
		}))
		.sort((a, b) => a.startMs - b.startMs);
}

export function startupReport(label = 'startup'): void {
	if (!isEnabled()) return;
	const rows = collectMeasures();
	if (rows.length === 0) return;

	console.groupCollapsed(`[StartupProfile] ${label}`);
	console.table(rows);
	console.groupEnd();
}

export function startupScheduleReport(label = 'startup', delayMs = 0): void {
	if (!isEnabled() || reportScheduled) return;
	reportScheduled = true;
	setTimeout(() => {
		startupReport(label);
		reportScheduled = false;
	}, delayMs);
}

