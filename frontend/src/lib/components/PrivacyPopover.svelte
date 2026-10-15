<!--
	Privacy popover (design contract §7.14, §7.20, §9.2): opened from the composer colophon or a
	seal chip by `PrivacyBadge.svelte`. Every word comes from `lib/privacy/privacyState.ts`.

	- Kit `.w-pop`: title = the state word with its glyph in --w-seal; body = what the server
	  operator can read; facts Room / Kept / Encryption; under the rule, in DMs and groups the
	  §9.2 explanation, then the link "How privacy works in Wabi" (/privacy).
	- A non-modal dialog (role="dialog", named by its title, described by its body). Portaled to
	  the body and placed with `position: fixed` next to its anchor (above by default for the
	  colophon, below for a header chip), flipping when it does not fit and clamped to the
	  viewport, so a scrolling or container-query stage never clips it.
	- Opening moves focus into the dialog; Esc closes it and returns focus to the anchor. A press
	  outside, or focus leaving both the dialog and its anchor, closes it without moving focus.
-->
<script module lang="ts">
	const GAP = 6;
	const MARGIN = 8;
</script>

<script lang="ts">
	import { portal } from '$lib/actions/portal';
	import Icon from '$lib/components/ui/Icon.svelte';
	import {
		PRIVACY_EXPLANATION,
		PRIVACY_LINK_HREF,
		PRIVACY_LINK_LABEL,
		privacyFacts,
		privacyPopoverBody,
		privacyWords,
		type PrivacyPolicy,
		type PrivacyState
	} from '$lib/privacy/privacyState';

	interface Props {
		open?: boolean;
		/** The control that opened it: placement, outside-press and focus return use it. */
		anchor?: HTMLElement | null;
		state: PrivacyState;
		/** DMs and groups: "this channel" becomes "this conversation" and the explanation shows. */
		conversation?: boolean;
		/** Room fact: "#general · Common Ground", "Theo Park". */
		room?: string | null;
		/** Kept fact: the room policy or its retention label ('24h', 'live', 'forever'). */
		retention?: PrivacyPolicy | string | null;
		/** Preferred side of the anchor; flips when it does not fit. */
		placement?: 'top' | 'bottom';
		/** Element id, for the trigger's aria-controls. */
		id?: string;
		onclose?: () => void;
	}

	let {
		open = $bindable(false),
		anchor = null,
		// Renamed locally: a binding called `state` would turn the `$state` rune into a store read.
		state: privacy,
		conversation = false,
		room = null,
		retention = null,
		placement = 'top',
		id,
		onclose
	}: Props = $props();

	const uid = $props.id();
	const popId = $derived(id ?? `privacy-pop-${uid}`);
	const titleId = `privacy-pop-title-${uid}`;
	const bodyId = `privacy-pop-body-${uid}`;

	const words = $derived(privacyWords(privacy, { conversation }));
	const body = $derived(privacyPopoverBody(privacy, { conversation }));
	const facts = $derived(privacyFacts(privacy, { conversation, room, retention }));

	let pop = $state<HTMLDivElement | null>(null);
	let position = $state({ x: 0, y: 0, side: 'top' as 'top' | 'bottom', placed: false });

	const portalTarget =
		typeof document !== 'undefined' ? ((document.fullscreenElement as HTMLElement | null) ?? document.body) : undefined;

	function close(returnFocus: boolean) {
		if (!open) return;
		open = false;
		position = { ...position, placed: false };
		onclose?.();
		if (returnFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
	}

	function place() {
		if (!pop) return;
		const p = pop.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (!anchor) {
			// No anchor to sit beside: centre it rather than leave it unplaced (and invisible).
			position = { x: Math.round((vw - p.width) / 2), y: Math.round((vh - p.height) / 2), side: placement, placed: true };
			return;
		}
		const a = anchor.getBoundingClientRect();
		const above = a.top - GAP - p.height >= MARGIN;
		const below = a.bottom + GAP + p.height <= vh - MARGIN;
		let side = placement;
		if (side === 'top' && !above && below) side = 'bottom';
		if (side === 'bottom' && !below && above) side = 'top';
		const y = side === 'top' ? a.top - GAP - p.height : a.bottom + GAP;
		// Start-aligned with the anchor (the colophon glyph, the chip's edge), kept on screen.
		const x = Math.min(Math.max(a.left, MARGIN), Math.max(MARGIN, vw - MARGIN - p.width));
		position = {
			x: Math.round(x),
			y: Math.round(Math.min(Math.max(y, MARGIN), Math.max(MARGIN, vh - MARGIN - p.height))),
			side,
			placed: true
		};
	}

	// Place before paint and follow the anchor while open; close when the anchor goes away.
	$effect(() => {
		const element = pop;
		const target = anchor;
		if (!open || !element) return;
		void privacy;
		void room;
		void retention;
		void conversation;
		place();

		const follow = () => place();
		const resize = new ResizeObserver(follow);
		resize.observe(element);
		const gone = setInterval(() => {
			if (!target || !target.isConnected || target.getClientRects().length === 0) close(false);
		}, 250);

		function onPointerDown(event: PointerEvent) {
			const node = event.target as Node | null;
			if (!node || element.contains(node) || target?.contains(node)) return;
			close(false);
		}
		function onKeydown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				close(true);
				return;
			}
			// The dialog is portaled to the end of the page, so tabbing past either end would leave
			// the app. Hand focus back to the anchor instead; tabbing continues from there.
			if (event.key !== 'Tab' || !element.contains(event.target as Node)) return;
			const stops = Array.from(element.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'));
			const active = document.activeElement;
			const leaving = event.shiftKey ? active === element || active === stops[0] : active === stops.at(-1);
			if (!leaving) return;
			event.preventDefault();
			close(true);
		}

		window.addEventListener('scroll', follow, { capture: true, passive: true });
		window.addEventListener('resize', follow);
		document.addEventListener('pointerdown', onPointerDown, true);
		element.addEventListener('keydown', onKeydown);
		target?.addEventListener('keydown', onKeydown);
		return () => {
			resize.disconnect();
			clearInterval(gone);
			window.removeEventListener('scroll', follow, { capture: true });
			window.removeEventListener('resize', follow);
			document.removeEventListener('pointerdown', onPointerDown, true);
			element.removeEventListener('keydown', onKeydown);
			target?.removeEventListener('keydown', onKeydown);
		};
	});

	// Move focus into the dialog once per opening, so its title and body are announced and Tab
	// reaches the link. Later re-placements (state or retention changes) never steal focus.
	let entered = false;
	$effect(() => {
		if (!open || !pop) {
			entered = false;
			return;
		}
		if (entered) return;
		entered = true;
		pop.focus({ preventScroll: true });
	});

	function onFocusOut(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		// Focus moving to the page (null) is a press somewhere else; that path closes it already.
		if (!next || pop?.contains(next) || anchor?.contains(next)) return;
		close(false);
	}
