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
	stage, not the window). With no anchor on screen the kit default applies (16px above the
	80px footer band; above the phone nav under 600px).
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

	const current = $derived(ready ? snapshot.current : null);
	const currentId = $derived(current?.id ?? 0);
	const glyph = (item: ToastItem): IconName | null =>
		item.tone === 'error' ? 'alert' : item.tone === 'warning' ? 'warn' : null;

	const ANCHOR_GAP = 16;
	let place = $state<{ bottom: number; left: number; right: number } | null>(null);

	/** 16px above the highest visible [data-toast-anchor] in the lower half of the window. */
	function measure() {
		let best: DOMRect | null = null;
		for (const element of document.querySelectorAll<HTMLElement>('[data-toast-anchor]')) {
			const rect = element.getBoundingClientRect();
			if (!rect.width || !rect.height || rect.top >= window.innerHeight || rect.bottom <= window.innerHeight / 2) continue;
			if (!best || rect.top < best.top) best = rect;
		}
		place = best
			? {
					bottom: Math.round(window.innerHeight - best.top + ANCHOR_GAP),
					left: Math.max(0, Math.round(best.left)),
					right: Math.max(0, Math.round(window.innerWidth - best.right))
				}
			: null;
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
