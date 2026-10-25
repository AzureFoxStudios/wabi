import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { get } from 'svelte/store';
import {
	createToastQueue,
	showToast,
	toast,
	toasts,
	TOAST_EXIT_MS,
	TOAST_MAX_QUEUED,
	TOAST_MIN_TIMEOUT,
	TOAST_MIN_VISIBLE_MS,
	TOAST_RESUME_GRACE_MS,
	TOAST_TIMEOUT,
	type ToastClock
} from './toast';

/** A manual clock: timers fire only when the test advances time. */
function fakeClock() {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const clock: ToastClock = {
		now: () => now,
		setTimeout(callback, ms) {
			const id = ++seq;
			timers.set(id, { at: now + Math.max(0, ms), callback });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		}
	};
	function advance(ms: number) {
		const end = now + ms;
		for (;;) {
			let nextId = 0;
			let next: { at: number; callback: () => void } | undefined;
			for (const [id, timer] of timers) {
				if (timer.at <= end && (!next || timer.at < next.at || (timer.at === next.at && id < nextId))) {
					next = timer;
					nextId = id;
				}
			}
			if (!next) break;
			timers.delete(nextId);
			now = next.at;
			next.callback();
		}
		now = end;
	}
	return { clock, advance, pending: () => timers.size };
}

function setup() {
	const time = fakeClock();
	const queue = createToastQueue(time.clock);
	const shown = () => queue.snapshot().current;
	const waiting = () => queue.snapshot().queued.map((item) => item.message);
	return { ...time, queue, shown, waiting };
}

