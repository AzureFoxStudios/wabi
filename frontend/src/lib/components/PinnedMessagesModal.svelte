<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import type { Message, User } from '$lib/socket';
	import { users, channels, channelMessages, togglePinMessage } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { _ } from '$lib/i18n';

	export let isOpen = false;
	export let channelId = '';

	/** R4: drawer sticks to channel-list edge (after left nav / before right nav). */
	let drawerSide: 'after-left-nav' | 'before-right-nav' = 'after-left-nav';
	/** Distance from the viewport edge the drawer attaches to (px). */
	let drawerOffsetPx = 0;
	let resizeBound = false;

	$: pinnedMessages = ($channelMessages[channelId] || []).filter((m) => m.isPinned);
	$: channelName = $channels.find((c) => c.id === channelId)?.name || channelId;

	async function reanchor(): Promise<void> {
		await tick();
		if (typeof window === 'undefined' || typeof document === 'undefined') return;

		const navRight = !$layoutStore.isMobile && $layoutStore.navDock === 'right';
		drawerSide = navRight ? 'before-right-nav' : 'after-left-nav';

		if ($layoutStore.isMobile) {
			drawerOffsetPx = 0;
			return;
		}

		const el =
			(document.querySelector('.channel-sidebar') as HTMLElement | null) ||
			(document.querySelector('.channel-sidebar-container') as HTMLElement | null);

		if (el) {
			const r = el.getBoundingClientRect();
			drawerOffsetPx = navRight
				? Math.max(0, Math.round(window.innerWidth - r.left))
				: Math.max(0, Math.round(r.right));
			return;
		}

		// Fallback if sidebar not in DOM (collapsed / mid-transition)
		const w = Math.max(0, Number($layoutStore.channelSidebarWidth) || 0);
		const rail = w > 0 ? 92 : 0;
		drawerOffsetPx = w + rail;
	}

	function bindResize(active: boolean): void {
		if (typeof window === 'undefined') return;
		if (active && !resizeBound) {
			window.addEventListener('resize', onViewportChange);
			resizeBound = true;
		} else if (!active && resizeBound) {
			window.removeEventListener('resize', onViewportChange);
			resizeBound = false;
		}
	}

	function onViewportChange(): void {
		if (isOpen) void reanchor();
	}

	// R4: one reactive — open/close + dock/width/mobile flips
	$: if (isOpen) {
		void $layoutStore.navDock;
		void $layoutStore.channelSidebarWidth;
		void $layoutStore.isMobile;
		void reanchor();
		bindResize(true);
	} else {
		bindResize(false);
	}

	function closeModal() {
		isOpen = false;
	}

	function handleUnpin(messageId: string) {
		togglePinMessage(channelId, messageId);
	}

	function jumpToMessage(messageId: string) {
		closeModal();
		// Use a timeout to ensure the modal closes before scrolling
		setTimeout(() => {
			const messageElement = document.getElementById(`message-${messageId}`);
			if (messageElement) {
				messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
				messageElement.classList.add('highlighted');
				setTimeout(() => {
					messageElement.classList.remove('highlighted');
				}, 2000);
			}
		}, 100);
	}

	function getUserByUsername(username: string): User | undefined {
		return $users.find((u) => u.username === username);
	}

	function getUserColor(username: string): string {
		const user = getUserByUsername(username);
		return user?.color || 'var(--status-offline)';
	}

	function formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && isOpen) {
			closeModal();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	onDestroy(() => {
		bindResize(false);
	});
</script>

{#if isOpen}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="modal-overlay" on:click={closeModal}>
		<div
			class="modal-content"
			class:dock-from-left={drawerSide === 'after-left-nav'}
			class:dock-from-right={drawerSide === 'before-right-nav'}
			class:mobile-full={$layoutStore.isMobile}
			style:left={drawerSide === 'after-left-nav' && !$layoutStore.isMobile
				? `${drawerOffsetPx}px`
				: null}
			style:right={drawerSide === 'before-right-nav' && !$layoutStore.isMobile
				? `${drawerOffsetPx}px`
				: null}
			role="dialog"
			aria-modal="true"
			aria-label={$_('pinned.modal.title', { values: { channel: channelName } })}
			tabindex="-1"
			on:click|stopPropagation
			on:keydown|stopPropagation
		>
			<div class="modal-header">
				<h2>
					<svg
						class="header-pin-icon"
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="7" r="2"></circle>
						<path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path>
						<line x1="12" y1="15" x2="12" y2="21"></line>
					</svg>
					{$_('pinned.modal.title', { values: { channel: channelName } })}
				</h2>
				<button class="close-btn" on:click={closeModal} aria-label={$_('common.close')}>&times;</button>
			</div>

			<div class="modal-body">
				{#if pinnedMessages.length === 0}
					<div class="empty-state">
						<p>{$_('pinned.modal.empty')}</p>
						<p class="hint">{$_('pinned.modal.hint')}</p>
					</div>
				{:else}
					<div class="pinned-messages-list">
						{#each pinnedMessages as message (message.id)}
							<div class="pinned-message">
								<div class="message-header">
									<div class="user-info">
										<span class="username" style="color: {getUserColor(message.user)}">
											{message.user}
										</span>
										<span class="timestamp">{formatTime(message.timestamp)}</span>
									</div>
									<div class="action-buttons">
										<button
											class="jump-btn"
											on:click={() => jumpToMessage(message.id)}
											title={$_('pinned.actions.jump_title')}
										>
											{$_('pinned.actions.jump')}
										</button>
										<button
											class="unpin-btn"
											on:click={() => handleUnpin(message.id)}
											title={$_('pinned.actions.unpin_title')}
										>
											{$_('pinned.actions.unpin')}
										</button>
									</div>
								</div>
								<div class="message-text">
									{message.text}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--surface-overlay, rgba(0, 0, 0, 0.6));
		z-index: var(--z-modal);
		backdrop-filter: blur(2px);
	}

	/* R4: drawer anchors to channel-list edge via inline left/right; no hard-coded right:0 */
	.modal-content {
		position: fixed;
		top: 0;
		bottom: 0;
		width: min(400px, 90vw);
		max-width: 90vw;
		background: var(--surface-raised, #24243e);
		color: var(--text-heading, #e0e0ff);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-subtle, #24243e);
	}

	.modal-content.dock-from-left {
		right: auto;
		box-shadow: var(--shadow-drawer-left, 8px 0 28px rgba(0, 0, 0, 0.35));
		animation: slideInFromLeft var(--duration-normal, 250ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1));
	}

	.modal-content.dock-from-right {
		left: auto;
		box-shadow: var(--shadow-drawer-right, -8px 0 28px rgba(0, 0, 0, 0.35));
		animation: slideInFromRight var(--duration-normal, 250ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1));
	}

	.modal-content.mobile-full {
		left: 0 !important;
		right: 0 !important;
		width: 100%;
		max-width: 100vw;
		box-shadow: none;
		animation: slideInFromRight var(--duration-normal, 250ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1));
	}

	@keyframes slideInFromLeft {
		from {
			transform: translateX(-16px);
			opacity: 0.85;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	@keyframes slideInFromRight {
		from {
			transform: translateX(16px);
			opacity: 0.85;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-4, 1rem) var(--space-5, 1.25rem);
		border-bottom: 1px solid var(--border-subtle, #24243e);
		background: color-mix(
			in srgb,
			var(--pinned-bg, var(--surface-base)) 82%,
			var(--accent-primary-color, #6366f1) 18%
		);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0;
		font-size: var(--text-lg, 16px);
		font-weight: var(--font-weight-semibold, 600);
		color: var(--text-heading, #e0e0ff);
		display: inline-flex;
		align-items: center;
		gap: var(--space-2, 0.5rem);
	}

	.header-pin-icon {
		width: var(--icon-sm, 16px);
		height: var(--icon-sm, 16px);
		flex-shrink: 0;
		color: var(--text-heading, #e0e0ff);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: var(--text-2xl, 1.5rem);
		color: var(--text-secondary, #b3b3ff);
		cursor: pointer;
		width: var(--space-8, 32px);
		height: var(--space-8, 32px);
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md, 8px);
		transition: background-color var(--duration-fast, 150ms), color var(--duration-fast, 150ms);
		flex-shrink: 0;
	}

	.close-btn:hover {
		background-color: var(--surface-hover, #302b63);
		color: var(--text-heading, #e0e0ff);
	}

	.modal-body {
		padding: var(--space-5, 1.25rem);
		overflow-y: auto;
		flex: 1;
		background: var(--surface-base, #1a1a2e);
	}

	.empty-state {
		text-align: center;
		padding: var(--space-12, 3rem) var(--space-6, 1.5rem);
		color: var(--text-secondary, #b3b3ff);
	}

	.empty-state p {
		margin: var(--space-2, 0.5rem) 0;
	}

	.hint {
		font-size: var(--text-base, 0.875rem);
		color: var(--text-secondary, #b3b3ff);
		font-style: italic;
		opacity: var(--opacity-90, 0.85);
	}

	.pinned-messages-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-3, 0.75rem);
	}

	.pinned-message {
		background: var(--surface-raised, #24243e);
		border: 1px solid var(--border-subtle, #24243e);
		border-radius: var(--radius-md, 8px);
		padding: var(--space-4, 1rem);
		transition: background var(--duration-fast, 150ms), transform var(--duration-fast, 150ms);
		box-shadow: none;
	}

	.pinned-message:hover {
		background: var(--surface-hover, #302b63);
		transform: translateY(calc(var(--space-1, 4px) * -0.25));
	}

	.message-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: var(--space-2, 0.5rem);
		gap: var(--space-2, 0.5rem);
	}

	.user-info {
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 0.25rem);
		flex: 1;
		min-width: 0;
	}

	.username {
		font-weight: var(--font-weight-semibold, 600);
		font-size: var(--text-base, 0.875rem);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.timestamp {
		font-size: var(--text-xs, 0.6875rem);
		color: var(--text-secondary, #b3b3ff);
	}

	.action-buttons {
		display: flex;
		gap: var(--space-2, 0.5rem);
		align-items: center;
	}

	.jump-btn {
		padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
		background: var(--accent-primary-color, #6366f1);
		border: none;
		border-radius: var(--radius-sm, 4px);
		color: var(--text-on-accent, #0f0c29);
		font-size: var(--text-xs, 0.6875rem);
		font-weight: var(--font-weight-medium, 500);
		cursor: pointer;
		transition: filter var(--duration-fast, 150ms), transform var(--duration-fast, 150ms);
		flex-shrink: 0;
		white-space: nowrap;
	}

	.jump-btn:hover {
		filter: brightness(1.08);
		transform: translateY(calc(var(--space-1, 4px) * -0.25));
	}

	.unpin-btn {
		padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
		background: none;
		border: 1px solid var(--border-subtle, #24243e);
		border-radius: var(--radius-sm, 4px);
		color: var(--text-secondary, #b3b3ff);
		font-size: var(--text-xs, 0.6875rem);
		font-weight: var(--font-weight-medium, 500);
		cursor: pointer;
		transition: background var(--duration-fast, 150ms), color var(--duration-fast, 150ms);
		flex-shrink: 0;
		white-space: nowrap;
	}

	.unpin-btn:hover {
		background: var(--surface-hover, #302b63);
		color: var(--text-heading, #e0e0ff);
	}

	.message-text {
		color: var(--text-heading, #e0e0ff);
		font-size: var(--text-base, 0.875rem);
		line-height: var(--line-height-normal, 1.5);
		word-wrap: break-word;
		white-space: pre-wrap;
	}

	.modal-body::-webkit-scrollbar {
		width: var(--space-2, 8px);
	}

	.modal-body::-webkit-scrollbar-track {
		background: transparent;
	}

	.modal-body::-webkit-scrollbar-thumb {
		background: var(--border-subtle, #24243e);
		border-radius: var(--radius-sm, 4px);
	}

	.modal-body::-webkit-scrollbar-thumb:hover {
		background: color-mix(in srgb, var(--accent-primary-color, #6366f1) 55%, transparent);
	}
</style>
