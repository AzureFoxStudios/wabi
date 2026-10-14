<!--
	Tooltip (design contract §7.14): inverse (kit `.w-tip`: --w-text fill, --w-bg text,
	--w-t-caption, --radius-inner, padding 5 9), with an optional shortcut in `.w-tip__key`.

	- Portaled to document.body and placed with `position: fixed`, so a scrolling rail, list or
	  panel can never clip it.
	- Opens after a 400ms hover (straight away when another tooltip was open a moment ago, so
	  running the pointer along a toolbar reads each key), at once on :focus-visible, never on
	  touch. Esc dismisses it until the pointer or focus leaves and comes back. Pressing the
	  control closes it. The pointer may move onto the tooltip without it closing (WCAG 1.4.13).
	- Only one tooltip is open at a time.
	- The tooltip describes its control (aria-describedby) unless it only repeats the control's
	  accessible name. A control with no name at all is named by the tooltip instead.

	Two ways to attach it:

	  <Tooltip text="Add panels" shortcut="Ctrl ." placement="left">
	    <button class="w-ibtn" aria-label="Add panels">…</button>
	  </Tooltip>

	wraps the control in a `display: contents` span (no box, layout untouched) and uses the first
	element inside it, or, where a wrapper would break a `parent > child` selector:

	  <button bind:this={addButton} class="w-ibtn" aria-label="Add panels">…</button>
	  <Tooltip anchor={addButton} text="Add panels" />