describe('toast queue', () => {
	test('shows a toast at once and closes it after 5 s, with an exit step', () => {
		const { queue, shown, advance, pending } = setup();
		const handle = queue.push('Link to message copied');
		expect(shown()?.message).toBe('Link to message copied');
		expect(shown()?.timeout).toBe(TOAST_TIMEOUT);
		expect(shown()?.tone).toBe('info');
		expect(handle.id).toBe(shown()!.id);

		advance(TOAST_TIMEOUT - 1);
		expect(shown()?.leaving).toBe(false);
		advance(1);
		expect(shown()?.leaving).toBe(true);
		advance(TOAST_EXIT_MS);
		expect(shown()).toBeNull();
		expect(pending()).toBe(0);
	});

	test('queues in order, one at a time, and a waiting toast replaces the visible one once it was readable', () => {
		const { queue, shown, waiting, advance } = setup();
		queue.push('First');
		queue.push('Second');
		queue.push('Third');
		expect(shown()?.message).toBe('First');
		expect(waiting()).toEqual(['Second', 'Third']);

		advance(TOAST_MIN_VISIBLE_MS);
		expect(shown()?.leaving).toBe(true);
		advance(TOAST_EXIT_MS);
		expect(shown()?.message).toBe('Second');
		expect(waiting()).toEqual(['Third']);

		advance(TOAST_MIN_VISIBLE_MS + TOAST_EXIT_MS);
		expect(shown()?.message).toBe('Third');
		expect(waiting()).toEqual([]);

		// Nothing waits any more, so the last one gets its full time.
		advance(TOAST_TIMEOUT - TOAST_MIN_VISIBLE_MS - 1);
		expect(shown()?.leaving).toBe(false);
		advance(TOAST_MIN_VISIBLE_MS + 1 + TOAST_EXIT_MS);
		expect(shown()).toBeNull();
	});

	test('a toast pushed after the visible one was readable replaces it without waiting', () => {
		const { queue, shown, advance } = setup();
		queue.push('Saved');
		advance(TOAST_MIN_VISIBLE_MS + 200);
		queue.push('Message deleted', { action: 'Undo' });
		expect(shown()?.message).toBe('Saved');
		expect(shown()?.leaving).toBe(true);
		advance(TOAST_EXIT_MS);
		expect(shown()?.message).toBe('Message deleted');
		expect(shown()?.action).toBe('Undo');
	});

	test('repeating a message restarts it instead of stacking a copy', () => {
		const { queue, shown, waiting, advance } = setup();
		const first = queue.push('Reconnecting');
		advance(4000);
		const again = queue.push('Reconnecting');
		expect(again.id).toBe(first.id);
		expect(waiting()).toEqual([]);
		advance(4000);
		expect(shown()?.leaving).toBe(false);
		advance(1000);
		expect(shown()?.leaving).toBe(true);
	});

	test('an action toast only merges with one that runs the same callback', () => {
		const { queue, shown, waiting, advance } = setup();
		const undone: string[] = [];
		const restoreA = () => undone.push('a');
		const first = queue.push('Message deleted', { action: 'Undo', onAction: restoreA });
		const second = queue.push('Message deleted', { action: 'Undo', onAction: () => undone.push('b') });
		expect(second.id).not.toBe(first.id);
		expect(waiting()).toEqual(['Message deleted']);
		// The same callback again is the same change: restart, do not stack.
		expect(queue.push('Message deleted', { action: 'Undo', onAction: restoreA }).id).toBe(first.id);

		queue.act(first.id);
		advance(TOAST_EXIT_MS);
		expect(shown()?.id).toBe(second.id);
		queue.act(second.id);
		expect(undone).toEqual(['a', 'b']);
	});

	test('held until the host is on screen: the first toast gets its full time from release', () => {
		const { queue, shown, waiting, advance } = setup();
		queue.hold();
		queue.push('One');
		queue.push('Two');
		expect(shown()?.message).toBe('One');
		// The host is still loading (or the tab is hidden): nothing runs down.
		advance(60_000);
		expect(shown()?.message).toBe('One');
		expect(shown()?.leaving).toBe(false);
		expect(waiting()).toEqual(['Two']);

		queue.release();
		// Readable for the full minimum before the waiting one may replace it.
		advance(TOAST_MIN_VISIBLE_MS - 1);
		expect(shown()?.leaving).toBe(false);
		advance(1);
		expect(shown()?.leaving).toBe(true);
		advance(TOAST_EXIT_MS);
		expect(shown()?.message).toBe('Two');
		advance(TOAST_TIMEOUT - 1);
		expect(shown()?.leaving).toBe(false);
		advance(1);
		expect(shown()?.leaving).toBe(true);

		// Releasing again, or with nothing showing, changes nothing.
		queue.release();
		advance(TOAST_EXIT_MS);
		expect(shown()).toBeNull();
	});

	test('a toast repeated while held does not start its clock early', () => {
		const { queue, shown, advance } = setup();
		queue.hold();
		const handle = queue.push('Reconnecting');
		expect(queue.push('Reconnecting').id).toBe(handle.id);
		advance(60_000);
		expect(shown()?.leaving).toBe(false);
		queue.release();
		advance(TOAST_TIMEOUT);
		expect(shown()?.leaving).toBe(true);
	});

	test('dismiss closes the visible toast, or drops a waiting one silently', () => {
		const { queue, shown, waiting, advance } = setup();
		const a = queue.push('A');
		const b = queue.push('B');
		queue.push('C');
		b.dismiss();
		expect(waiting()).toEqual(['C']);
		a.dismiss();
		expect(shown()?.leaving).toBe(true);
		a.dismiss(); // a second dismiss while leaving is a no-op
		advance(TOAST_EXIT_MS);
		expect(shown()?.message).toBe('C');
	});

	test('the action runs once and closes the toast', () => {
		const { queue, shown, advance } = setup();
		let undone = 0;
		const handle = queue.push('Message deleted', { action: 'Undo', onAction: () => undone++ });
		queue.act(handle.id);
		queue.act(handle.id);
		expect(undone).toBe(1);
		expect(shown()?.leaving).toBe(true);
		advance(TOAST_EXIT_MS);
		expect(shown()).toBeNull();
	});

	test('hover and focus pause the timer; it resumes with the time left, never less than a grace', () => {
		const { queue, shown, advance } = setup();
		const { id } = queue.push('Copied');
		advance(1000);
		queue.pause(id, 'hover');
		queue.pause(id, 'focus');
		advance(60_000);
		expect(shown()?.leaving).toBe(false);

		queue.resume(id, 'hover');
		advance(60_000);
		expect(shown()?.leaving).toBe(false); // focus still holds it

		queue.resume(id, 'focus');
		advance(TOAST_TIMEOUT - 1000 - 1);
		expect(shown()?.leaving).toBe(false);
		advance(1);
		expect(shown()?.leaving).toBe(true);

		// Paused with almost nothing left: the person still gets the grace period.
		const late = setup();
		const second = late.queue.push('Almost gone');
		late.advance(TOAST_TIMEOUT - 50);
		late.queue.pause(second.id, 'hover');
		late.queue.resume(second.id, 'hover');
		late.advance(TOAST_RESUME_GRACE_MS - 1);
		expect(late.shown()?.leaving).toBe(false);
		late.advance(1);
		expect(late.shown()?.leaving).toBe(true);
	});

	test('a paused toast is not replaced by a newer one until the person lets go', () => {
		const { queue, shown, advance } = setup();
		const { id } = queue.push('Message deleted', { action: 'Undo' });
		queue.pause(id, 'hover');
		queue.push('Link copied');
		advance(30_000);
		expect(shown()?.message).toBe('Message deleted');
		expect(shown()?.leaving).toBe(false);

		queue.resume(id, 'hover');
		advance(TOAST_RESUME_GRACE_MS);
		expect(shown()?.leaving).toBe(true);
		advance(TOAST_EXIT_MS);
		expect(shown()?.message).toBe('Link copied');
	});

	test('timeouts have a floor, and the waiting line is capped without losing action toasts', () => {
		const { queue, shown, waiting } = setup();
		queue.push('Too quick', { timeout: 10 });
		expect(shown()?.timeout).toBe(TOAST_MIN_TIMEOUT);
		queue.push('Undo me', { action: 'Undo' });
		for (let i = 0; i < TOAST_MAX_QUEUED + 3; i++) queue.push(`Note ${i}`);
		expect(waiting()).toHaveLength(TOAST_MAX_QUEUED);
		expect(waiting()[0]).toBe('Undo me');
		expect(waiting().at(-1)).toBe(`Note ${TOAST_MAX_QUEUED + 2}`);
	});

	test('the store publishes snapshots and clear() empties everything', () => {
		const { queue, pending } = setup();
		const seen: (string | null)[] = [];
		const stop = queue.subscribe((snapshot) => seen.push(snapshot.current?.message ?? null));
		queue.push('One');
		queue.push('Two');
		queue.clear();
		stop();
		expect(seen[0]).toBeNull();
		expect(seen).toContain('One');
		expect(seen.at(-1)).toBeNull();
		expect(get(queue).queued).toEqual([]);
		expect(pending()).toBe(0);
	});
});

