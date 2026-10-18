<!--
	Tooltip (design contract §7.14): inverse (kit `.w-tip`: --w-text fill, --w-bg text,
	--w-t-caption, --radius-inner, padding 5 9), with an optional shortcut in `.w-tip__key`.

	- Placed with `position: fixed` outside the control's scroller, so a scrolling rail, list or
	  panel can never clip it. The bubble is built in an effect and appended to document.body,
	  or to the open modal dialog / fullscreen element around the control, so it paints above a
	  native modal and is not inert there. Where the popover API exists it is shown as a manual
	  popover (top layer), so no transform, overflow or z-index around it can hide it.
	  Nothing in this component's own markup is ever moved, so it is safe inside {#each},
	  {#key} and mount().
	- Opens after a 400ms hover (straight away when another tooltip was open a moment ago, so
	  running the pointer along a toolbar reads each key), at once on :focus-visible, never on
	  touch. Esc dismisses it and is consumed, so the dialog or menu around the control stays
	  open; it stays dismissed until the pointer or focus leaves and comes back. Pressing the
	  control closes it. The pointer may move onto the tooltip without it closing (WCAG 1.4.13).
	- Only one tooltip is open at a time.
	- The tooltip describes its control (aria-describedby) unless it only repeats the control's
	  accessible name. A control with no name at all is named by the tooltip instead. The name is
	  re-read when the control's label or text changes (Mute → Unmute).

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

	/** The control's accessible name, ignoring the tooltip's own labelledby reference. */
	function nameOf(element: Element, ownId: string): string {
		const label = element.getAttribute('aria-label');
		if (label?.trim()) return label.trim();
		const ids = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id && id !== ownId);
		if (ids.length) {
			const name = ids
				.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
				.join(' ')
				.trim();
			if (name) return name;
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

	function matches(element: Element, selector: string): boolean {
		try {
			return element.matches(selector);
		} catch {
			return false;
		}
	}

	/**
	 * Where a floating layer for `control` has to live: inside the open modal dialog (or the
	 * fullscreen element) that contains it, since everything outside a modal paints under its
	 * backdrop and is inert; document.body otherwise.
	 */
	function layerFor(control: Element): HTMLElement {
		for (let node: Element | null = control; node; node = node.parentElement) {
			if (node instanceof HTMLDialogElement && node.open && matches(node, ':modal')) return node;
		}
		const fullscreen = document.fullscreenElement;
		if (fullscreen instanceof HTMLElement && fullscreen.contains(control)) return fullscreen;
		return document.body;
	}

	const popoverSupported = () => typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

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
	let open = $state(false);

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
		if (!matches(event.target as Element, ':focus-visible')) return;
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

	/** Esc closes only the tooltip: the key is consumed so the dialog or menu around it stays. */
	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !open) return;
		event.preventDefault();
		event.stopImmediatePropagation();
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

	// The control's accessible name, re-read when its label or text changes. Writing the same
	// string back does not re-run the effects below, so our own aria-* edits cannot loop.
	let controlName = $state('');
	$effect(() => {
		const element = target;
		if (!element) return;
		const read = () => (controlName = nameOf(element, tipId));
		read();
		const watcher = new MutationObserver(read);
		watcher.observe(element, {
			attributes: true,
			attributeFilter: ['aria-label', 'aria-labelledby'],
			childList: true,
			characterData: true,
			subtree: true
		});
		return () => watcher.disconnect();
	});

	// Describe the control, or name it when it has no name of its own.
	$effect(() => {
		const element = target;
		const line = text;
		const name = controlName;
		if (!element || !line) return;
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

	// The bubble. It is created here rather than in the markup and lives in document.body (or
	// the control's modal layer) for the component's lifetime, so aria-describedby always
	// resolves. Because no template node is moved, unmounting never disturbs sibling DOM.
	let tip = $state<HTMLDivElement | null>(null);
	let tipText: HTMLSpanElement | null = null;
	let tipKey: HTMLSpanElement | null = null;
	let destroyed = false;

	$effect(() => {
		const bubble = document.createElement('div');
		bubble.id = tipId;
		bubble.className = 'w-tip';
		bubble.setAttribute('role', 'tooltip');
		bubble.setAttribute('data-w-tooltip', '');
		if (popoverSupported()) bubble.setAttribute('popover', 'manual');
		bubble.hidden = true;
		tipText = document.createElement('span');
		tipKey = document.createElement('span');
		tipKey.className = 'w-tip__key';
		bubble.append(tipText);
		const enter = () => {
			overTip = true;
			if (closeTimer) clearTimeout(closeTimer);
			closeTimer = null;
		};
		const leave = () => {
			overTip = false;
			release();
		};
		bubble.addEventListener('pointerenter', enter);
		bubble.addEventListener('pointerleave', leave);
		document.body.appendChild(bubble);
		destroyed = false;
		tip = bubble;
		return () => {
			destroyed = true;
			bubble.removeEventListener('pointerenter', enter);
			bubble.removeEventListener('pointerleave', leave);
			bubble.remove();
		};
	});

	$effect(() => {
		const bubble = tip;
		if (!bubble || !tipText || !tipKey) return;
		tipText.textContent = text;
		if (shortcut) {
			tipKey.textContent = shortcut;
			if (tipKey.parentNode !== bubble) bubble.append(tipKey);
		} else {
			tipKey.remove();
		}
	});

	function place(bubble: HTMLDivElement, control: HTMLElement) {
		const a = control.getBoundingClientRect();
		const t = bubble.getBoundingClientRect();
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
		x = Math.round(Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - MARGIN - t.width)));
		y = Math.round(Math.min(Math.max(y, MARGIN), Math.max(MARGIN, vh - MARGIN - t.height)));
		bubble.dataset.side = side;
		bubble.style.left = `${x}px`;
		bubble.style.top = `${y}px`;
	}

	// Show it in the control's layer, and close it when the page moves under it or the control
	// goes away (a hover toolbar that hides never sends pointerleave).
	$effect(() => {
		const bubble = tip;
		const element = target;
		if (!open || !bubble || !element) return;
		const layer = layerFor(element);
		if (bubble.parentNode !== layer) layer.appendChild(bubble);
		bubble.hidden = false;
		if (bubble.hasAttribute('popover')) {
			try {
				bubble.showPopover();
			} catch {
				// Already open, or the layer left the document; the fixed position still applies.
			}
		}
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
			if (bubble.hasAttribute('popover')) {
				try {
					bubble.hidePopover();
				} catch {
					// Not showing any more (its layer closed or left the document).
				}
			}
			bubble.hidden = true;
			// Back to body, so a dialog's DOM is left as it was found.
			if (!destroyed && bubble.parentNode !== document.body) document.body.appendChild(bubble);
		};
	});

	// Place it once it is showing (before paint), and again when its words change.
	$effect(() => {
		const bubble = tip;
		const element = target;
		if (!open || !bubble || !element) return;
		void text;
		void shortcut;
		place(bubble, element);
	});

	$effect(() => () => {
		clearTimers();
		if (closeCurrent === hide) closeCurrent = null;
	});
