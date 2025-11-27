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

	function getUserByUsername(username: string): User | undefined {
		return $users.find(u => u.username === username);
	}

	function getUserColor(username: string): string {
		const user = getUserByUsername(username);
		return user?.color || '#6b7280';
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
									<button class="unpin-btn" on:click={() => handleUnpin(message.id)} title="Unpin message">
										Unpin
									</button>
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
		box-shadow: -4px 0 20px rgba(0, 0, 0, 0.15);
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
		border-bottom: 2px solid #fbbf24;
		background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		color: #92400e;
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: #92400e;
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
		background-color: #fde68a;
	}

	.modal-body {
		padding: 1.25rem;
		overflow-y: auto;
		flex: 1;
		background: #fafafa;
	}

	.empty-state {
		text-align: center;
		padding: 3rem 1.5rem;
		color: #6b7280;
	}

	.empty-state p {
		margin: 0.5rem 0;
	}

	.hint {
		font-size: 0.875rem;
		color: #9ca3af;
		font-style: italic;
	}

	.pinned-messages-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pinned-message {
		background: white;
		border: 1px solid #fbbf24;
		border-radius: 8px;
		padding: 0.875rem;
		transition: all 0.2s;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.pinned-message:hover {
		background: #fffbeb;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
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
		color: #b45309;
	}

	.unpin-btn {
		padding: 0.25rem 0.5rem;
		background: none;
		border: 1px solid #fbbf24;
		border-radius: 4px;
		color: #92400e;
		font-size: 0.7rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.unpin-btn:hover {
		background: #fbbf24;
		color: white;
	}

	.message-text {
		color: #78350f;
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
		background: #f3f4f6;
	}

	.modal-body::-webkit-scrollbar-thumb {
		background: #fbbf24;
		border-radius: 4px;
	}

	.modal-body::-webkit-scrollbar-thumb:hover {
		background: #f59e0b;
	}
</style>
