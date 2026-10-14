<!--
	Bottom sheet (design contract §7.13, §8.12): phones and the phone shell up to 768px.

	- Kit `.w-sheet` (--radius-xl top corners, --w-bg2 / Daylight --w-lift, --w-line-strong,
	  --w-shadow) over a `.w-scrim` that is a sibling element, never a ::before of the sheet.
	- 36×4 grabber and a 20px serif title; the bottom padding includes
	  env(safe-area-inset-bottom). Rows inside use `.w-sheet__row` (52px).
	- role=dialog + aria-modal, named by the title; focus is trapped (modalFocus), Esc and the
	  scrim close it, focus returns to the opener. Dragging the grabber/title band down more than
	  a quarter of the sheet's height (or 96px) dismisses it.

	<Sheet bind:open title="Workspaces" onclose={…}>
	  <button class="w-sheet__row">…</button>
	</Sheet>
-->
<script module lang="ts">
	let sheetCounter = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { modalFocus } from '$lib/actions/modalFocus';
	import { portal } from '$lib/actions/portal';

	interface Props {
		open?: boolean;
		/** Serif title; also the sheet's accessible name. */
		title?: string;
		/** Accessible name when there is no visible title. */
		label?: string;
		children: Snippet;
		/** Pinned under the scrolling body (a primary action, a "Done"). */
		footer?: Snippet;
		/** Stacking level of the scrim; the sheet sits one above it. */
		zIndex?: number | string;
		class?: string;
		onclose?: () => void;
	}

	let {
		open = $bindable(false),
		title,
		label,
		children,
		footer,
		zIndex,
		class: className = '',
		onclose
	}: Props = $props();

	const titleId = `w-sheet-title-${++sheetCounter}`;
	let sheet = $state<HTMLDivElement | null>(null);
	let dragStart = $state<number | null>(null);
	let dragY = $state(0);

	const portalTarget =
		typeof document !== 'undefined' ? ((document.fullscreenElement as HTMLElement | null) ?? document.body) : undefined;

	function close() {
		if (!open) return;
		open = false;
		dragY = 0;
		dragStart = null;
		onclose?.();
	}

	function startDrag(event: PointerEvent) {
		if (event.button !== 0) return;
		dragStart = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function moveDrag(event: PointerEvent) {
		if (dragStart === null) return;
		dragY = Math.max(0, event.clientY - dragStart);
	}

	function endDrag() {
		if (dragStart === null) return;
		const height = sheet?.offsetHeight ?? 0;
		const dismiss = dragY > Math.min(96, height / 4);
		dragStart = null;
		if (dismiss) close();
		else dragY = 0;
	}
</script>

{#if open}
	<div class="sheet-layer" style:--sheet-z={zIndex} use:portal={portalTarget}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="w-scrim sheet-scrim" onclick={close}></div>
		<div
			bind:this={sheet}
			class="w-sheet sheet {className}"
			class:sheet--dragging={dragStart !== null}
			style:translate={dragY ? `0 ${dragY}px` : undefined}
			role="dialog"
			aria-modal="true"
			aria-labelledby={title ? titleId : undefined}
			aria-label={title ? undefined : label}
			tabindex="-1"
			use:modalFocus={close}
		>
			<!-- Dragging is a pointer shortcut; Esc, the scrim and the content's own buttons close it too. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="sheet__handle"
				onpointerdown={startDrag}
				onpointermove={moveDrag}
				onpointerup={endDrag}
				onpointercancel={endDrag}
			>
				<div class="w-sheet__grabber" aria-hidden="true"></div>
				{#if title}<h2 class="w-sheet__title" id={titleId}>{title}</h2>{/if}
			</div>
			<div class="w-sheet__body">
				{@render children()}
			</div>
			{#if footer}
				<div class="sheet__foot">{@render footer()}</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.sheet-layer {
		display: contents;
	}
	.sheet-scrim {
		z-index: var(--sheet-z, var(--z-modal, 1500));
	}
	.sheet {
		z-index: calc(var(--sheet-z, var(--z-modal, 1500)) + 1);
		outline: none;
		transition: translate var(--w-dur-3) var(--w-ease);
	}
	.sheet--dragging {
		transition: none;
	}
	/* The grabber band is the drag target; the title stays a heading, not a button. */
	.sheet__handle {
		flex: none;
		touch-action: none;
		cursor: grab;
	}
	.sheet--dragging .sheet__handle {
		cursor: grabbing;
	}
	.sheet__handle .w-sheet__title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sheet__foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		flex: none;
		padding: 12px 20px;
		border-top: var(--w-bw) solid var(--w-line);
	}
</style>
