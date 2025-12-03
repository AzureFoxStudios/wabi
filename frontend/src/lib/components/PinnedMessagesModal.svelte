<script lang="ts">
	import { onMount } from 'svelte';
	import type { Message, User } from '$lib/socket';
	import { users, channels, channelMessages, togglePinMessage } from '$lib/socket';

	export let isOpen = false;
	export let channelId = '';

	$: pinnedMessages = ($channelMessages[channelId] || []).filter(m => m.isPinned);
	$: channelName = $channels.find(c => c.id === channelId)?.name || channelId;

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
		return $users.find(u => u.username === username);
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
</script>

{#if isOpen}
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>📌 Pinned Messages in #{channelName}</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>

			<div class="modal-body">
				{#if pinnedMessages.length === 0}
					<div class="empty-state">
						<p>No pinned messages in this channel</p>
						<p class="hint">Right-click a message and select "Pin Message" to pin it here.</p>
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
										<button class="jump-btn" on:click={() => jumpToMessage(message.id)} title="Jump to message">
											Jump to
										</button>
										<button class="unpin-btn" on:click={() => handleUnpin(message.id)} title="Unpin message">
											Unpin
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
		background-color: rgba(0, 0, 0, 0.2);
		z-index: 1000;
		backdrop-filter: blur(2px);
	}

	.modal-content {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 400px;
		max-width: 90vw;
		background: white;
		display: flex;
		flex-direction: column;
		box-shadow: none;
		overflow: hidden;
		animation: slideIn 0.3s ease-out;
	}

	@keyframes slideIn {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(0);
		}
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 2px solid var(--pinned-border);
		background: linear-gradient(135deg, var(--pinned-bg) 0%, var(--pinned-bg-hover) 100%);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--pinned-text-dark);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: var(--pinned-text-dark);
		cursor: pointer;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		transition: background-color 0.2s;
		flex-shrink: 0;
	}

	.close-btn:hover {
		background-color: var(--pinned-bg-hover);
	}

	.modal-body {
		padding: 1.25rem;
		overflow-y: auto;
		flex: 1;
		background: var(--ui-bg-light);
	}

	.empty-state {
		text-align: center;
		padding: 3rem 1.5rem;
		color: var(--modal-text-secondary);
	}

	.empty-state p {
		margin: 0.5rem 0;
	}

	.hint {
		font-size: 0.875rem;
		color: var(--modal-text-muted);
		font-style: italic;
	}

	.pinned-messages-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pinned-message {
		background: var(--modal-bg);
		border: none;
		border-radius: 8px;
		padding: 0.875rem;
		transition: all 0.2s;
		box-shadow: none;
	}

	.pinned-message:hover {
		background: var(--pinned-bg);
		box-shadow: none;
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
		color: var(--pinned-text-secondary);
	}

	.action-buttons {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.jump-btn {
		padding: 0.25rem 0.5rem;
		background: #5865f2;
		border: none;
		border-radius: 4px;
		color: white;
		font-size: 0.7rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.jump-btn:hover {
		background: #4752c4;
		transform: translateY(-1px);
	}

	.unpin-btn {
		padding: 0.25rem 0.5rem;
		background: none;
		border: none;
		border-radius: 4px;
		color: var(--pinned-text-dark);
		font-size: 0.7rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.unpin-btn:hover {
		background: var(--pinned-border);
		color: white;
	}

	.message-text {
		color: var(--pinned-text);
		font-size: 0.875rem;
		line-height: 1.5;
		word-wrap: break-word;
		white-space: pre-wrap;
	}

	/* Scrollbar styling */
	.modal-body::-webkit-scrollbar {
		width: 8px;
	}

	.modal-body::-webkit-scrollbar-track {
		background: var(--ui-bg-light);
	}

	.modal-body::-webkit-scrollbar-thumb {
		background: var(--pinned-border);
		border-radius: 4px;
	}

	.modal-body::-webkit-scrollbar-thumb:hover {
		background: var(--color-warning);
	}
</style>
