/**
 * Toasts (design contract §7.14): an inverse one-line note with at most one action ("Undo"),
 * bottom-center 16px above the composer or the phone nav, 5 s, paused while the pointer or
 * focus is on it, announced through a role=status live region (errors through role=alert).
 *
 *   toast('Link to message copied');
 *   toast('Message deleted', { action: 'Undo', onAction: restore });
 *
 * The first call lazily mounts `components/ui/Toast.svelte` into document.body with Svelte's
 * `mount()`, so no layout has to host it. Without a DOM (tests, SSR) the queue still runs and
 * nothing is mounted.
 *
 * Queue rules: one toast shows at a time and the rest wait in order. A newer toast never waits
 * long: once the visible one has been readable for MIN_VISIBLE_MS it steps aside, unless the
 * pointer or focus is on it, in which case the queue waits for the person. Repeating the
 * message that is already showing or waiting restarts that toast instead of stacking a copy.
 */
import { writable, type Readable } from 'svelte/store';

export type ToastTone = 'info' | 'warning' | 'error';

export interface ToastOptions {
	/** Label of the single action button, e.g. "Undo". */
	action?: string;
	/** Runs when the action is pressed; the toast closes afterwards. */
	onAction?: () => void;
	/** Milliseconds before it closes on its own (default 5000, minimum 1500). */
	timeout?: number;
	/** "error" is announced assertively (role=alert) and carries an alert glyph. */
	tone?: ToastTone;
}

export interface ToastItem {
	id: number;
	message: string;
	action?: string;
	onAction?: () => void;
	timeout: number;
	tone: ToastTone;
	/** True during the short exit transition, after which the item is removed. */
	leaving: boolean;
}

export interface ToastSnapshot {
	/** The toast on screen (possibly leaving), or null. */
	current: ToastItem | null;
	/** Toasts waiting their turn, oldest first. */
	queued: ToastItem[];
}

export interface ToastHandle {
	id: number;
	dismiss(): void;
}

export type ToastPauseReason = 'hover' | 'focus';

export interface ToastClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ToastQueue extends Readable<ToastSnapshot> {
	push(message: string, options?: ToastOptions): ToastHandle;
	dismiss(id: number): void;
	/** Press the toast's action: runs onAction, then dismisses. */
	act(id: number): void;
	pause(id: number, reason: ToastPauseReason): void;
	resume(id: number, reason: ToastPauseReason): void;
	clear(): void;
	snapshot(): ToastSnapshot;
}

export const TOAST_TIMEOUT = 5000;
export const TOAST_MIN_TIMEOUT = 1500;
/** How long a toast stays readable before a newer one may replace it. */
export const TOAST_MIN_VISIBLE_MS = 1500;
/** After the pointer or focus leaves, at least this much time remains. */
export const TOAST_RESUME_GRACE_MS = 1000;
/** Matches the CSS exit (0.75 × --w-dur-2). */
export const TOAST_EXIT_MS = 140;
/** Waiting toasts beyond this are dropped, oldest action-less ones first. */
export const TOAST_MAX_QUEUED = 4;

const realClock: ToastClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

interface Entry extends ToastItem {
	shownAt: number;
	remaining: number;
	timerStartedAt: number;
	timer: unknown;
	pausedBy: Set<ToastPauseReason>;
}

