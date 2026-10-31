<!--
	The selection bubble (design contract §7.15, kit `.w-tool--bubble`, no shadow): Bold, Italic,
	Strikethrough | Link (Ctrl Shift K), Inline code, and | Comment on a shared document. It
	appears for a non-empty selection, 8px below the selection's last line box, left-aligned to
	its start, and flips above when fewer than 52px remain below inside the scroll viewport, so it
	never covers the selected words. Pointer presses never take focus from the editor; Alt F10
	moves focus into it (arrow keys move between keys, Esc goes back to the text).

	One bubble for every writing surface: WritingFrame renders it for the wiki, Notes and
	Documents.
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { formatSelection, linkAtSelection } from './writingSurface';
	import { placeSelectionBubble, type Box, type InlineMark } from './writingMarkdown';
	import type { WritingController } from './writingController.svelte';

	interface Props {
		controller: WritingController;
		/** The positioned frame the bubble is placed in (its coordinates are the bubble's origin). */
		host: HTMLElement | null;
		readonly?: boolean;
		/** Comment on the selection (shared documents only). */
		oncomment?: () => void;
	}

	let { controller, host, readonly = false, oncomment }: Props = $props();

	let bubble = $state<HTMLDivElement | null>(null);
	let bubbleFocused = $state(false);
	let keyIndex = $state(0);

	const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

	type Key = { id: InlineMark | 'link' | 'comment'; label: string; icon: IconName; shortcut?: string };
	const FORMAT: readonly (Key | null)[] = [
		{ id: 'bold', label: 'Bold', icon: 'bold', shortcut: `${mod} B` },
		{ id: 'italic', label: 'Italic', icon: 'italic', shortcut: `${mod} I` },
		{ id: 'strike', label: 'Strikethrough', icon: 'strike', shortcut: `${mod} Shift X` },
		null,
		{ id: 'link', label: 'Link', icon: 'link', shortcut: `${mod} Shift K` },
		{ id: 'code', label: 'Inline code', icon: 'code', shortcut: `${mod} E` }
	];
	const keys = $derived<readonly (Key | null)[]>(oncomment ? [...FORMAT, null, { id: 'comment', label: 'Comment', icon: 'chat' }] : FORMAT);
	const activeKeys = $derived(keys.filter((key): key is Key => key !== null));

	const shown = $derived(!readonly && (controller.selection !== null || (bubbleFocused && controller.lastSelection !== null)));
	const marks = $derived((controller.selection ?? controller.lastSelection)?.marks ?? { bold: false, italic: false, strike: false, code: false });

	function focusBubble(): boolean {
		if (!controller.selection || !bubble) return false;
		keyIndex = 0;
		bubble.querySelectorAll<HTMLButtonElement>('button')[0]?.focus();
		return true;
	}
	$effect(() => {
		controller.focusBubble = focusBubble;
		return () => {
			controller.focusBubble = () => false;
		};
	});

	/** The visible part of the nearest scroller (or the window) around the editor. */
	function scrollViewport(node: HTMLElement): Box {
		const win: Box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
		for (let parent = node.parentElement; parent; parent = parent.parentElement) {
			const { overflowY } = getComputedStyle(parent);
			if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
				const rect = parent.getBoundingClientRect();
				return { left: Math.max(rect.left, win.left), top: Math.max(rect.top, win.top), right: Math.min(rect.right, win.right), bottom: Math.min(rect.bottom, win.bottom) };
			}
		}
		return win;
	}

	let position = $state<{ left: number; top: number; above: boolean } | null>(null);
	$effect(() => {
		const current = controller.selection ?? (bubbleFocused ? controller.lastSelection : null);
		const node = host;
		const element = bubble;
		if (!current || !node || !shown) {
			position = null;
			return;
		}
		const frame = node.getBoundingClientRect();
		const size = { width: element?.offsetWidth || 196, height: element?.offsetHeight || 36 };
		const placed = placeSelectionBubble(current.start, current.end, scrollViewport(node), size);
		position = { left: placed.left - frame.left, top: placed.top - frame.top, above: placed.above };
	});

	function run(id: Key['id']) {
		const view = controller.view;
		if (!view || readonly) return;
		if (id === 'comment') oncomment?.();
		else if (id === 'link') linkAtSelection(view);
		else formatSelection(view, id);
	}

	function bubbleKeydown(event: KeyboardEvent) {
		const count = activeKeys.length;
		let next = keyIndex;
		if (event.key === 'ArrowRight') next = (keyIndex + 1) % count;
		else if (event.key === 'ArrowLeft') next = (keyIndex - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			bubbleFocused = false;
			controller.focus();
			return;
		} else return;
		event.preventDefault();
		keyIndex = next;
		bubble?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
	}
</script>

{#if shown}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="w-tool w-tool--bubble writing-bubble"
		class:above={position?.above}
		role="toolbar"
		aria-label="Format selection"
		aria-orientation="horizontal"
		tabindex="-1"
		bind:this={bubble}
		style:left={position ? `${position.left}px` : undefined}
		style:top={position ? `${position.top}px` : undefined}
		style:visibility={position ? undefined : 'hidden'}
		onmousedown={(event) => event.preventDefault()}
		onfocusin={() => (bubbleFocused = true)}
		onfocusout={(event) => {
			if (!bubble?.contains(event.relatedTarget as Node | null)) bubbleFocused = false;
		}}
		onkeydown={bubbleKeydown}
	>
		{#each keys as key}
			{#if key}
				{@const index = activeKeys.indexOf(key)}
				<Tooltip text={key.label} shortcut={key.shortcut} placement={position?.above ? 'top' : 'bottom'}>
					<button
						type="button"
						class="w-ibtn"
						aria-label={key.label}
						aria-pressed={key.id === 'link' || key.id === 'comment' ? undefined : marks[key.id]}
						tabindex={index === keyIndex ? 0 : -1}
						onclick={() => run(key.id)}
					><Icon name={key.icon} /></button>
				</Tooltip>
			{:else}
				<span class="w-tool__sep" aria-hidden="true"></span>
			{/if}
		{/each}
	</div>
{/if}

<style>
	/* Kit .w-tool--bubble (no shadow), above the text, 30px keys (§7.15). */
	.writing-bubble {
		position: absolute;
		z-index: var(--z-dropdown, 20);
		animation: writing-bubble-in var(--w-dur-2) var(--w-ease);
	}
	.writing-bubble .w-ibtn {
		width: 30px;
		height: 30px;
	}
	.writing-bubble .w-ibtn:focus-visible {
		outline-offset: -2px;
	}
	@keyframes writing-bubble-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}
	.writing-bubble.above {
		animation-name: writing-bubble-in-above;
	}
	@keyframes writing-bubble-in-above {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.writing-bubble {
			animation: none;
		}
	}
	:global(:root[data-motion='reduce']) .writing-bubble {
		animation: none;
	}
	@media (pointer: coarse) {
		.writing-bubble .w-ibtn {
			width: 44px;
			height: 44px;
		}
	}
</style>
