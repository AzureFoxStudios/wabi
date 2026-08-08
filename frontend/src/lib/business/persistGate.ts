/**
 * Lightweight gate so multi-store snapshot applies don't thrash localStorage.
 * Kept free of store imports to avoid cycles with snapshot.ts / store.ts.
 */

let depth = 0;
let onFlush: (() => void) | null = null;

export function setPersistFlush(fn: () => void): void {
	onFlush = fn;
}

export function beginBatchPersist(): void {
	depth += 1;
}

export function endBatchPersist(): void {
	depth = Math.max(0, depth - 1);
	if (depth === 0) onFlush?.();
}

export function isPersistSuppressed(): boolean {
	return depth > 0;
}
