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

	function getIconSvg(icon: ContextMenuItem['icon']): string {
		switch (icon) {
			case 'message-circle':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.2 8.2 0 0 1-3.6-.8L3 21l1.8-5.4a8.4 8.4 0 0 1-.8-3.6A8.5 8.5 0 1 1 21 11.5z"></path></svg>';
			case 'phone':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19 19.5 19.5 0 0 1 5 12.8 19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.8 2.8a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.4-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.7 2.8.8A2 2 0 0 1 22 16.9z"></path></svg>';
			case 'video':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>';
			case 'monitor':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>';
			case 'user':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle></svg>';
			case 'pin':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>';
			case 'settings':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg>';
			case 'trash-2':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
			case 'smile':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>';
			case 'download':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
			case 'forward':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-2a7 7 0 0 0-7-7H4"></path></svg>';
			case 'edit':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
			case 'copy':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
			case 'credit-card':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path><path d="M7 15h3"></path></svg>';
			case 'archive':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="4" rx="1"></rect><path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"></path><line x1="10" y1="12" x2="14" y2="12"></line></svg>';
			case 'archive-restore':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="4" rx="1"></rect><path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"></path><polyline points="9 13 12 10 15 13"></polyline></svg>';
			case 'banknote':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle><path d="M6 9h.01"></path><path d="M18 15h.01"></path></svg>';
			case 'log-out':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>';
			case 'languages':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>';
			case 'external-window':
				return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
			default:
				return '';
		}
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
					<div class="menu-separator" role="separator"></div>
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
							{#if item.icon}
								<span class="menu-leading menu-leading-icon" aria-hidden="true">
									{@html getIconSvg(item.icon)}
								</span>
							{:else if item.leading}
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
		z-index: var(--z-floating-ui);
	}

	.context-menu-surface {
		position: fixed;
		background: var(--surface-base, #2b2d31);
		border: 1px solid var(--border-subtle, #404249);
		border-radius: 8px;
		padding: 6px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
		outline: none;
		max-width: min(360px, calc(100vw - 16px));
		color: var(--text-heading, #f2f3f5);
	}

	.menu-header {
		padding: 6px 10px 8px;
		border-bottom: 1px solid var(--border-subtle, #404249);
		margin-bottom: 4px;
	}

	.menu-header-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-heading, #f2f3f5);
	}

	.menu-header-sub {
		font-size: 0.75rem;
		color: var(--text-secondary, #b5bac1);
		color: color-mix(in srgb, var(--text-heading, #f2f3f5) 72%, transparent);
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
		color: var(--text-heading, #dbdee1);
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

	.menu-leading-icon {
		align-items: center;
	}

	.menu-leading-icon :global(svg) {
		width: 15px;
		height: 15px;
		display: block;
	}

	.menu-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.menu-hint {
		font-size: 0.75rem;
		color: var(--text-secondary, #b5bac1);
		color: color-mix(in srgb, var(--text-heading, #f2f3f5) 70%, transparent);
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
		opacity: 0.75;
		cursor: not-allowed;
		color: var(--text-secondary, #b5bac1);
		color: color-mix(in srgb, var(--text-heading, #f2f3f5) 60%, transparent);
	}

	.menu-item:disabled:hover,
	.menu-item:disabled:focus-visible {
		background: none;
		color: var(--text-heading, #dbdee1);
	}

	.menu-separator {
		height: 1px;
		background: var(--border-subtle, #404249);
		margin: 6px 4px;
	}

	@media (max-width: 768px) {
		.context-menu-surface {
			left: 8px !important;
			right: 8px;
			top: auto !important;
			bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);
			width: auto;
			max-width: none;
			min-width: 0 !important;
			max-height: min(70dvh, 560px);
			overflow-y: auto;
			border-radius: 12px;
		}

		.menu-header {
			position: sticky;
			top: 0;
			background: var(--surface-base, #2b2d31);
			z-index: 1;
		}

		.menu-item {
			min-height: 44px;
			font-size: 1rem;
		}
	}
</style>
