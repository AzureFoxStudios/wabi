<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { channelMessages, currentChannel, typingUsers, sendMessage, sendTyping, lastReadMessageId, editMessage, currentUser, type Message } from '$lib/socket';
	import GiphyPicker from './GiphyPicker.svelte';
	import MessageList from './MessageList.svelte';
	import PinnedMessages from './PinnedMessages.svelte';

	$: messages = $channelMessages[$currentChannel] || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);

	let messageInput = '';
	let chatContainer: HTMLElement;
	let typingTimeout: number;
	let showGiphyPicker = false;
	let replyingTo: Message | null = null;
	let fileInput: HTMLInputElement;
	let editingMessage: Message | null = null;

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	$: if (messages.length) {
		scrollToBottom();
	}

	function handleInput() {
		sendTyping(true);

		if (typingTimeout) {
			clearTimeout(typingTimeout);
		}

		typingTimeout = setTimeout(() => {
			sendTyping(false);
		}, 1000) as unknown as number;
	}

	function handleKeyDown(e: KeyboardEvent) {
		// Arrow up to edit last message
		if (e.key === 'ArrowUp' && !messageInput.trim() && !editingMessage) {
			e.preventDefault();
			// Find the last message from the current user
			const userMessages = messages.filter((m: Message) => m.userId === $currentUser?.id);
			if (userMessages.length > 0) {
				const lastMessage = userMessages[userMessages.length - 1];
				editingMessage = lastMessage;
				messageInput = lastMessage.text;
			}
		}
		// Escape to cancel editing
		else if (e.key === 'Escape' && editingMessage) {
			e.preventDefault();
			cancelEdit();
		}
		// Enter without shift sends the message
		else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
		// Shift+Enter adds a new line (default textarea behavior)
	}

	function handleSubmit() {
		if (messageInput.trim()) {
			if (editingMessage) {
				// Edit the existing message
				editMessage($currentChannel, editingMessage.id, messageInput.trim());
				editingMessage = null;
			} else {
				// Send new message
				sendMessage($currentChannel, messageInput.trim(), 'text', {
					replyTo: replyingTo?.id
				});
				replyingTo = null;
			}
			messageInput = '';
			sendTyping(false);

			if (typingTimeout) {
				clearTimeout(typingTimeout);
			}
		}
	}

	function cancelEdit() {
		editingMessage = null;
		messageInput = '';
	}

	function handleGifSelect(event: CustomEvent<string>) {
		sendMessage($currentChannel, '', 'gif', {
			gifUrl: event.detail,
			replyTo: replyingTo?.id
		});
		replyingTo = null;
		showGiphyPicker = false;
	}

	function handleReply(message: Message) {
		replyingTo = message;
		// Focus the input
		const input = document.querySelector('input[type="text"]') as HTMLInputElement;
		input?.focus();
	}

	function cancelReply() {
		replyingTo = null;
	}

	function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (file) {
			// Convert file to base64
			const reader = new FileReader();
			reader.onload = (e) => {
				const fileUrl = e.target?.result as string;
				sendMessage($currentChannel, messageInput.trim() || `Shared: ${file.name}`, 'file', {
					fileUrl,
					fileName: file.name,
					fileSize: file.size,
					replyTo: replyingTo?.id
				});
				messageInput = '';
				replyingTo = null;
			};
			reader.readAsDataURL(file);
		}

		// Reset file input
		input.value = '';
	}

	onMount(() => {
		scrollToBottom();
	});
</script>

