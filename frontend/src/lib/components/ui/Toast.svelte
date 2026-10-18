<!--
	Toast host (design contract §7.14). Mounted once into document.body by `toast()` in
	$lib/toast.ts; never placed by a layout. Kit markup (kit-overlays.css):
	  .w-toast-region > .w-toast > svg + .w-toast__msg + button.w-toast__action

	Two persistent live regions sit at the same spot: role=status for ordinary toasts and
	role=alert for errors. Only one toast shows at a time, so they never overlap. The regions
	exist before the first toast is rendered into them, so even the first one is announced.
	Hover or focus pauses the timer; Esc closes the toast while focus is inside it, and focus
	goes back to where it came from when the toast closes under it.

	Placement: bottom-center, 16px above the composer or the phone nav (§7.14). Surfaces mark
	those bars with `data-toast-anchor`; each new toast sits 16px above the highest visible
	anchor in the lower half of the window and centres on it (so on desktop it centres on the
	stage, not the window). Until a surface marks its composer, the frame around a writing field
	docked at the bottom of the window (the focused one, else the widest) stands in for it, so a
	toast never covers what is being typed. With neither on screen the kit default applies (16px
	above the 80px footer band; above the phone nav under 600px). While the host sits in an open
	modal dialog (toast.ts moves it there) only anchors inside that dialog count.

	The queue's clock is held until this host has rendered (toast.ts holds it while the host
	loads), so the first toast of a session gets its full time.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { ToastItem, ToastQueue, ToastSnapshot } from '$lib/toast';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	interface Props {
		queue: ToastQueue;
	}

	let { queue }: Props = $props();

	let snapshot = $state<ToastSnapshot>({ current: null, queued: [] });
	let ready = $state(false);

	$effect(() => queue.subscribe((next) => (snapshot = next)));

	onMount(() => {
		// Let assistive tech register the empty live regions before content arrives.
		const frame = requestAnimationFrame(() => (ready = true));
		return () => cancelAnimationFrame(frame);
	});

	// The regions now show toasts: start the visible toast's time from here.
	$effect(() => {
		if (ready) queue.release();
	});

	const current = $derived(ready ? snapshot.current : null);
	const currentId = $derived(current?.id ?? 0);
	const glyph = (item: ToastItem): IconName | null =>
		item.tone === 'error' ? 'alert' : item.tone === 'warning' ? 'warn' : null;

	const ANCHOR_GAP = 16;
	/** The 360px toast plus the region's 16px side padding: the narrowest region it centres in. */
	const TOAST_SPAN = 392;
	const FIELDS = 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
	let statusRegion = $state<HTMLDivElement | null>(null);
	let place = $state<{ bottom: number; left: number; right: number } | null>(null);

	const onScreen = (rect: DOMRect) => rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;

	/**
	 * Stand-in until surfaces mark their composer: the box drawn around a writing field docked
	 * at the bottom of the window (its buttons and reply bar), never the whole column above it.
	 */
	function composerFrame(usable: (element: Element) => boolean): DOMRect | null {
		const vh = window.innerHeight;
		let best: { frame: DOMRect; focused: boolean } | null = null;
		for (const field of document.querySelectorAll<HTMLElement>(FIELDS)) {
			if (!usable(field)) continue;
			const rect = field.getBoundingClientRect();
			if (!onScreen(rect) || rect.top < vh * 0.5 || rect.bottom < vh * 0.7 || rect.bottom > vh) continue;
			let frame = rect;
			for (let node = field.parentElement; node && node !== document.body; node = node.parentElement) {
				const outer = node.getBoundingClientRect();
				if (outer.top < vh * 0.5 || outer.height > rect.height + 120) break;
				frame = outer;
			}
			const active = document.activeElement;
			const focused = Boolean(active && field.contains(active));
			if (!best || (focused && !best.focused) || (focused === best.focused && frame.width > best.frame.width)) {
				best = { frame, focused };
			}
		}
		return best?.frame ?? null;
	}

	/** 16px above the highest visible [data-toast-anchor] in the lower half of the window. */
	function measure() {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// The host's layer: document.body, or the modal dialog toast.ts moved it into.
		const layer = statusRegion?.parentElement?.parentElement ?? document.body;
		const usable = (element: Element) =>
			(layer === document.body || layer.contains(element)) && !element.closest('[data-wabi-toasts], [inert]');
		let best: DOMRect | null = null;
		for (const element of document.querySelectorAll('[data-toast-anchor]')) {
			if (!usable(element)) continue;
			const rect = element.getBoundingClientRect();
			if (!onScreen(rect) || rect.bottom <= vh / 2) continue;
			if (!best || rect.top < best.top) best = rect;
		}
		best ??= composerFrame(usable);
		if (!best) {
			place = null;
			return;
		}
		// Centre on the anchor, but never squeeze the toast below its 360px.
		const width = Math.min(vw, Math.max(best.width, TOAST_SPAN));
		const left = Math.round(Math.min(Math.max(best.left + best.width / 2 - width / 2, 0), vw - width));
		place = {
			bottom: Math.round(vh - best.top + ANCHOR_GAP),
			left,
			right: Math.max(0, Math.round(vw - left - width))
		};
	}

	$effect(() => {
		if (!currentId) return;
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});

	// Where focus was before it moved into the toast, to hand it back when the toast closes.
	let returnFocusTo: HTMLElement | null = null;

	function onFocusIn(event: FocusEvent, id: number) {
		const from = event.relatedTarget;
		const toastElement = event.currentTarget as HTMLElement;
		if (from instanceof HTMLElement && !toastElement.contains(from)) returnFocusTo = from;
		queue.pause(id, 'focus');
	}

	function onFocusOut(event: FocusEvent, id: number) {
		const next = event.relatedTarget as Node | null;
		if (next && (event.currentTarget as HTMLElement).contains(next)) return;
		returnFocusTo = null;
		queue.resume(id, 'focus');
	}

	/** Close the toast; if focus was inside it, put focus back where the person was. */
	function close(event: Event, id: number, run: (id: number) => void) {
		const toastElement = (event.currentTarget as HTMLElement).closest('.w-toast');
		const hadFocus = Boolean(toastElement?.contains(document.activeElement));
		const back = returnFocusTo;
		returnFocusTo = null;
		run(id);
		if (hadFocus && back?.isConnected) back.focus({ preventScroll: true });
	}

	function onKeydown(event: KeyboardEvent, id: number) {
		if (event.key !== 'Escape') return;
		// Only the toast closes: not the dialog it may sit in, nor a menu behind it.
		event.preventDefault();
		event.stopPropagation();
		close(event, id, queue.dismiss);
	}
