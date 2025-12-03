<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { channelMessages, channels, currentUser, sendMessage, sendTyping, users, type Message, type User, type Channel } from '$lib/socket';
	import MessageList from './MessageList.svelte';

	export let dmChannelId: string | null = null;
	export let otherUser: User | null = null;
	export let onClose: () => void;
	export let onSelectDM: (channelId: string, user: User) => void;

	let showDMList = false;

	$: messages = dmChannelId ? ($channelMessages[dmChannelId] || []) : [];
	$: dmChannel = dmChannelId ? $channels.find(ch => ch.id === dmChannelId) : null;
	$: dmChannels = $channels.filter(ch => ch.type === 'dm');

	function showConversationList() {
		showDMList = true;
	}

	function handleSelectDM(channel: Channel) {
		if (!channel.otherUser) return;
		showDMList = false;
		onSelectDM(channel.id, channel.otherUser);
	}

	function getOtherUserFromChannel(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;

		// Fallback: find the other user from channel members
		const otherUserId = channel.members?.find(id => id !== $currentUser?.id);
		if (!otherUserId) return null;

		return $users.find(u => u.id === otherUserId) || null;
	}

	function getLastMessage(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages yet';

		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg.type === 'text') {
			return lastMsg.text.length > 50 ? lastMsg.text.slice(0, 50) + '...' : lastMsg.text;
		} else if (lastMsg.type === 'gif') {
			return '🎬 Sent a GIF';
		} else if (lastMsg.type === 'file') {
			return `📎 ${lastMsg.fileName}`;
		}
		return '';
	}

	let messageInput = '';
	let chatContainer: HTMLElement;
	let typingTimeout: number;
	let textareaElement: HTMLTextAreaElement;

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	$: if (messages.length > 0) {
		scrollToBottom();
	}

	function handleInput() {
		// Auto-resize textarea
		if (textareaElement) {
			textareaElement.style.height = 'auto';
			textareaElement.style.height = textareaElement.scrollHeight + 'px';
		}

		// Send typing indicator
		clearTimeout(typingTimeout);
		sendTyping(true);
		typingTimeout = setTimeout(() => {
			sendTyping(false);
		}, 2000);
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (!messageInput.trim() || !dmChannelId) return;

		sendMessage(dmChannelId, messageInput.trim(), 'text');
		messageInput = '';

		// Reset textarea height
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}

		sendTyping(false);
		clearTimeout(typingTimeout);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSubmit(event);
		}
	}

	function handleReply(message: Message) {
		// Future implementation
	}
</script>

