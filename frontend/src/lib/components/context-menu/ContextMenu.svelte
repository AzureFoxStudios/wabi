<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';

	export let open = false;
	export let x = 0;
	export let y = 0;
	export let items: ContextMenuItem[] = [];
	export let minWidth = 220;
	export let ariaLabel = 'Context menu';
	export let headerLabel: string | null = null;
	export let headerSubLabel: string | null = null;

	const dispatch = createEventDispatcher<{
		close: void;
		select: { id: string };
	}>();

	let menuElement: HTMLDivElement | null = null;
	let focusedIndex = -1;

	$: visibleItems = items.filter((item) => !item.hidden);
	$: actionableItems = visibleItems.filter((item) => item.type !== 'separator');

	$: adjustedPosition = getAdjustedPosition(x, y, menuElement);
	$: if (open) {
		void focusFirstItem();
	}

	function getMenuItems(): HTMLButtonElement[] {
		if (!menuElement) return [];
		return Array.from(menuElement.querySelectorAll<HTMLButtonElement>('.menu-item'));
	}

	function getAdjustedPosition(rawX: number, rawY: number, element: HTMLDivElement | null) {
		const margin = 8;
		const width = element?.offsetWidth || minWidth;
		const height = element?.offsetHeight || 280;
		const maxX = window.innerWidth - width - margin;
		const maxY = window.innerHeight - height - margin;

		return {
			x: Math.max(margin, Math.min(rawX, maxX)),
			y: Math.max(margin, Math.min(rawY, maxY))
		};
	}

	async function focusFirstItem() {
		await tick();
		const menuItems = getMenuItems();
		const firstEnabledIndex = actionableItems.findIndex((item) => !item.disabled);
		focusedIndex = firstEnabledIndex;
		if (firstEnabledIndex >= 0) {
			menuItems[firstEnabledIndex]?.focus();
		} else {
			menuElement?.focus();
		}
	}

	function closeMenu() {
		dispatch('close');
	}

	function focusByDirection(direction: 1 | -1) {
		if (actionableItems.length === 0) return;
		const menuItems = getMenuItems();

		let nextIndex = focusedIndex;
		for (let i = 0; i < actionableItems.length; i += 1) {
			nextIndex = nextIndex < 0 ? 0 : (nextIndex + direction + actionableItems.length) % actionableItems.length;
			if (!actionableItems[nextIndex].disabled) {
				focusedIndex = nextIndex;
				menuItems[nextIndex]?.focus();
				return;
			}
		}
	}

	async function selectItem(item: ContextMenuItem) {
		if (item.type === 'separator' || item.disabled) return;
		if (item.onSelect) {
			await item.onSelect();
		}
		dispatch('select', { id: item.id });
		if (!item.keepOpen) {
			closeMenu();
		}
	}

	function handleMenuKeydown(event: KeyboardEvent) {
		if (!open) return;

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusByDirection(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusByDirection(-1);
				break;
			case 'Escape':
				event.preventDefault();
				closeMenu();
				break;
			case 'Tab':
				closeMenu();
				break;
			default:
				break;
		}
	}

	function handleWindowContextMenu(event: MouseEvent) {
		if (!open || !menuElement) return;
		// If another handler already claimed this event (e.g. opening a new menu),
		// don't interfere with that flow.
		if (event.defaultPrevented) return;
		if (event.target instanceof Node && menuElement.contains(event.target)) return;
		event.preventDefault();
		closeMenu();
	}
</script>

<svelte:window on:keydown={handleMenuKeydown} on:contextmenu={handleWindowContextMenu} />

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="context-menu-overlay" on:mousedown={closeMenu}>
		<div
			bind:this={menuElement}
			class="context-menu-surface"
			style:left="{adjustedPosition.x}px"
			style:top="{adjustedPosition.y}px"
			style:min-width="{minWidth}px"
			role="menu"
			aria-label={ariaLabel}
			tabindex="-1"
			on:mousedown|stopPropagation
		>
			{#if headerLabel}
				<div class="menu-header">
					<div class="menu-header-label">{headerLabel}</div>
					{#if headerSubLabel}
						<div class="menu-header-sub">{headerSubLabel}</div>
					{/if}
				</div>
			{/if}

			{#each visibleItems as item}
				{#if item.type === 'separator'}
					<div class="menu-separator" role="separator" />
				{:else}
					{@const actionableIndex = actionableItems.findIndex((entry) => entry.id === item.id)}
					<button
						type="button"
						class="menu-item"
						class:danger={item.danger}
						disabled={item.disabled}
						role="menuitem"
						tabindex={focusedIndex === actionableIndex ? 0 : -1}
						on:focus={() => (focusedIndex = actionableIndex)}
						on:mouseenter={() => {
							focusedIndex = actionableIndex;
						}}
						on:click={() => selectItem(item)}
					>
						<span class="menu-item-main">
							{#if item.leading}
								<span class="menu-leading" aria-hidden="true">{item.leading}</span>
							{/if}
							<span class="menu-label">{item.label}</span>
						</span>
						{#if item.hint}
							<span class="menu-hint">{item.hint}</span>
						{/if}
					</button>
				{/if}
			{/each}
		</div>
	</div>
{/if}

<style>
	.context-menu-overlay {
		position: fixed;
		inset: 0;
		z-index: 1100;
	}

	.context-menu-surface {
		position: fixed;
		background: var(--bg-secondary, #2b2d31);
		border: 1px solid var(--border, #404249);
		border-radius: 8px;
		padding: 6px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
		outline: none;
		max-width: min(360px, calc(100vw - 16px));
	}

	.menu-header {
		padding: 6px 10px 8px;
		border-bottom: 1px solid var(--border, #404249);
		margin-bottom: 4px;
	}

	.menu-header-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary, #f2f3f5);
	}

	.menu-header-sub {
		font-size: 0.75rem;
		color: var(--text-secondary, #b5bac1);
		margin-top: 2px;
	}

	.menu-item {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 9px 10px;
		background: none;
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--text-primary, #dbdee1);
		text-align: left;
	}

	.menu-item-main {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.menu-leading {
		opacity: 0.9;
		width: 1.1rem;
		display: inline-flex;
		justify-content: center;
	}

	.menu-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.menu-hint {
		font-size: 0.75rem;
		color: var(--text-secondary, #b5bac1);
	}

	.menu-item:hover,
	.menu-item:focus-visible {
		background: var(--accent, #5865f2);
		color: #fff;
	}

	.menu-item:hover .menu-hint,
	.menu-item:focus-visible .menu-hint {
		color: rgba(255, 255, 255, 0.85);
	}

	.menu-item.danger {
		color: var(--color-danger, #f23f43);
	}

	.menu-item.danger:hover,
	.menu-item.danger:focus-visible {
		background: var(--color-danger, #f23f43);
		color: #fff;
	}

	.menu-item:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.menu-item:disabled:hover,
	.menu-item:disabled:focus-visible {
		background: none;
		color: var(--text-primary, #dbdee1);
	}

	.menu-separator {
		height: 1px;
		background: var(--border, #404249);
		margin: 6px 4px;
	}

	@media (max-width: 768px) {
		.menu-item {
			min-height: 44px;
			font-size: 1rem;
		}
	}
</style>
