<script lang="ts">
	import type { Message } from '$lib/socket';
	import { currentUser } from '$lib/socket';

	export let message: Message;
	export let x: number = 0;
	export let y: number = 0;
	export let visible: boolean = false;
	export let onEdit: () => void;
	export let onDelete: () => void;
	export let onPin: () => void;
	export let onReply: () => void;
	export let onDownload: (() => void) | undefined = undefined;
	export let onForward: (() => void) | undefined = undefined;
	export let onAddReaction: (() => void) | undefined = undefined;

	$: isOwnMessage = message.userId === $currentUser?.id;
	$: hasFile = message.type === 'file' && message.fileUrl;

	let menuElement: HTMLDivElement;

	// Adjust position to keep menu on screen
	$: adjustedX = (() => {
		if (!menuElement) return x;
		const menuWidth = menuElement.offsetWidth || 200; // fallback width
		const windowWidth = window.innerWidth;
		// If menu would go off right edge, flip to left
		if (x + menuWidth > windowWidth) {
			return x - menuWidth;
		}
		return x;
	})();

	$: adjustedY = (() => {
		if (!menuElement) return y;
		const menuHeight = menuElement.offsetHeight || 300; // fallback height
		const windowHeight = window.innerHeight;
		// If menu would go off bottom edge, flip to top
		if (y + menuHeight > windowHeight) {
			return y - menuHeight;
		}
		return y;
	})();
</script>

{#if visible}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="context-menu-overlay"
		on:click={() => (visible = false)}
	>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			bind:this={menuElement}
			class="context-menu"
			style="top: {adjustedY}px; left: {adjustedX}px;"
			on:click|stopPropagation
		>
			<button class="menu-item" on:click={onReply}>
				<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
				Reply
			</button>

			{#if onAddReaction}
				<button class="menu-item" on:click={onAddReaction}>
					<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
					Add Reaction
				</button>
			{/if}

			{#if hasFile && onDownload}
				<button class="menu-item" on:click={onDownload}>
					<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
					Download
				</button>
			{/if}

			{#if onForward}
				<button class="menu-item" on:click={onForward}>
					<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
					Forward
				</button>
			{/if}

			{#if isOwnMessage}
				<button class="menu-item" on:click={onEdit}>
					<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
					Edit Message
				</button>
			{/if}

			<button class="menu-item" on:click={onPin}>
				<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5M9 8h6"></path></svg>
				{message.isPinned ? 'Unpin' : 'Pin'} Message
			</button>

			<button class="menu-item copy" on:click={() => {
				navigator.clipboard.writeText(message.text);
				visible = false;
			}}>
				<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
				Copy Text
			</button>

			{#if isOwnMessage}
				<div class="menu-divider"></div>
				<button class="menu-item delete" on:click={onDelete}>
					<svg class="menu-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
					Delete Message
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.context-menu-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 999;
	}

	.context-menu {
		position: fixed;
		background: #2b2d31;
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		padding: 0.5rem;
		min-width: 200px;
		z-index: 1000;
		border: 2px solid #5865f2;
	}

	.menu-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.95rem;
		font-weight: 500;
		color: #dbdee1;
		text-align: left;
		transition: all 0.15s ease;
	}

	.menu-item:hover {
		background: #5865f2;
		color: #ffffff;
		font-weight: 600;
	}

	.menu-item.delete {
		color: #f23f43;
	}

	.menu-item.delete:hover {
		background: #da373c;
		color: #ffffff;
	}

	.menu-icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		stroke: currentColor;
		stroke-width: 2;
	}

	.menu-divider {
		height: 2px;
		background: #404249;
		margin: 0.5rem 0;
	}
</style>
