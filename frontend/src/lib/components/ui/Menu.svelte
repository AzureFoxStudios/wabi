<!--
	Button menu (design contract §7.4): a trigger button that opens the one menu
	(context-menu/ContextMenu.svelte) anchored under it, so right-click menus and button menus
	share rows, keyboard and phone sheet.

	- The trigger is a real <button> with aria-haspopup="menu", aria-expanded and aria-controls.
	  Click, Enter, Space or ↓ open the menu (focus on the first row from the keyboard), ↑ opens it
	  on the last row; Esc or Tab close it and focus returns to the trigger.
	- The menu opens below the trigger, aligned to its start (or end), and flips above when there
	  is more room there. On phones (≤768px) it opens as a bottom sheet titled by `heading`.

	<Menu label="Message actions" triggerLabel="More actions" class="w-ibtn" align="end"
	      items={[{ id: 'copy', label: 'Copy text', icon: 'copy', onSelect: copy }, …]}>
	  <Icon name="more" />
	</Menu>

	For an existing trigger element, pass `anchor={element}` and drive `bind:open` yourself.
-->
<script module lang="ts">
	let menuButtonCounter = 0;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import ContextMenu, { type MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';

	interface Props extends Omit<HTMLButtonAttributes, 'children' | 'onselect' | 'class'> {
		items: MenuEntry[];
		/** Accessible name of the menu itself ("Message actions"). */
		label: string;
		/** Trigger content: words, an Icon, or both. */
		children?: Snippet;
		/** Trigger classes (kit: `w-ibtn`, `w-btn w-btn--quiet`, …). */
		class?: string;
		/** aria-label for an icon-only trigger. */
		triggerLabel?: string;
		align?: 'start' | 'end';
		/** Names the object the menu acts on (above the rows; the phone sheet's title). */
		heading?: string | null;
		subheading?: string | null;
		open?: boolean;
		disabled?: boolean;
		/** An element outside this component to anchor to (no trigger is rendered). */
		anchor?: HTMLElement | null;
		minWidth?: number;
		onselect?: (id: string) => void;
		onopenchange?: (open: boolean) => void;
	}

	let {
		items,
		label,
		children,
		class: className = 'w-ibtn',
		triggerLabel,
		align = 'start',
		heading = null,
		subheading = null,
		open = $bindable(false),
		disabled = false,
		anchor = null,
		minWidth = 220,
		onselect,
		onopenchange,
		...rest
	}: Props = $props();

	const menuId = `w-menu-btn-${++menuButtonCounter}`;
	let trigger = $state<HTMLButtonElement | null>(null);
	let rect = $state<{ left: number; top: number; right: number; bottom: number } | null>(null);
	let focusMode = $state<'auto' | 'first' | 'last'>('auto');

	const anchorElement = $derived(anchor ?? trigger);

	function measure() {
		const box = anchorElement?.getBoundingClientRect();
		rect = box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
	}

	function setOpen(next: boolean, mode: 'auto' | 'first' | 'last' = 'auto') {
		if (next === open) return;
		if (next) {
			focusMode = mode;
			measure();
		}
		open = next;
		onopenchange?.(next);
	}

	// An externally driven menu (bind:open with `anchor`) measures its anchor when it opens.
	$effect(() => {
		if (open && !rect) measure();
		if (!open) rect = null;
	});

	function handleClick(event: MouseEvent) {
		if (disabled) return;
		// detail 0: the click came from Enter/Space, so the keyboard user lands on the first row.
		setOpen(!open, event.detail === 0 ? 'first' : 'auto');
	}

	function handleKeydown(event: KeyboardEvent) {
		if (disabled) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			setOpen(true, event.key === 'ArrowUp' ? 'last' : 'first');
		}
	}
</script>

{#if !anchor}
	<button
		{...rest}
		bind:this={trigger}
		type="button"
		class={className}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={open ? menuId : undefined}
		aria-label={triggerLabel}
		{disabled}
		onclick={handleClick}
		onkeydown={handleKeydown}
	>
		{@render children?.()}
	</button>
{/if}

<ContextMenu
	open={open && !!rect}
	{items}
	anchor={rect}
	{align}
	{minWidth}
	{menuId}
	ariaLabel={label}
	headerLabel={heading}
	headerSubLabel={subheading}
	initialFocus={focusMode}
	returnFocus={anchorElement}
	onClose={() => setOpen(false)}
	onSelectItem={(id) => onselect?.(id)}
/>