</script>

{#if children}
	<span class="w-tip-anchor" bind:this={wrap}>{@render children()}</span>
{/if}

<style>
	.w-tip-anchor {
		display: contents;
	}
	/* The bubble is built in script, so these rules are global, keyed on its data attribute. */
	:global(.w-tip[data-w-tooltip]) {
		position: fixed;
		/* Undo the UA popover frame: no inset centring, margin, border or scroller. */
		inset: auto;
		margin: 0;
		border: 0;
		overflow: visible;
		height: auto;
		/* Reachable by the pointer so it can be read without closing (WCAG 1.4.13). */
		pointer-events: auto;
		width: max-content;
		/* Two-line detail tooltips never end on a single orphaned word. */
		text-wrap: pretty;
	}
	:global(.w-tip[data-w-tooltip][hidden]) {
		display: none;
	}
	/* Entrance along the axis it comes from (§4.7); reduced motion is handled globally. */
	:global(.w-tip[data-w-tooltip][data-side='top']) {
		animation-name: w-tip-from-below;
	}
	:global(.w-tip[data-w-tooltip][data-side='bottom']) {
		animation-name: w-tip-from-above;
	}
	:global(.w-tip[data-w-tooltip][data-side='left']) {
		animation-name: w-tip-from-right;
	}
	:global(.w-tip[data-w-tooltip][data-side='right']) {
		animation-name: w-tip-from-left;
	}
	@keyframes -global-w-tip-from-below {
		from {
			opacity: 0;
			translate: 0 4px;
		}
	}
	@keyframes -global-w-tip-from-above {
		from {
			opacity: 0;
			translate: 0 -4px;
		}
	}
	@keyframes -global-w-tip-from-right {
		from {
			opacity: 0;
			translate: 4px 0;
		}
	}
	@keyframes -global-w-tip-from-left {
		from {
			opacity: 0;
			translate: -4px 0;
		}
	}
</style>
