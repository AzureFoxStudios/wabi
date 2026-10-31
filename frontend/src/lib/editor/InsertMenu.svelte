<!--
	Insert (design contract §8.8, D22): how blocks get onto a writing page.

	- The block handle: a 24px quiet `+` in the margin beside the caret's block (`--w-faint`,
	  `--radius-inner`, hover `--w-raise`), on wide pages (`hang`) and never on a heading line,
	  whose marker already hangs there. A pointer press keeps the caret in the text; Tab from the
	  text reaches it, Enter opens the menu.
	- `/` typed on an empty line opens the same menu at the handle; choosing an entry replaces the
	  `/` with the block (one undo step), Esc leaves the `/` as typed and returns to the text.
	- The menu: Paragraph, Heading 2/3, Bulleted and Numbered list, Checklist, Quote, Divider,
	  Code block, Table, Schedule table, and Image… when the host can upload one.
	- Phones: while the text has focus, a 44px bar docks above the keyboard (above the bottom nav
	  when no keyboard is up): Insert ▾, Bold, Italic, Link, Bulleted list, Checklist.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { clearSlash, formatSelection, insertAtSelection, insertAtSlash, linkAtSelection } from './writingSurface';
	import { INSERT_KINDS, type InsertKind } from './writingMarkdown';
	import type { WritingController } from './writingController.svelte';

	interface Props {
		controller: WritingController;
		host: HTMLElement | null;
		/** A wide page with a margin: the `+` handle shows beside the caret's block. */
		hang?: boolean;
		/** A phone: the Insert bar docks above the keyboard while the text has focus. */
		phone?: boolean;
		/** Upload an image and insert its Markdown (the host's own picker). */
		onimage?: () => void;
		imageBusy?: boolean;
	}

	let { controller, host, hang = false, phone = false, onimage, imageBusy = false }: Props = $props();

	let handle = $state<HTMLButtonElement | null>(null);
	let open = $state(false);
	let barOpen = $state(false);
	let fromSlash = false;
	let chose = false;
	let handleFocused = $state(false);
	let barFocused = $state(false);

	function choose(kind: InsertKind) {
		const view = controller.view;
		chose = true;
		if (!view) return;
		if (fromSlash) insertAtSlash(view, kind);
		else insertAtSelection(view, kind);
	}

	const items = $derived<MenuEntry[]>([
		...INSERT_KINDS.map(({ kind, label, icon }) => ({ id: `insert-${kind}`, label, icon, onSelect: () => choose(kind) })),
		...(onimage
			? [
					{ id: 'insert-sep', type: 'separator', label: '' } satisfies MenuEntry,
					{ id: 'insert-image', label: imageBusy ? 'Uploading image…' : 'Image…', icon: 'image', disabled: imageBusy, onSelect: () => { chose = true; if (fromSlash && controller.view) clearSlash(controller.view); onimage?.(); } } satisfies MenuEntry
				]
			: [])
	]);

	// The caret's line, kept while focus is on the handle or in its menu.
	const caret = $derived(controller.caret ?? (handleFocused || open ? controller.lastCaret : null));
	const handleShown = $derived(hang && !phone && caret !== null && !caret.heading);
	let handleTop = $state(0);
	$effect(() => {
		const line = caret;
		const frame = host;
		if (!line || !frame) return;
		handleTop = (line.top + line.bottom) / 2 - 12 - frame.getBoundingClientRect().top;
	});

	// `/` on an empty line: the same menu, opened at the handle.
	let seenSlash = untrack(() => controller.slash);
	$effect(() => {
		const count = controller.slash;
		if (count === seenSlash) return;
		seenSlash = count;
		fromSlash = true;
		chose = false;
		open = true;
	});

	function menuChanged(next: boolean) {
		if (next) return;
		const leftFocus = document.activeElement;
		const back = !chose;
		fromSlash = false;
		chose = false;
		// Closed without a choice (Esc): back to the text, unless the person clicked elsewhere.
		if (back) requestAnimationFrame(() => {
			const active = document.activeElement;
			if (!active || active === document.body || active === handle || active === leftFocus) controller.focus();
		});
	}

	function openFromHandle() {
		fromSlash = false;
		chose = false;
		open = !open;
	}

	// ---- the phone bar ----
	let keyboard = $state(0);
	const barShown = $derived(phone && (controller.caret !== null || barFocused || barOpen));
	$effect(() => {
		controller.bottomRoom = barShown ? 56 : 0;
	});
	onMount(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const measure = () => {
			keyboard = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
		};
		measure();
		viewport.addEventListener('resize', measure);
		viewport.addEventListener('scroll', measure);
		return () => {
			viewport.removeEventListener('resize', measure);
			viewport.removeEventListener('scroll', measure);
			controller.bottomRoom = 0;
		};
	});

	type BarKey = { id: string; label: string; icon: IconName; run: () => void };
	const BAR: readonly BarKey[] = [
		{ id: 'bold', label: 'Bold', icon: 'bold', run: () => controller.view && formatSelection(controller.view, 'bold') },
		{ id: 'italic', label: 'Italic', icon: 'italic', run: () => controller.view && formatSelection(controller.view, 'italic') },
		{ id: 'link', label: 'Link', icon: 'link', run: () => controller.view && linkAtSelection(controller.view) },
		{ id: 'bullet', label: 'Bulleted list', icon: 'list', run: () => controller.view && insertAtSelection(controller.view, 'bullet') },
		{ id: 'checklist', label: 'Checklist', icon: 'checkSquare', run: () => controller.view && insertAtSelection(controller.view, 'checklist') }
	];