</script>

{#snippet card(item: ToastItem)}
	{@const icon = glyph(item)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="w-toast"
		class:leaving={item.leaving}
		onpointerenter={() => queue.pause(item.id, 'hover')}
		onpointerleave={() => queue.resume(item.id, 'hover')}
		onfocusin={(event) => onFocusIn(event, item.id)}
		onfocusout={(event) => onFocusOut(event, item.id)}
		onkeydown={(event) => onKeydown(event, item.id)}
	>
		{#if icon}<Icon name={icon} size={16} />{/if}
		<span class="w-toast__msg">{item.message}</span>
		{#if item.action}
			<button type="button" class="w-toast__action" onclick={(event) => close(event, item.id, queue.act)}>{item.action}</button>
		{/if}
	</div>
{/snippet}

<div
	bind:this={statusRegion}
	class="w-toast-region"
	role="status"
	aria-live="polite"
	aria-atomic="true"
	style:--w-toast-bottom={place ? `${place.bottom}px` : undefined}
	style:left={place ? `${place.left}px` : undefined}
	style:right={place ? `${place.right}px` : undefined}
>
	{#if current && current.tone !== 'error'}
		{#key current.id}{@render card(current)}{/key}
	{/if}
</div>
<div
	class="w-toast-region"
	role="alert"
	aria-atomic="true"
	style:--w-toast-bottom={place ? `${place.bottom}px` : undefined}
	style:left={place ? `${place.left}px` : undefined}
	style:right={place ? `${place.right}px` : undefined}
>
	{#if current && current.tone === 'error'}
		{#key current.id}{@render card(current)}{/key}
	{/if}
</div>

<style>
	/* The host element toast.ts mounts into (a manual popover where supported): a 0×0 fixed
	   layer, so the fixed regions inside it place against the window. It stays displayed even
	   when it is not in the top layer. */
	:global([data-wabi-toasts]) {
		display: block;
		position: fixed;
		inset: auto;
		width: 0;
		height: 0;
		margin: 0;
		padding: 0;
		border: 0;
		overflow: visible;
		background: none;
		pointer-events: none;
	}
	/* Exit: opacity plus a 4px drop at 0.75× the entrance duration (§4.7). Reduced motion is
	   handled globally (motion.css), and the queue removes the node after TOAST_EXIT_MS. */
	.w-toast {
		transition:
			opacity calc(var(--w-dur-2) * 0.75) var(--w-ease),
			translate calc(var(--w-dur-2) * 0.75) var(--w-ease);
	}
	.w-toast.leaving {
		opacity: 0;
		translate: 0 4px;
		pointer-events: none;
	}
</style>