-->
<script module lang="ts">
	/** Closes whichever tooltip is open, so a newly opened one is the only one on screen. */
	let closeCurrent: (() => void) | null = null;
	/** When the last tooltip closed; within WARM_MS the next one opens without the delay. */
	let lastClosedAt = 0;
	const WARM_MS = 300;
	/** Time to cross the gap between the control and its tooltip before it closes. */
	const GRACE_MS = 100;
	const GAP = 8;
	const MARGIN = 8;

	export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

	const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = {
		top: 'bottom',
		bottom: 'top',
		left: 'right',
		right: 'left'
	};

	function nameOf(element: Element): string {
		const label = element.getAttribute('aria-label');
		if (label) return label.trim();
		const ids = element.getAttribute('aria-labelledby');
		if (ids) {
			return ids
				.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
				.join(' ')
				.trim();
		}
		return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
	}

	function addToken(element: Element, attribute: string, token: string) {
		const tokens = (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean);
		if (!tokens.includes(token)) element.setAttribute(attribute, [...tokens, token].join(' '));
	}

	function removeToken(element: Element, attribute: string, token: string) {
		const tokens = (element.getAttribute(attribute) ?? '').split(/\s+/).filter((value) => value && value !== token);
		if (tokens.length) element.setAttribute(attribute, tokens.join(' '));
		else element.removeAttribute(attribute);
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { portal } from '$lib/actions/portal';

	interface Props {
		/** The tooltip line; also its accessible description. */
		text: string;
		/** Keyboard shortcut shown after the text in micro type at 70% (e.g. "Ctrl K"). */
		shortcut?: string;
		/** Preferred side; flips to the opposite side when it does not fit. */
		placement?: TooltipPlacement;
		/** Hover delay in ms (contract: 400). */
		delay?: number;
		disabled?: boolean;
		/** The control to attach to when the tooltip does not wrap it. */
		anchor?: HTMLElement | null;
		/** Force (true) or suppress (false) aria-describedby; by default it is added unless the
		 *  text only repeats the control's name. */
		describe?: boolean;
		/** The wrapped control. */
		children?: Snippet;
	}

	let {
		text,
		shortcut,
		placement = 'top',
		delay = 400,
		disabled = false,
		anchor = null,
		describe,
		children
	}: Props = $props();

	const uid = $props.id();
	const tipId = `w-tip-${uid}`;

	let wrap = $state<HTMLSpanElement | null>(null);
	let tip = $state<HTMLDivElement | null>(null);
	let open = $state(false);
	let position = $state({ x: 0, y: 0, side: 'top' as TooltipPlacement });

	// The element the tooltip belongs to: the explicit anchor, else the first wrapped element.
	let wrapped = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!wrap) return;
		const pick = () => (wrapped = (wrap?.firstElementChild as HTMLElement | null) ?? null);
		pick();
		const watcher = new MutationObserver(pick);
		watcher.observe(wrap, { childList: true });
		return () => watcher.disconnect();
	});
	const target = $derived(anchor ?? wrapped);

	let hovering = false;
	let focused = false;
	let overTip = false;
	let dismissed = false;
	let openTimer: ReturnType<typeof setTimeout> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimers() {
		if (openTimer) clearTimeout(openTimer);
		if (closeTimer) clearTimeout(closeTimer);
		openTimer = closeTimer = null;
	}

	function show() {
		clearTimers();
		if (open || disabled || dismissed || !text) return;
		if (closeCurrent && closeCurrent !== hide) closeCurrent();
		closeCurrent = hide;
		open = true;
	}

	function hide() {
		clearTimers();
		if (!open) return;
		open = false;
		lastClosedAt = Date.now();
		if (closeCurrent === hide) closeCurrent = null;
	}

	/** Close once nothing (control hover, tooltip hover, keyboard focus) holds the tooltip. */
	function release() {
		if (hovering || overTip || focused) return;
		if (openTimer) clearTimeout(openTimer);
		openTimer = null;
		if (!open) return;
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = setTimeout(hide, GRACE_MS);
	}

	function onPointerEnter(event: PointerEvent) {
		if (event.pointerType === 'touch') return;
		hovering = true;
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
		if (open || disabled || dismissed) return;
		const warm = Date.now() - lastClosedAt < WARM_MS || closeCurrent !== null;
		if (warm || delay <= 0) show();
		else {
			if (openTimer) clearTimeout(openTimer);
			openTimer = setTimeout(show, delay);
		}
	}

	function onPointerLeave() {
		hovering = false;
		if (!focused) dismissed = false;
		release();
	}

	function onFocusIn(event: FocusEvent) {
		const element = event.target as Element | null;
		let visible = false;
		try {
			visible = Boolean(element?.matches(':focus-visible'));
		} catch {
			visible = false;
		}
		if (!visible) return;
		focused = true;
		show();
	}

	function onFocusOut(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (next && target?.contains(next)) return;
		focused = false;
		if (!hovering) dismissed = false;
		release();
	}

	/** Pressing the control is an answer, not a question: put the tooltip away. */
	function onPress() {
		clearTimers();
		hide();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !open) return;
		dismissed = true;
		hide();
	}

	// Listen on the control itself, whichever way it was attached.
	$effect(() => {
		const element = target;
		if (!element) return;
		element.addEventListener('pointerenter', onPointerEnter);
		element.addEventListener('pointerleave', onPointerLeave);
		element.addEventListener('focusin', onFocusIn);
		element.addEventListener('focusout', onFocusOut);
		element.addEventListener('pointerdown', onPress);
		return () => {
			element.removeEventListener('pointerenter', onPointerEnter);
			element.removeEventListener('pointerleave', onPointerLeave);
			element.removeEventListener('focusin', onFocusIn);
			element.removeEventListener('focusout', onFocusOut);
			element.removeEventListener('pointerdown', onPress);
			hovering = focused = false;
			hide();
		};
	});

	// Describe the control, or name it when it has no name of its own.
	$effect(() => {
		const element = target;
		const line = text;
		if (!element || !line) return;
		const name = nameOf(element);
		if (!name) {
			addToken(element, 'aria-labelledby', tipId);
			return () => removeToken(element, 'aria-labelledby', tipId);
		}
		const repeats = name.toLowerCase() === line.trim().toLowerCase();
		if (describe === false || (describe === undefined && repeats)) return;
		addToken(element, 'aria-describedby', tipId);
		return () => removeToken(element, 'aria-describedby', tipId);
	});

	$effect(() => {
		if (disabled) hide();
	});

	function place() {
		if (!tip || !target) return;
		const a = target.getBoundingClientRect();
		const t = tip.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const fits: Record<TooltipPlacement, boolean> = {
			top: a.top - GAP - t.height >= MARGIN,
			bottom: a.bottom + GAP + t.height <= vh - MARGIN,
			left: a.left - GAP - t.width >= MARGIN,
			right: a.right + GAP + t.width <= vw - MARGIN
		};
		let side = placement;
		if (!fits[side] && fits[OPPOSITE[side]]) side = OPPOSITE[side];
		let x: number;
		let y: number;
		if (side === 'top' || side === 'bottom') {
			x = a.left + a.width / 2 - t.width / 2;
			y = side === 'top' ? a.top - GAP - t.height : a.bottom + GAP;
		} else {
			x = side === 'left' ? a.left - GAP - t.width : a.right + GAP;
			y = a.top + a.height / 2 - t.height / 2;
		}
		x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - MARGIN - t.width));
		y = Math.min(Math.max(y, MARGIN), Math.max(MARGIN, vh - MARGIN - t.height));
		position = { x: Math.round(x), y: Math.round(y), side };
	}

	// Place it once it is in the DOM (before paint), and close it when the page moves under it or
	// the control goes away (a hover toolbar that hides never sends pointerleave).
	$effect(() => {
		const element = target;
		if (!open || !tip || !element) return;
		void text;
		void shortcut;
		place();
		const close = () => hide();
		const gone = setInterval(() => {
			if (!element.isConnected || element.getClientRects().length === 0) hide();
		}, 250);
		window.addEventListener('scroll', close, { capture: true, passive: true });
		window.addEventListener('resize', close);
		window.addEventListener('keydown', onKeydown, true);
		return () => {
			clearInterval(gone);
			window.removeEventListener('scroll', close, { capture: true });
			window.removeEventListener('resize', close);
			window.removeEventListener('keydown', onKeydown, true);
		};
	});

	$effect(() => () => {
		clearTimers();
		if (closeCurrent === hide) closeCurrent = null;
	});