describe('toast() and showToast()', () => {
	test('work without a DOM and feed the shared queue; showToast keeps its error tone', () => {
		toasts.clear();
		const handle = toast('Link to message copied', { action: 'Undo' });
		expect(get(toasts).current?.message).toBe('Link to message copied');
		expect(get(toasts).current?.action).toBe('Undo');
		handle.dismiss();
		toasts.clear();

		showToast('Could not send the message');
		expect(get(toasts).current?.tone).toBe('error');
		expect(get(toasts).current?.timeout).toBe(6000);
		toasts.clear();

		showToast('Reconnected', 'info', 3000);
		expect(get(toasts).current?.tone).toBe('info');
		expect(get(toasts).current?.timeout).toBe(3000);
		toasts.clear();
	});
});

describe('Toast.svelte keeps the kit look under any ancestor', () => {
	// toast.ts moves the host into the top-most open modal dialog, so the toast becomes a
	// descendant of that dialog and its descendant rules reach it (the office dialogs'
	// `.workspace-dialog button` painted a raised fill under the inverse Undo label). Toast.svelte
	// restates the kit's look under the region class to outrank such rules; these tests keep that
	// guard complete and equal to the kit, so a kit change cannot be silently masked.
	type Rules = Map<string, Record<string, string>>;
	const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

	/** Top-level rules as selector -> declarations, read with Svelte's CSS parser. */
	function rulesOf(source: string): Rules {
		const rules: Rules = new Map();
		for (const node of parse(source, { modern: true }).css?.children ?? []) {
			if (node.type !== 'Rule') continue;
			const declarations: Record<string, string> = {};
			for (const item of node.block.children) {
				if (item.type === 'Declaration') declarations[item.property] = squash(item.value);
			}
			const selector = squash(source.slice(node.prelude.start, node.prelude.end));
			if (!rules.has(selector)) rules.set(selector, declarations);
		}
		return rules;
	}
	const stylesheet = (relative: string) => rulesOf(`<style>${readFileSync(new URL(relative, import.meta.url), 'utf8')}</style>`);

	const kit = stylesheet('../styles/kit-overlays.css');
	const base = stylesheet('../styles/base.css');
	const own = rulesOf(readFileSync(new URL('./components/ui/Toast.svelte', import.meta.url), 'utf8'));

	/** Kit rule -> the guarded rule that restates it in Toast.svelte. */
	const PAIRS: Array<[string, string]> = [
		['.w-toast', '.w-toast-region .w-toast'],
		[':where(.w-toast) > :where(svg)', '.w-toast-region .w-toast > :global(svg)'],
		['.w-toast__msg', '.w-toast-region .w-toast__msg'],
		['.w-toast__action', '.w-toast-region .w-toast__action'],
		['.w-toast__action:hover', '.w-toast-region .w-toast__action:hover']
	];
	/** What the guard may add where the kit leaves a property at its initial (or inherited) value. */
	const INITIAL: Record<string, string[]> = {
		margin: ['0'],
		border: ['0'],
		width: ['auto'],
		'min-height': ['0'],
		'box-shadow': ['none'],
		color: ['inherit'],
		font: ['inherit']
	};

	test('every guarded declaration equals the kit value', () => {
		const drift: string[] = [];
		for (const [kitSelector, ownSelector] of PAIRS) {
			const reference = kit.get(kitSelector);
			const guard = own.get(ownSelector);
			if (!reference) drift.push(`kit-overlays.css has no "${kitSelector}" rule`);
			if (!guard) drift.push(`Toast.svelte has no "${ownSelector}" rule`);
			if (!reference || !guard) continue;
			for (const [property, value] of Object.entries(guard)) {
				const expected = reference[property];
				const ok = expected === undefined ? INITIAL[property]?.includes(value) : expected === value;
				if (!ok) drift.push(`${ownSelector} { ${property}: ${value} } but the kit has ${expected ?? 'no value'}`);
			}
		}
		expect(drift).toEqual([]);
	});

	test('the action restates everything an ancestor button rule sets, and its own focus ring', () => {
		const action = own.get('.w-toast-region .w-toast__action') ?? {};
		const missing = ['background', 'border', 'border-radius', 'padding', 'margin', 'color', 'font', 'height', 'min-height', 'width', 'box-shadow', 'cursor'].filter(
			(property) => !(property in action)
		);
		expect(missing).toEqual([]);

		// A dialog's `button:focus-visible { outline: 2px solid <accent> }` must not recolour or
		// resize the ring: it is the app ring (base.css) in the kit's inverse colour.
		const ring = base.get(':focus-visible') ?? {};
		const inverse = kit.get('.w-toast__action:focus-visible')?.['outline-color'];
		expect(ring.outline).toContain('var(--w-accent)');
		expect(inverse).toBeDefined();
		const focus = own.get('.w-toast-region .w-toast__action:focus-visible') ?? {};
		expect(focus.outline).toBe(ring.outline.replace('var(--w-accent)', inverse ?? ''));
		expect(focus['outline-offset']).toBe(ring['outline-offset']);
	});

	test('inherited text settings start from the body, not the dialog around the host', () => {
		expect(own.get('.w-toast-region')).toMatchObject({
			'text-align': 'start',
			'letter-spacing': 'normal',
			'word-spacing': 'normal',
			'text-transform': 'none',
			'text-indent': '0',
			'white-space': 'normal'
		});
	});
});

describe('Toast.svelte handlers survive teardown', () => {
	test('every handler that reads item.id checks item first, since focusout fires while a focused toast is removed', () => {
		const source = readFileSync(new URL('./components/ui/Toast.svelte', import.meta.url), 'utf8');
		const handlers: string[] = [];
		const seen = new Set<object>();
		const visit = (node: unknown) => {
			if (!node || typeof node !== 'object' || seen.has(node)) return;
			seen.add(node);
			const n = node as { type?: string; name?: string; start?: number; end?: number };
			if (n.type === 'Attribute' && n.name?.startsWith('on') && n.start !== undefined && n.end !== undefined) {
				const text = source.slice(n.start, n.end);
				if (text.includes('item.id')) handlers.push(text);
			}
			for (const value of Object.values(node)) visit(value);
		};
		visit(parse(source, { modern: true }).fragment);
		expect(handlers.length).toBeGreaterThanOrEqual(6);
		for (const text of handlers) expect(text).toContain('item && ');
	});
});