</script>

<button
	type="button"
	class="writing-handle"
	class:shown={handleShown}
	style:top={`${handleTop}px`}
	tabindex={handleShown ? 0 : -1}
	aria-hidden={handleShown ? undefined : 'true'}
	aria-label="Insert block"
	aria-haspopup="menu"
	aria-expanded={open}
	bind:this={handle}
	onmousedown={(event) => event.preventDefault()}
	onfocus={() => (handleFocused = true)}
	onblur={() => (handleFocused = false)}
	onclick={openFromHandle}
><Icon name="plus" size={16} /></button>

<Menu {items} label="Insert" heading="Insert" anchor={handle} bind:open onopenchange={menuChanged} />

{#if barShown}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="writing-bar"
		role="toolbar"
		aria-label="Writing tools"
		tabindex="-1"
		style:bottom={keyboard > 80 ? `${keyboard}px` : undefined}
		onmousedown={(event) => event.preventDefault()}
		onfocusin={() => (barFocused = true)}
		onfocusout={(event) => {
			if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) barFocused = false;
		}}
	>
		<Menu class="w-btn w-btn--quiet writing-bar__insert" {items} label="Insert" heading="Insert" bind:open={barOpen} onopenchange={(next) => { if (next) { fromSlash = false; chose = false; } else menuChanged(false); }}>
			Insert<Icon name="chevDown" size={16} />
		</Menu>
		<span class="w-tool__sep" aria-hidden="true"></span>
		{#each BAR as key (key.id)}
			<button type="button" class="w-ibtn" aria-label={key.label} onclick={key.run}><Icon name={key.icon} /></button>
		{/each}
	</div>
{/if}

<style>
	/* The block handle: 24px, quiet, in the margin: its right edge 24px left of the text, inside
	   the 48px a hanging page keeps free beside its column (design contract §8.8). */
	.writing-handle {
		position: absolute;
		left: calc(var(--writing-text-start, 0px) - 48px);
		z-index: 2;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-inner, var(--radius-sm));
		background: transparent;
		color: var(--w-faint);
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--w-dur-1) var(--w-ease), background-color var(--w-dur-1) var(--w-ease);
	}
	.writing-handle.shown {
		opacity: 1;
		pointer-events: auto;
	}
	.writing-handle:hover,
	.writing-handle[aria-expanded='true'] {
		background: var(--w-raise);
		color: var(--w-text);
	}
	.writing-handle:focus-visible {
		opacity: 1;
		outline: 2px solid var(--w-accent);
		outline-offset: 1px;
	}
	:global(:root[data-theme='high-contrast']) .writing-handle:hover {
		box-shadow: inset 0 0 0 var(--w-bw) var(--w-line-strong);
	}

	/* The phone bar: 44px, above the keyboard (or the bottom nav when no keyboard is up). */
	.writing-bar {
		position: fixed;
		right: 0;
		bottom: var(--mobile-nav-height, 0px);
		left: 0;
		z-index: var(--z-dropdown, 20);
		display: flex;
		align-items: center;
		gap: 2px;
		box-sizing: border-box;
		height: 44px;
		padding: 0 8px;
		border-top: var(--w-bw) solid var(--w-line-strong);
		background: var(--w-bg2);
	}
	.writing-bar .w-ibtn {
		width: 44px;
		height: 44px;
	}
	.writing-bar :global(.writing-bar__insert) {
		min-height: 44px;
		gap: 4px;
	}
	.writing-bar .w-tool__sep {
		height: 20px;
		margin: 0 4px;
	}
	@media (prefers-reduced-motion: reduce) {
		.writing-handle {
			transition: none;
		}
	}
</style>
