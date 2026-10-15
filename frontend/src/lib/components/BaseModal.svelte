<!--
	The one dialog frame (design contract §7.13), on the kit `.w-scrim` + `.w-dialog`.

	- Portaled to <body> (or the fullscreen element, so a dialog opened from a fullscreen
	  whiteboard or call stays visible), centred with `inset: 0; margin: auto`.
	- The scrim is a sibling of the panel, never a wrapper: the panel itself carries role=dialog
	  (or alertdialog), aria-modal and aria-labelledby (the title, or the caller's header slot).
	- Focus is trapped by `modalFocus`, Esc closes, and focus returns to the opener on close.
	  `initialFocus` (a selector inside the panel) moves first focus off the frame, e.g. onto the
	  safe button of a destructive confirm.
	- Sizes: sm 440 · md 560 · lg 760 · settings 1040 × min(808, 100dvh − 64); `width` keeps any
	  caller-specific width. The header row is 64px: serif title, optional scope `note`
	  ("Saved on this device · not shared"), and an icon close button.
	- `padded` gives the body the kit inset (28/44px). Legacy callers bring their own padding, so
	  the frame then uses a 24px inset for the title row to line up with their content.

	Slots: `header` (replaces the title row), default (the body; it scrolls), `footer` (stays put).
-->
<script module lang="ts">
	let modalCounter = 0;
</script>

<script lang="ts">
	import { modalFocus } from '$lib/actions/modalFocus';
	import { portal } from '$lib/actions/portal';
	import Icon from './ui/Icon.svelte';

	export let isOpen: boolean = false;
	export let onClose: () => void;
	export let variant: 'center' | 'right-panel' | 'full-screen' = 'center';
	/** Kit size; wins over `width`. Without either the frame is md (560). */
	export let size: 'sm' | 'md' | 'lg' | 'settings' | null = null;
	/** Any CSS width for callers that predate the size scale (capped to the viewport). */
	export let width: string = '';
	export let showCloseButton: boolean = true;
	export let overlayZIndex: number | string | null = null;
	// Optional plain-text header. When set, it replaces the header slot so
	// runes-mode callers don't need snippet/slot interop.
	export let title: string = '';
	/** One-line scope note beside the title ("Saved on this device · not shared"). */
	export let note: string = '';
	/** A longer description under the title row. */
	export let subtitle: string = '';
	export let headerTag: string = '';
	/** Accessible name when there is neither a title nor a header slot. */
	export let ariaLabel: string = '';
	/** Id of the element that describes the dialog (a confirm's consequence sentence). */
	export let describedBy: string | null = null;
	export let role: 'dialog' | 'alertdialog' = 'dialog';
	/** Use the kit body inset (28/44px) instead of the caller's own padding. */
	export let padded: boolean = false;
	export let closeOnScrim: boolean = true;
	/** Selector of the element to focus first (inside the panel). */
	export let initialFocus: string | null = null;
	/** Extra classes for the panel. */
	export let panelClass: string = '';

	const uid = ++modalCounter;
	const titleId = `base-modal-${uid}-title`;
	const headId = `base-modal-${uid}-head`;

	$: hasSlotHeader = !title && !!$$slots.header;
	$: labelledBy = title ? titleId : hasSlotHeader ? headId : undefined;
	$: sizeClass = size ? `w-dialog--${size}` : width ? '' : 'w-dialog--md';
	$: widthStyle = !size && width ? `--w-dialog-w: ${width};` : '';
	$: zStyle = overlayZIndex != null && overlayZIndex !== '' ? `--base-modal-z: ${overlayZIndex};` : '';
	$: portalTarget =
		typeof document !== 'undefined'
			? ((document.fullscreenElement as HTMLElement | null) ?? document.body)
			: undefined;

	function handleScrimClick() {
		if (closeOnScrim) onClose();
	}

	/** Runs after modalFocus has focused the frame (same element, later action, later microtask). */
	function focusFirst(node: HTMLElement, selector: string | null) {
		queueMicrotask(() => {
			if (!selector || !node.isConnected) return;
			const target = node.querySelector<HTMLElement>(selector);
			target?.focus({ preventScroll: true });
		});
	}
</script>

{#if isOpen}
	<div class="base-modal-layer" style={zStyle || undefined} use:portal={portalTarget}>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div class="w-scrim base-modal-scrim" on:click={handleScrimClick}></div>
		<div
			class="w-dialog base-modal {sizeClass} base-modal--{variant} {panelClass}"
			class:base-modal--padded={padded}
			style={widthStyle || undefined}
			{role}
			aria-modal="true"
			aria-labelledby={labelledBy}
			aria-label={labelledBy ? undefined : ariaLabel || undefined}
			aria-describedby={describedBy || undefined}
			tabindex="-1"
			use:modalFocus={onClose}
			use:focusFirst={initialFocus}
		>
			{#if title}
				<header class="w-dialog__head base-modal__head" class:base-modal__head--rule={!padded}>
					<h2 class="w-dialog__title" id={titleId}>{title}</h2>
					{#if note}<p class="w-dialog__note">{note}</p>{/if}
					{#if showCloseButton}
						<button type="button" class="w-ibtn w-dialog__close" on:click={onClose} aria-label="Close dialog">
							<Icon name="x" size={18} />
						</button>
					{/if}
					{#if headerTag}<p class="base-modal__tag">{headerTag}</p>{/if}
					{#if subtitle}<p class="base-modal__subtitle">{subtitle}</p>{/if}
				</header>
			{:else}
				{#if hasSlotHeader}
					<div class="base-modal__slot-head" id={headId}><slot name="header" /></div>
				{/if}
				{#if showCloseButton}
					<button type="button" class="w-ibtn base-modal__close" on:click={onClose} aria-label="Close dialog">
						<Icon name="x" size={18} />
					</button>
				{/if}
			{/if}
			<div class="base-modal__body" class:w-dialog__body={padded}>
				<slot />
			</div>
			<slot name="footer" />
		</div>
	</div>
{/if}

<style>
	/* Groups the scrim and the panel at one stacking level; draws nothing itself. */
	.base-modal-layer {
		display: contents;
	}

	.base-modal-scrim {
		z-index: var(--base-modal-z, var(--z-modal, 1500));
	}

	.base-modal {
		z-index: calc(var(--base-modal-z, var(--z-modal, 1500)) + 1);
		outline: none;
	}
	/* Legacy bodies bring their own ~24px padding; the title row lines up with them. */
	.base-modal:not(.base-modal--padded) {
		--w-dialog-px: 24px;
	}

	.base-modal__head--rule {
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.base-modal__tag,
	.base-modal__subtitle {
		grid-column: 1 / 3;
		margin: 0;
	}
	.base-modal__tag {
		margin-top: 4px;
		color: var(--w-text);
		font: var(--w-t-label);
	}
	.base-modal__subtitle {
		margin-top: 4px;
		padding-bottom: 8px;
		color: var(--w-mute);
		font: var(--w-t-small);
		text-wrap: pretty;
	}

	/* A caller's own header keeps its layout; the close button sits in the 64px title band. */
	.base-modal__slot-head {
		flex: none;
	}
	.base-modal__close {
		position: absolute;
		top: 16px;
		right: 16px;
		z-index: 1;
	}

	/* The body is the only part that scrolls; header and footer stay put. */
	.base-modal__body {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
	}

	.base-modal--right-panel {
		inset: 0 0 0 auto;
		width: min(400px, 100vw);
		height: 100dvh;
		max-height: none;
		margin: 0;
		border-width: 0 0 0 var(--w-bw);
		border-radius: 0;
		animation-name: base-modal-from-right;
	}
	.base-modal--full-screen {
		width: 100vw;
		height: 100dvh;
		max-height: none;
		border: 0;
		border-radius: 0;
	}

	@keyframes base-modal-from-right {
		from {
			opacity: 0;
			translate: 8px 0;
		}
	}

	/* The desktop app's titlebar stays visible above every dialog. */
	:global(:root[data-desktop-shell='true']) .base-modal-scrim,
	:global(:root[data-desktop-shell='true']) .base-modal {
		top: var(--desktop-titlebar-height, 0px);
	}
	:global(:root[data-desktop-shell='true']) .base-modal--center {
		max-height: calc(var(--desktop-content-height, 100dvh) - 64px);
	}
	:global(:root[data-desktop-shell='true']) :is(.base-modal--right-panel, .base-modal--full-screen) {
		height: var(--desktop-content-height, 100dvh);
	}

	@media (pointer: coarse) {
		.base-modal__close,
		.w-dialog__close {
			width: 44px;
			height: 44px;
		}
		.base-modal__close {
			top: 10px;
			right: 10px;
		}
	}
</style>
