<script lang="ts">
	import { channelMessages, sendMessage, currentUser, sendTyping } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import type { User, Message } from '$lib/socket';
	import { onMount, afterUpdate, tick } from 'svelte';

	export let channelId: string;
	export let otherUser: User;

	let messageInput = '';
	let messagesContainer: HTMLDivElement;
	let shouldAutoScroll = true;
	let typingTimeout: ReturnType<typeof setTimeout> | null = null;

	$: messages = $channelMessages[channelId] || [];

	function handleSend() {
		if (!messageInput.trim()) return;
		sendMessage(channelId, messageInput.trim());
		messageInput = '';
		shouldAutoScroll = true;
		if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
		sendTyping(false, channelId);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	function handleInput() {
		sendTyping(true, channelId);
		if (typingTimeout) clearTimeout(typingTimeout);
		typingTimeout = setTimeout(() => {
			sendTyping(false, channelId);
			typingTimeout = null;
		}, 2000);
	}

	function handleClose() {
		layoutStore.closeDM();
	}

	function scrollToBottom() {
		if (messagesContainer && shouldAutoScroll) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	function formatTime(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	afterUpdate(() => {
		scrollToBottom();
	});

	onMount(() => {
		tick().then(scrollToBottom);
	});
</script>

<div class="dm-message-view">
	<div class="dm-header">
		<div class="dm-header-info">
			{#if otherUser.profilePicture}
				<img src={otherUser.profilePicture} alt={otherUser.username} class="dm-header-avatar" />
			{:else}
				<div class="dm-header-avatar-placeholder" style="background-color: {otherUser.roleColor || otherUser.color}">
					{otherUser.username.charAt(0).toUpperCase()}
				</div>
			{/if}
			<div class="dm-header-text">
				<span class="dm-header-name">{otherUser.username}</span>
				{#if otherUser.handle}
					<span class="dm-header-handle">@{otherUser.handle}</span>
				{/if}
			</div>
		</div>
		<button class="dm-close-btn" on:click={handleClose} title="Close DM">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
		</button>
	</div>

	<div class="dm-messages" bind:this={messagesContainer}>
		{#if messages.length === 0}
			<div class="dm-empty">
				<p>No messages yet. Say hi!</p>
			</div>
		{:else}
			{#each messages as msg (msg.id)}
				<div class="dm-msg" class:own={msg.userId === $currentUser?.id}>
					<div class="dm-msg-header">
						<span class="dm-msg-author" style="color: {msg.userId === $currentUser?.id ? ($currentUser?.roleColor || $currentUser?.color || '#fff') : (otherUser.roleColor || otherUser.color)}">{msg.user}</span>
						<span class="dm-msg-time">{formatTime(msg.timestamp)}</span>
					</div>
					<div class="dm-msg-text">{msg.text}</div>
				</div>
			{/each}
		{/if}
	</div>

	<div class="dm-input-area">
		<textarea
			class="dm-input"
			bind:value={messageInput}
			on:keydown={handleKeydown}
			on:input={handleInput}
			placeholder="Message {otherUser.username}..."
			rows="1"
		></textarea>
		<button class="dm-send-btn" on:click={handleSend} disabled={!messageInput.trim()}>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
		</button>
	</div>
</div>

<style>
	.dm-message-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.dm-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		background: var(--bg-secondary);
	}

	.dm-header-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.dm-header-avatar,
	.dm-header-avatar-placeholder {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}

	.dm-header-avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		font-weight: 600;
		color: white;
	}

	.dm-header-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.dm-header-name {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-header-handle {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.dm-close-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dm-close-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.dm-messages {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.dm-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.dm-msg {
		padding: 0.25rem 0;
	}

	.dm-msg-header {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		margin-bottom: 1px;
	}

	.dm-msg-author {
		font-size: 0.8rem;
		font-weight: 600;
	}

	.dm-msg-time {
		font-size: 0.65rem;
		color: var(--text-secondary);
	}

	.dm-msg-text {
		font-size: 0.85rem;
		color: var(--text-primary);
		word-wrap: break-word;
		line-height: 1.35;
	}

	.dm-input-area {
		display: flex;
		align-items: flex-end;
		gap: 0.375rem;
		padding: 0.5rem;
		border-top: 1px solid var(--border);
		background: var(--bg-secondary);
		flex-shrink: 0;
	}

	.dm-input {
		flex: 1;
		resize: none;
		padding: 0.5rem 0.625rem;
		font-size: 0.85rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		border-radius: 8px;
		min-height: 36px;
		max-height: 120px;
		font-family: inherit;
	}

	.dm-input::placeholder {
		color: var(--text-secondary);
	}

	.dm-send-btn {
		width: 36px;
		height: 36px;
		border-radius: 8px;
		border: none;
		background: var(--accent);
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	.dm-send-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.dm-send-btn:hover:not(:disabled) {
		opacity: 0.85;
	}
</style>