<div class="dm-panel">
	<div class="dm-header">
		{#if showDMList}
			<span class="dm-title">Direct Messages</span>
		{:else if otherUser}
			<button class="dm-back-btn" on:click={showConversationList} title="Back to DM list">←</button>
			<div class="dm-user-info">
				{#if otherUser.profilePicture}
					<img src={otherUser.profilePicture} alt={otherUser.username} class="dm-avatar" />
				{:else}
					<div class="dm-avatar-placeholder" style="background-color: {otherUser.color}">
						{otherUser.username.charAt(0).toUpperCase()}
					</div>
				{/if}
				<div class="dm-user-details">
					<span class="dm-username">{otherUser.username}</span>
					<span class="dm-status">{otherUser.status || 'active'}</span>
				</div>
			</div>
		{:else}
			<span class="dm-title">Direct Message</span>
		{/if}
		<button class="dm-close-btn" on:click={onClose} title="Close DM">✕</button>
	</div>

	{#if showDMList}
		<div class="dm-list">
			{#if dmChannels.length === 0}
				<div class="dm-empty">
					<p>No direct messages yet. Right-click a user to start a conversation!</p>
				</div>
			{:else}
				{#each dmChannels as channel (channel.id)}
					{@const channelUser = getOtherUserFromChannel(channel)}
					{#if channelUser}
						<button class="dm-list-item" on:click={() => handleSelectDM(channel)}>
							{#if channelUser.profilePicture}
								<img src={channelUser.profilePicture} alt={channelUser.username} class="dm-list-avatar" />
							{:else}
								<div class="dm-list-avatar-placeholder" style="background-color: {channelUser.color}">
									{channelUser.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<div class="dm-list-info">
								<span class="dm-list-username">{channelUser.username}</span>
								<span class="dm-list-preview">{getLastMessage(channel.id)}</span>
							</div>
						</button>
					{/if}
				{/each}
			{/if}
		</div>
	{:else}
		<div class="dm-messages" bind:this={chatContainer}>
			{#if messages.length === 0}
				<div class="dm-empty">
					<p>Start a conversation with {otherUser?.username || 'this user'}!</p>
				</div>
			{:else}
				<MessageList {messages} onReply={handleReply} firstUnreadMessageId={null} />
			{/if}
		</div>

		<form class="dm-input-container" on:submit={handleSubmit}>
			<textarea
				bind:this={textareaElement}
				bind:value={messageInput}
				on:input={handleInput}
				on:keydown={handleKeydown}
				placeholder={otherUser ? `Message ${otherUser.username}...` : 'Type a message...'}
				rows="1"
				class="dm-input"
			></textarea>
			<button type="submit" class="dm-send-btn" disabled={!messageInput.trim()}>
				<span class="send-icon">➤</span>
			</button>
		</form>
	{/if}
</div>

<style>
	.dm-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-primary);
		border-left: 2px solid var(--border);
	}

	.dm-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem;
		background: var(--bg-secondary);
		border-bottom: 2px solid var(--border);
		min-height: 60px;
	}

	.dm-user-info {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: 1;
	}

	.dm-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid var(--accent);
	}

	.dm-avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 1rem;
		border: 2px solid var(--accent);
	}

	.dm-user-details {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.dm-username {
		font-weight: 600;
		font-size: 1rem;
		color: var(--text-primary);
	}

	.dm-status {
		font-size: 0.75rem;
		color: var(--text-secondary);
		text-transform: capitalize;
	}

	.dm-title {
		font-weight: 600;
		font-size: 1rem;
		color: var(--text-primary);
	}

	.dm-close-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.25rem 0.5rem;
		transition: all 0.2s;
		border-radius: 4px;
	}

	.dm-close-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.dm-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-secondary);
		text-align: center;
	}

	.dm-input-container {
		display: flex;
		gap: 0.5rem;
		padding: 1rem;
		background: var(--bg-secondary);
		border-top: 2px solid var(--border);
	}

	.dm-input {
		flex: 1;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border: 2px solid var(--border);
		border-radius: 8px;
		color: var(--text-primary);
		font-size: 0.95rem;
		font-family: inherit;
		resize: none;
		max-height: 200px;
		overflow-y: auto;
		transition: border-color 0.2s;
	}

	.dm-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.dm-input::placeholder {
		color: var(--text-tertiary);
	}

	.dm-send-btn {
		padding: 0.75rem 1rem;
		background: var(--accent);
		border: none;
		border-radius: 8px;
		color: white;
		font-size: 1rem;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dm-send-btn:hover:not(:disabled) {
		background: var(--accent-hover);
		transform: translateY(-2px);
	}

	.dm-send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.send-icon {
		display: inline-block;
		transform: rotate(0deg);
	}

	.dm-back-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.25rem 0.5rem;
		transition: all 0.2s;
		border-radius: 4px;
		margin-right: 0.5rem;
	}

	.dm-back-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-list {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.dm-list-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border);
		width: 100%;
		text-align: left;
		cursor: pointer;
		transition: all 0.2s;
	}

	.dm-list-item:hover {
		background: var(--bg-hover);
	}

	.dm-list-avatar {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid var(--accent);
		flex-shrink: 0;
	}

	.dm-list-avatar-placeholder {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 1.2rem;
		border: 2px solid var(--accent);
		flex-shrink: 0;
	}

	.dm-list-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.dm-list-username {
		font-weight: 600;
		font-size: 1rem;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-list-preview {
		font-size: 0.875rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