export function createToastQueue(clock: ToastClock = realClock): ToastQueue {
	let nextId = 1;
	let current: Entry | null = null;
	const queued: Entry[] = [];
	let removeTimer: unknown = null;
	let stepAsideTimer: unknown = null;

	const view = (entry: Entry): ToastItem => ({
		id: entry.id,
		message: entry.message,
		action: entry.action,
		onAction: entry.onAction,
		timeout: entry.timeout,
		tone: entry.tone,
		leaving: entry.leaving
	});
	const snapshot = (): ToastSnapshot => ({ current: current ? view(current) : null, queued: queued.map(view) });
	const store = writable<ToastSnapshot>(snapshot());
	const publish = () => store.set(snapshot());

	function stopTimer(entry: Entry) {
		if (entry.timer !== null) clock.clearTimeout(entry.timer);
		entry.timer = null;
	}

	function startTimer(entry: Entry) {
		stopTimer(entry);
		entry.timerStartedAt = clock.now();
		entry.timer = clock.setTimeout(() => {
			entry.timer = null;
			dismiss(entry.id);
		}, entry.remaining);
	}

	function clearStepAside() {
		if (stepAsideTimer !== null) clock.clearTimeout(stepAsideTimer);
		stepAsideTimer = null;
	}

	/** A toast is waiting: let the visible one go once it has been readable long enough. */
	function scheduleStepAside() {
		clearStepAside();
		if (!current || current.leaving || !queued.length || current.pausedBy.size) return;
		const wait = Math.max(0, current.shownAt + TOAST_MIN_VISIBLE_MS - clock.now());
		if (wait === 0) {
			dismiss(current.id);
			return;
		}
		const id = current.id;
		stepAsideTimer = clock.setTimeout(() => {
			stepAsideTimer = null;
			if (current?.id === id && !current.pausedBy.size) dismiss(id);
		}, wait);
	}

	function showNext() {
		if (current || !queued.length) return;
		const next = queued.shift()!;
		next.shownAt = clock.now();
		current = next;
		startTimer(next);
		scheduleStepAside();
	}

	function finishLeaving() {
		removeTimer = null;
		current = null;
		showNext();
		publish();
	}

	function dismiss(id: number) {
		const waiting = queued.findIndex((entry) => entry.id === id);
		if (waiting >= 0) {
			queued.splice(waiting, 1);
			publish();
			return;
		}
		if (!current || current.id !== id || current.leaving) return;
		stopTimer(current);
		clearStepAside();
		current.leaving = true;
		removeTimer = clock.setTimeout(finishLeaving, TOAST_EXIT_MS);
		publish();
	}

	function find(id: number): Entry | undefined {
		if (current?.id === id) return current;
		return queued.find((entry) => entry.id === id);
	}

	function push(message: string, options: ToastOptions = {}): ToastHandle {
		const text = String(message ?? '').trim();
		const timeout = Math.max(TOAST_MIN_TIMEOUT, Number.isFinite(options.timeout) ? Number(options.timeout) : TOAST_TIMEOUT);
		const tone: ToastTone = options.tone ?? 'info';
		const action = options.action?.trim() || undefined;

		// The same words are already showing or waiting: restart that toast instead of stacking.
		const same = [current, ...queued].find(
			(entry) => entry && !entry.leaving && entry.message === text && entry.action === action && entry.tone === tone
		) as Entry | undefined;
		if (same) {
			same.onAction = options.onAction ?? same.onAction;
			same.timeout = timeout;
			same.remaining = timeout;
			if (same === current && !same.pausedBy.size) startTimer(same);
			publish();
			return { id: same.id, dismiss: () => dismiss(same.id) };
		}

		const entry: Entry = {
			id: nextId++,
			message: text,
			action,
			onAction: options.onAction,
			timeout,
			tone,
			leaving: false,
			shownAt: 0,
			remaining: timeout,
			timerStartedAt: 0,
			timer: null,
			pausedBy: new Set()
		};
		queued.push(entry);
		while (queued.length > TOAST_MAX_QUEUED) {
			const drop = queued.findIndex((waiting) => !waiting.action);
			queued.splice(drop >= 0 ? drop : 0, 1);
		}
		if (!current) showNext();
		else scheduleStepAside();
		publish();
		return { id: entry.id, dismiss: () => dismiss(entry.id) };
	}

	function act(id: number) {
		const entry = find(id);
		if (!entry || entry.leaving) return;
		try {
			entry.onAction?.();
		} finally {
			dismiss(id);
		}
	}

	function pause(id: number, reason: ToastPauseReason) {
		if (!current || current.id !== id || current.leaving) return;
		const wasRunning = current.pausedBy.size === 0;
		current.pausedBy.add(reason);
		if (wasRunning && current.timer !== null) {
			current.remaining = Math.max(0, current.remaining - (clock.now() - current.timerStartedAt));
			stopTimer(current);
		}
		clearStepAside();
	}

	function resume(id: number, reason: ToastPauseReason) {
		if (!current || current.id !== id || current.leaving) return;
		if (!current.pausedBy.delete(reason) || current.pausedBy.size) return;
		current.remaining = Math.max(current.remaining, TOAST_RESUME_GRACE_MS);
		startTimer(current);
		if (queued.length) {
			// Someone is waiting: give the person the grace period, then step aside.
			clearStepAside();
			const leavingId = current.id;
			stepAsideTimer = clock.setTimeout(() => {
				stepAsideTimer = null;
				if (current?.id === leavingId && !current.pausedBy.size) dismiss(leavingId);
			}, TOAST_RESUME_GRACE_MS);
		}
	}

	function clear() {
		if (current) stopTimer(current);
		clearStepAside();
		if (removeTimer !== null) clock.clearTimeout(removeTimer);
		removeTimer = null;
		current = null;
		queued.length = 0;
		publish();
	}

	return { subscribe: store.subscribe, push, dismiss, act, pause, resume, clear, snapshot };
}

/** The app's queue, rendered by components/ui/Toast.svelte. */
export const toasts: ToastQueue = createToastQueue();

let host: Promise<void> | null = null;

/** Mount the toast host once, the first time a toast is shown in a browser. */
function ensureHost(): void {
	if (host || typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
	host = Promise.all([import('svelte'), import('./components/ui/Toast.svelte')])
		.then(([{ mount }, { default: Toast }]) => {
			const target = document.createElement('div');
			target.setAttribute('data-wabi-toasts', '');
			document.body.appendChild(target);
			mount(Toast, { target, props: { queue: toasts } });
		})
		.catch((error) => {
			host = null;
			console.error('[toast] could not mount the toast host', error);
		});
}

/** Show a toast. Returns a handle so the caller can close it early. */
export function toast(message: string, options: ToastOptions = {}): ToastHandle {
	ensureHost();
	return toasts.push(message, options);
}

/**
 * Compatibility entry point used across the app before the toast kit existed. Same queue and
 * same look; the tone keeps errors assertive. New code calls `toast()`.
 */
export function showToast(message: string, type: ToastTone = 'error', duration = 6000): void {
	toast(message, { tone: type, timeout: duration });
}
