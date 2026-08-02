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
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeModal}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeModal();
			}
		}}
	>
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
		background-color: color-mix(in srgb, var(--shadow-md, rgba(0, 0, 0, 0.45)) 70%, transparent);
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
		background: var(--surface-raised, var(--surface-base, #1a1a2e));
		color: var(--text-heading, #e8eef7);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
	}

	.modal-content.dock-from-left {
		right: auto;
		box-shadow: 8px 0 28px color-mix(in srgb, var(--shadow-md, #000) 35%, transparent);
		animation: slideInFromLeft 0.28s ease-out;
	}

	.modal-content.dock-from-right {
		left: auto;
		box-shadow: -8px 0 28px color-mix(in srgb, var(--shadow-md, #000) 35%, transparent);
		animation: slideInFromRight 0.28s ease-out;
	}

	.modal-content.mobile-full {
		left: 0 !important;
		right: 0 !important;
		width: 100%;
		max-width: 100vw;
		box-shadow: none;
		animation: slideInFromRight 0.28s ease-out;
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
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		background: color-mix(
			in srgb,
			var(--pinned-bg, var(--surface-base)) 82%,
			var(--accent-primary-color, #6366f1) 18%
		);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--text-heading, #e8eef7);
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.header-pin-icon {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: var(--text-heading, #e8eef7);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: var(--text-secondary, #94a3b8);
		cursor: pointer;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		transition: background-color 0.2s, color 0.2s;
		flex-shrink: 0;
	}

	.close-btn:hover {
		background-color: var(--surface-hover, rgba(255, 255, 255, 0.08));
		color: var(--text-heading, #e8eef7);
	}

	.modal-body {
		padding: 1.25rem;
		overflow-y: auto;
		flex: 1;
		background: var(--surface-base, #12121c);
	}

	.empty-state {
		text-align: center;
		padding: 3rem 1.5rem;
		color: var(--text-secondary, #94a3b8);
	}

	.empty-state p {
		margin: 0.5rem 0;
	}

	.hint {
		font-size: 0.875rem;
		color: var(--text-secondary, #94a3b8);
		font-style: italic;
		opacity: 0.85;
	}

	.pinned-messages-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pinned-message {
		background: var(--surface-raised, var(--surface-modal, #1e1e2e));
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
		border-radius: 8px;
		padding: 0.875rem;
		transition: background 0.2s, transform 0.2s;
		box-shadow: none;
	}

	.pinned-message:hover {
		background: var(--surface-hover, color-mix(in srgb, var(--surface-raised) 88%, #fff 12%));
		transform: translateY(-1px);
	}

	.message-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 0.625rem;
		gap: 0.5rem;
	}

	.user-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
		min-width: 0;
	}

	.username {
		font-weight: 600;
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.timestamp {
		font-size: 0.7rem;
		color: var(--text-secondary, #94a3b8);
	}

	.action-buttons {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.jump-btn {
		padding: 0.25rem 0.5rem;
		background: var(--accent-primary-color, var(--accent-primary, #6366f1));
		border: none;
		border-radius: 4px;
		color: var(--text-on-accent, #fff);
		font-size: 0.7rem;
		font-weight: 500;
		cursor: pointer;
		transition: filter 0.2s, transform 0.2s;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.jump-btn:hover {
		filter: brightness(1.08);
		transform: translateY(-1px);
	}

	.unpin-btn {
		padding: 0.25rem 0.5rem;
		background: none;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
		border-radius: 4px;
		color: var(--text-secondary, #94a3b8);
		font-size: 0.7rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.unpin-btn:hover {
		background: var(--surface-hover, rgba(255, 255, 255, 0.08));
		color: var(--text-heading, #e8eef7);
	}

	.message-text {
		color: var(--text-heading, #e8eef7);
		font-size: 0.875rem;
		line-height: 1.5;
		word-wrap: break-word;
		white-space: pre-wrap;
	}

	.modal-body::-webkit-scrollbar {
		width: 8px;
	}

	.modal-body::-webkit-scrollbar-track {
		background: transparent;
	}

	.modal-body::-webkit-scrollbar-thumb {
		background: var(--border-subtle, rgba(255, 255, 255, 0.16));
		border-radius: 4px;
	}

	.modal-body::-webkit-scrollbar-thumb:hover {
		background: color-mix(in srgb, var(--accent-primary-color, #6366f1) 55%, transparent);
	}
</style>
