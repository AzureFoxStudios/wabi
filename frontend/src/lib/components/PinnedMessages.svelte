<script lang="ts">
	import type { Message, User } from '$lib/socket';
	import { users, togglePinMessage } from '$lib/socket';

	export let pinnedMessages: Message[];

	function getUserByUsername(username: string): User | undefined {
		return $users.find(u => u.username === username);
	}

	function getUserColor(username: string): string {
		const user = getUserByUsername(username);
		return user?.color || 'var(--status-offline)';
	}

	function formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function handleUnpin(messageId: string) {
		togglePinMessage(messageId);
	}
</script>

{#if pinnedMessages.length > 0}
	<div class="pinned-container">
		<div class="pinned-header">
			<span class="pinned-icon">📌</span>
			<span class="pinned-title">Pinned Messages</span>
			<span class="pinned-count">({pinnedMessages.length})</span>
		</div>
		<div class="pinned-messages">
			{#each pinnedMessages as message (message.id)}
				<div class="pinned-message">
					<div class="pinned-message-content">
						<span class="pinned-user" style="color: {getUserColor(message.user)}">
							{message.user}
						</span>
						<span class="pinned-text">{message.text.substring(0, 100)}{message.text.length > 100 ? '...' : ''}</span>
						<span class="pinned-time">{formatTime(message.timestamp)}</span>
					</div>
					<button class="unpin-btn" on:click={() => handleUnpin(message.id)} title="Unpin message">
						×
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.pinned-container {
		background: linear-gradient(135deg, var(--bg-warning-light) 0%, var(--bg-warning-light) 100%);
		border: none;
		border-radius: 8px;
		margin-bottom: 1rem;
		overflow: hidden;
		box-shadow: none;
	}

	.pinned-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--bg-warning-light);
		border-bottom: 1px solid var(--color-warning);
		font-weight: 600;
		color: var(--pinned-text-dark);
	}

	.pinned-icon {
		font-size: 1rem;
	}

	.pinned-title {
		font-size: 0.875rem;
	}

	.pinned-count {
		font-size: 0.75rem;
		color: var(--color-warning-hover);
		font-weight: 500;
	}

	.pinned-messages {
		max-height: 200px;
		overflow-y: auto;
	}

	.pinned-message {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--status-away);
		transition: background-color 0.2s;
		gap: 0.75rem;
	}

	.pinned-message:last-child {
		border-bottom: none;
	}

	.pinned-message:hover {
		background-color: var(--bg-warning-light);
	}

	.pinned-message-content {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.pinned-user {
		font-weight: 600;
		font-size: 0.875rem;
		flex-shrink: 0;
	}

	.pinned-text {
		color: var(--pinned-text-dark);
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.pinned-time {
		font-size: 0.75rem;
		color: var(--color-warning-hover);
		flex-shrink: 0;
	}

	.unpin-btn {
		background: none;
		border: none;
		color: var(--color-warning-hover);
		font-size: 1.5rem;
		cursor: pointer;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.2s;
		flex-shrink: 0;
	}

	.unpin-btn:hover {
		background-color: var(--status-away);
		color: var(--pinned-text-dark);
	}

	/* Scrollbar styling */
	.pinned-messages::-webkit-scrollbar {
		width: 6px;
	}

	.pinned-messages::-webkit-scrollbar-track {
		background: var(--bg-warning-light);
	}

	.pinned-messages::-webkit-scrollbar-thumb {
		background: var(--color-warning);
		border-radius: 3px;
	}

	.pinned-messages::-webkit-scrollbar-thumb:hover {
		background: var(--color-warning-hover);
	}
</style>