<div class="chat-container">
	<div class="chat-header">
		<h2>#{$currentChannel}</h2>
	</div>

	<div class="messages" bind:this={chatContainer}>
		<PinnedMessages pinnedMessages={pinnedMessages} />
		<MessageList messages={messages} onReply={handleReply} firstUnreadMessageId={$lastReadMessageId} />

		{#if $typingUsers.length > 0}
			<div class="typing-indicator">
				<span class="typing-dots"></span>
				<span>{$typingUsers.join(', ')} {$typingUsers.length === 1 ? 'is' : 'are'} typing...</span>
			</div>
		{/if}
	</div>

	{#if showGiphyPicker}
		<GiphyPicker
			on:select={handleGifSelect}
			on:close={() => showGiphyPicker = false}
		/>
	{/if}

	{#if editingMessage}
		<div class="edit-bar">
			<div class="edit-info">
				<span class="edit-label">Editing message</span>
				<span class="edit-hint">Press Escape to cancel</span>
			</div>
			<button class="cancel-edit" on:click={cancelEdit}>✕</button>
		</div>
	{:else if replyingTo}
		<div class="reply-bar">
			<div class="reply-info">
				<span class="reply-label">Replying to {replyingTo.user}:</span>
				<span class="reply-preview">{replyingTo.text.substring(0, 50)}{replyingTo.text.length > 50 ? '...' : ''}</span>
			</div>
			<button class="cancel-reply" on:click={cancelReply}>✕</button>
		</div>
	{/if}

	<div class="input-container">
		<input
			type="file"
			bind:this={fileInput}
			on:change={handleFileSelect}
			style="display: none;"
		/>
		<button
			class="attachment-button"
			on:click={() => fileInput?.click()}
			title="Attach file"
		>
			📎
		</button>
		<button
			class="gif-button"
			on:click={() => showGiphyPicker = !showGiphyPicker}
			title="Add GIF"
		>
			GIF
		</button>
		<textarea
			bind:value={messageInput}
			on:input={handleInput}
			on:keydown={handleKeyDown}
			placeholder="Type a message... (Shift+Enter for new line)"
			maxlength="2000"
			rows="1"
		></textarea>
		<button on:click={handleSubmit} disabled={!messageInput.trim()}>
			Send
		</button>
	</div>
</div>

<style>
	.chat-container {
		display: flex;
		flex-direction: column;
		height: 100vh;
		position: relative;
	}

	.chat-header {
		padding: 1rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.chat-header h2 {
		font-size: 1.25rem;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.typing-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-style: italic;
		padding: 0.5rem;
	}

	.typing-dots {
		display: inline-block;
		width: 4px;
		height: 4px;
		background: var(--accent);
		border-radius: 50%;
		animation: typing 1.4s infinite;
		position: relative;
	}

	.typing-dots::before,
	.typing-dots::after {
		content: '';
		position: absolute;
		width: 4px;
		height: 4px;
		background: var(--accent);
		border-radius: 50%;
		animation: typing 1.4s infinite;
	}

	.typing-dots::before {
		left: -8px;
		animation-delay: 0.2s;
	}

	.typing-dots::after {
		left: 8px;
		animation-delay: 0.4s;
	}

	@keyframes typing {
		0%, 60%, 100% {
			opacity: 0.3;
		}
		30% {
			opacity: 1;
		}
	}

	.edit-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		background: #fef3c7;
		border-top: 1px solid #f59e0b;
		border-bottom: 1px solid var(--border);
	}

	.edit-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.edit-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: #f59e0b;
	}

	.edit-hint {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.cancel-edit {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: background-color 0.2s;
	}

	.cancel-edit:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	.reply-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		background: #eff6ff;
		border-top: 1px solid #3b82f6;
		border-bottom: 1px solid var(--border);
	}

	.reply-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.reply-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: #3b82f6;
	}

	.reply-preview {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.cancel-reply {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: background-color 0.2s;
	}

	.cancel-reply:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	.input-container {
		padding: 1rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
		display: flex;
		gap: 0.5rem;
	}

	.attachment-button {
		background: var(--bg-tertiary);
		color: var(--accent);
		font-weight: 600;
		padding: 0.5rem 0.75rem;
		font-size: 1.25rem;
	}

	.attachment-button:hover {
		background: var(--accent);
		color: white;
	}

	.gif-button {
		background: var(--bg-tertiary);
		color: var(--accent);
		font-weight: 600;
		padding: 0.5rem 0.75rem;
	}

	.gif-button:hover {
		background: var(--accent);
		color: white;
	}

	textarea {
		flex: 1;
		min-height: 40px;
		max-height: 200px;
		resize: vertical;
		font-family: inherit;
		line-height: 1.5;
		padding: 0.625rem;
	}

	input {
		flex: 1;
	}
</style>