</script>

{#if open}
	<div
		bind:this={pop}
		use:portal={portalTarget}
		id={popId}
		class="w-pop privacy-pop"
		class:privacy-pop--placed={position.placed}
		data-side={position.side}
		data-state={words.state}
		role="dialog"
		aria-labelledby={titleId}
		aria-describedby={bodyId}
		tabindex="-1"
		style:left="{position.x}px"
		style:top="{position.y}px"
		onfocusout={onFocusOut}
	>
		<h2 class="w-pop__title" id={titleId}>
			<Icon name={words.glyph} size={16} class="privacy-pop__glyph" />
			<span>{words.word}</span>
		</h2>
		<p class="w-pop__body" id={bodyId}>{body}</p>
		<dl class="w-pop__facts">
			{#each facts as fact (fact.term)}
				<dt>{fact.term}</dt>
				<dd>{fact.value}</dd>
			{/each}
		</dl>
		<!-- This room first, then how privacy works everywhere: the §9.2 explanation sits with the
		     link under the rule, as a footnote. -->
		<div class="w-pop__foot privacy-pop__foot">
			{#if conversation}
				<p class="privacy-pop__about">{PRIVACY_EXPLANATION}</p>
			{/if}
			<a href={PRIVACY_LINK_HREF} onclick={() => close(false)}>{PRIVACY_LINK_LABEL}</a>
		</div>
	</div>
{/if}

<style>
	.privacy-pop {
		position: fixed;
		z-index: var(--z-floating-ui, 2250);
		width: min(360px, calc(100vw - 16px));
		max-width: none;
		max-height: calc(100dvh - 16px);
		overflow-y: auto;
		overscroll-behavior: contain;
		/* Measured before it is shown, so the first frame is already in place. Transparent rather
		   than hidden, so it can take focus the moment it opens. */
		opacity: 0;
		pointer-events: none;
		animation: none;
	}
	.privacy-pop--placed {
		opacity: 1;
		pointer-events: auto;
	}
	/* Entrance along the axis it comes from (§4.7); reduced motion is handled globally. */
	.privacy-pop--placed[data-side='top'] {
		animation: privacy-pop-from-below var(--w-dur-2) var(--w-ease);
	}
	.privacy-pop--placed[data-side='bottom'] {
		animation: privacy-pop-from-above var(--w-dur-2) var(--w-ease);
	}
	/* The dialog is focused as a whole so its title and body are announced; the link inside keeps
	   the visible focus ring. */
	.privacy-pop:focus {
		outline: none;
	}
	.privacy-pop :global(.privacy-pop__glyph) {
		color: var(--w-seal);
	}
	.privacy-pop .w-pop__title {
		/* The kit's popover title is set in serif; this keeps it a heading without h2 defaults. */
		font: var(--w-t-subhead);
		margin: 0;
	}
	.privacy-pop__about {
		margin: 0 0 10px;
		color: var(--w-faint);
		font: var(--w-t-small);
		text-wrap: pretty;
	}
	.privacy-pop .w-pop__facts dd {
		overflow-wrap: anywhere;
	}
	.privacy-pop .w-pop__foot a {
		text-decoration: underline;
		text-decoration-thickness: var(--w-bw, 1px);
		text-underline-offset: 3px;
		text-decoration-color: color-mix(in srgb, var(--w-accent) 45%, transparent);
		transition: text-decoration-color var(--w-dur-1) var(--w-ease);
	}
	.privacy-pop .w-pop__foot a:hover {
		text-decoration-color: currentColor;
	}
	.privacy-pop .w-pop__foot a:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}
	@keyframes privacy-pop-from-below {
		from {
			opacity: 0;
			translate: 0 4px;
		}
	}
	@keyframes privacy-pop-from-above {
		from {
			opacity: 0;
			translate: 0 -4px;
		}
	}
</style>
