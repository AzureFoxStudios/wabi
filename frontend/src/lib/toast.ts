/**
 * Toasts (design contract §7.14): an inverse one-line note with at most one action ("Undo"),
 * bottom-center 16px above the composer or the phone nav, 5 s, paused while the pointer or
 * focus is on it, announced through a role=status live region (errors through role=alert).
 *
 *   toast('Link to message copied');
 *   toast('Message deleted', { action: 'Undo', onAction: restore });
 *
 * The first call lazily mounts `components/ui/Toast.svelte` into document.body with Svelte's
 * `mount()`, so no layout has to host it. Its clock is held until the host is on screen, so
 * the first toast of a session gets its full time. While a native modal dialog (or a
 * fullscreen element) is open, the host moves into it: everything outside a modal paints
 * under its backdrop and is inert, so a toast left in body could be neither read nor pressed.
 * Where the popover API exists the host is a manual popover, so it is in the top layer above
 * the dialog. Without a DOM (tests, SSR) the queue still runs and nothing is mounted.
 *
 * Queue rules: one toast shows at a time and the rest wait in order. A newer toast never waits
 * long: once the visible one has been readable for MIN_VISIBLE_MS it steps aside, unless the
 * pointer or focus is on it, in which case the queue waits for the person. Repeating the
 * message that is already showing or waiting restarts that toast instead of stacking a copy;
 * an action toast is only merged when it would run the same callback, so each "Undo" keeps
 * undoing its own change.
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
	/** Keep the clock stopped until release(): the host is not on screen yet. */
	hold(): void;
	/** The host shows toasts now: the visible one starts its time from here. */
	release(): void;
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
	/** Its clock has started (it has been on screen); false while the queue is held. */
	started: boolean;
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
	let held = false;

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
		if (!current || !current.started || current.leaving || !queued.length || current.pausedBy.size) return;
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

	/** The visible toast is on screen from now: start its time. */
	function start(entry: Entry) {
		entry.started = true;
		entry.shownAt = clock.now();
		if (!entry.pausedBy.size) startTimer(entry);
		scheduleStepAside();
	}

	function showNext() {
		if (current || !queued.length) return;
		const next = queued.shift()!;
		current = next;
		if (!held) start(next);
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
		// An action toast only merges when it would run the same callback; two "Message deleted ·
		// Undo" toasts for different messages stay two toasts, each undoing its own message.
		const same = [current, ...queued].find(
			(entry) =>
				entry &&
				!entry.leaving &&
				entry.message === text &&
				entry.action === action &&
				entry.tone === tone &&
				(!action || entry.onAction === options.onAction)
		) as Entry | undefined;
		if (same) {
			same.timeout = timeout;
			same.remaining = timeout;
			if (same === current && same.started && !same.pausedBy.size) startTimer(same);
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
			started: false,
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
		if (!current.pausedBy.delete(reason) || current.pausedBy.size || !current.started) return;
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

	function hold() {
		held = true;
	}

	function release() {
		if (!held) return;
		held = false;
		if (current && !current.started && !current.leaving) start(current);
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

	return { subscribe: store.subscribe, push, dismiss, act, pause, resume, hold, release, clear, snapshot };
}

/** The app's queue, rendered by components/ui/Toast.svelte. */
export const toasts: ToastQueue = createToastQueue();

let host: Promise<void> | null = null;
/** The element the host is mounted into. It moves between body and open modal layers. */
let hostElement: HTMLElement | null = null;
/** Open modal dialogs in the order they opened; the last one is on top. */
const openModals: HTMLElement[] = [];
let watchingLayers = false;
let layerCheck: ReturnType<typeof setInterval> | null = null;

/** Elements whose children are not rendered, so they cannot hold the host. */
const REPLACED = /^(AUDIO|CANVAS|EMBED|IFRAME|IMG|OBJECT|PICTURE|VIDEO)$/;

function isOpenModal(element: Element): element is HTMLDialogElement {
	if (!(element instanceof HTMLDialogElement) || !element.open || !element.isConnected) return false;
	try {
		return element.matches(':modal');
	} catch {
		return true;
	}
}

/**
 * Where the host has to live right now: the top-most open modal dialog, or the fullscreen
 * element when it covers that dialog, else document.body.
 */
function toastLayer(): HTMLElement {
	while (openModals.length && !isOpenModal(openModals[openModals.length - 1])) openModals.pop();
	let modal: HTMLElement | null = openModals[openModals.length - 1] ?? null;
	if (!modal) {
		// Opened before the host existed: the last one in document order is usually on top.
		for (const dialog of document.querySelectorAll('dialog[open]')) if (isOpenModal(dialog)) modal = dialog;
	}
	const fullscreen = document.fullscreenElement;
	if (fullscreen instanceof HTMLElement && !REPLACED.test(fullscreen.tagName)) {
		if (!modal || (modal !== fullscreen && modal.contains(fullscreen))) return fullscreen;
	}
	return modal ?? document.body;
}

/** Put the host in the current layer and (re)show it there as a top-layer popover. */
function relocate(): void {
	const element = hostElement;
	if (!element || typeof document === 'undefined' || !document.body) return;
	const layer = toastLayer();
	if (element.parentNode !== layer) layer.appendChild(element);
	if (element.hasAttribute('popover')) {
		try {
			if (!element.matches(':popover-open')) element.showPopover();
		} catch {
			// No top layer here: stay a plain fixed layer (Toast.svelte keeps it displayed).
			element.removeAttribute('popover');
		}
	}
	// Inside a dialog, notice soon when it goes away: closed, or removed with its subtree.
	if (layer !== document.body && layerCheck === null) {
		layerCheck = setInterval(() => {
			if (!hostElement?.isConnected || hostElement.parentNode !== toastLayer()) relocate();
		}, 250);
	} else if (layer === document.body && layerCheck !== null) {
		clearInterval(layerCheck);
		layerCheck = null;
	}
}

/** Follow modal dialogs and fullscreen as they open and close. */
function watchLayers(): void {
	if (watchingLayers || typeof MutationObserver === 'undefined') return;
	watchingLayers = true;
	new MutationObserver((records) => {
		for (const { target } of records) {
			if (!(target instanceof HTMLDialogElement)) continue;
			const index = openModals.indexOf(target);
			if (index >= 0) openModals.splice(index, 1);
			if (isOpenModal(target)) openModals.push(target);
		}
		relocate();
	}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
	document.addEventListener('fullscreenchange', relocate);
}

/** Mount the toast host once, the first time a toast is shown in a browser. */
function ensureHost(): void {
	if (host || typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
	// The first toast's time starts when the host is on screen, not while it is still loading.
	toasts.hold();
	host = Promise.all([import('svelte'), import('./components/ui/Toast.svelte')])
		.then(([{ mount }, { default: Toast }]) => {
			const target = document.createElement('div');
			target.setAttribute('data-wabi-toasts', '');
			if ('showPopover' in target) target.setAttribute('popover', 'manual');
			hostElement = target;
			relocate();
			watchLayers();
			mount(Toast, { target, props: { queue: toasts } });
		})
		.catch((error) => {
			host = null;
			hostElement?.remove();
			hostElement = null;
			toasts.release();
			console.error('[toast] could not mount the toast host', error);
		});
}

// Warm the host once the page is idle, so the first toast of a session does not wait for the
// host to load. Browsers only; tests and SSR have no document.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	const warm = () => ensureHost();
	if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm, { timeout: 4000 });
	else setTimeout(warm, 1500);
}

/** Show a toast. Returns a handle so the caller can close it early. */
export function toast(message: string, options: ToastOptions = {}): ToastHandle {
	ensureHost();
	// A toast fired from inside a dialog shows inside it, above its backdrop.
	relocate();
	return toasts.push(message, options);
}

/**
 * Compatibility entry point used across the app before the toast kit existed. Same queue and
 * same look; the tone keeps errors assertive. New code calls `toast()`.
 */
export function showToast(message: string, type: ToastTone = 'error', duration = 6000): void {
	toast(message, { tone: type, timeout: duration });
}