</script>

{#if children}
	<span class="w-tip-anchor" bind:this={wrap}>{@render children()}</span>
{/if}

<div
	bind:this={tip}
	use:portal
	id={tipId}
	class="w-tip"
	data-side={position.side}
	role="tooltip"
	hidden={!open}
	style:left="{position.x}px"
	style:top="{position.y}px"
	onpointerenter={() => {
		overTip = true;
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
	}}
	onpointerleave={() => {
		overTip = false;
		release();
	}}
>
	<span>{text}</span>
	{#if shortcut}<span class="w-tip__key">{shortcut}</span>{/if}
</div>

<style>
	.w-tip-anchor {
		display: contents;
	}
	.w-tip {
		position: fixed;
		/* Reachable by the pointer so it can be read without closing (WCAG 1.4.13). */
		pointer-events: auto;
		width: max-content;
		/* Two-line detail tooltips never end on a single orphaned word. */
		text-wrap: pretty;
	}
	.w-tip[hidden] {
		display: none;
	}
	/* Entrance along the axis it comes from (§4.7); reduced motion is handled globally. */
	.w-tip[data-side='top'] {
		animation-name: w-tip-from-below;
	}
	.w-tip[data-side='bottom'] {
		animation-name: w-tip-from-above;
	}
	.w-tip[data-side='left'] {
		animation-name: w-tip-from-right;
	}
	.w-tip[data-side='right'] {
		animation-name: w-tip-from-left;
	}
	@keyframes w-tip-from-below {
		from {
			opacity: 0;
			translate: 0 4px;
		}
	}
	@keyframes w-tip-from-above {
		from {
			opacity: 0;
			translate: 0 -4px;
		}
	}
	@keyframes w-tip-from-right {
		from {
			opacity: 0;
			translate: 4px 0;
		}
	}
	@keyframes w-tip-from-left {
		from {
			opacity: 0;
			translate: -4px 0;
		}
	}
</style>
