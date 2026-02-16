<script lang="ts">
	import { channelMessages, sendMessage, currentUser, users, sendTyping } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getDmNotesStorageKey } from '$lib/notesStore';
	import GroupAvatar from './GroupAvatar.svelte';
	import NotesWorkspace from './NotesWorkspace.svelte';
	import type { User, Message, Channel } from '$lib/socket';
	import { onMount, afterUpdate, tick } from 'svelte';

	export let channelId: string;
	export let otherUser: User;
	export let channel: Channel | undefined = undefined;

	let messageInput = '';
	let messagesContainer: HTMLDivElement;
	let shouldAutoScroll = true;
	let typingTimeout: ReturnType<typeof setTimeout> | null = null;
	let showDmNotes = false;

	$: isGroup = channel?.type === 'group';
	$: messages = $channelMessages[channelId] || [];
	$: dmNotesStorageKey = getDmNotesStorageKey(channelId, $currentUser?.id);
	$: dmNotesTitle = isGroup ? 'Group Notes' : 'DM Notes';

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

	function getMsgColor(msg: Message): string {
		if (msg.userId === $currentUser?.id) {
			return $currentUser?.roleColor || $currentUser?.color || '#fff';
		}
		if (isGroup) {
			// Find the sender in the users store
			const sender = $users.find(u => u.id === msg.userId);
			if (sender) return sender.roleColor || sender.color;
			// Try memberUsers
			const memberUser = channel?.memberUsers?.find(u => u.id === msg.userId);
			if (memberUser) return memberUser.roleColor || memberUser.color;
			return '#888';
		}
		return otherUser.roleColor || otherUser.color;
	}

	$: placeholderText = isGroup ? `Message ${channel?.name}...` : `Message ${otherUser.username}...`;

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
			{#if isGroup && channel}
				<GroupAvatar {channel} size={28} />
				<div class="dm-header-text">
					<span class="dm-header-name">{channel.name}</span>
					<span class="dm-header-handle">{channel.members?.length || 0} members</span>
				</div>
			{:else}
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
			{/if}
		</div>
		<div class="dm-header-actions">
			<button
				class="dm-notes-btn"
				class:active={showDmNotes}
				on:click={() => showDmNotes = !showDmNotes}
				title={showDmNotes ? 'Hide notes' : 'Open notes'}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
				<span>Notes</span>
			</button>
			<button class="dm-close-btn" on:click={handleClose} title="Close">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>
	</div>

	<div class="dm-content" class:with-notes={showDmNotes}>
		<div class="dm-main">
			<div class="dm-messages" bind:this={messagesContainer}>
				{#if messages.length === 0}
					<div class="dm-empty">
						<p>No messages yet. Say hi!</p>
					</div>
				{:else}
					{#each messages as msg (msg.id)}
						<div class="dm-msg" class:own={msg.userId === $currentUser?.id}>
							<div class="dm-msg-header">
								<span class="dm-msg-author" style="color: {getMsgColor(msg)}">{msg.user}</span>
								<span class="dm-msg-time">{formatTime(msg.timestamp)}</span>
								{#if msg.encrypted}
									<span class="dm-msg-encrypted" title="End-to-end encrypted">
										<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM15.1 8H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
									</span>
								{/if}
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
					placeholder={placeholderText}
					rows="1"
				></textarea>
				<button class="dm-send-btn" on:click={handleSend} disabled={!messageInput.trim()}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
				</button>
			</div>
		</div>
		{#if showDmNotes}
			<div class="dm-notes-panel">
				<NotesWorkspace
					title={dmNotesTitle}
					storageKey={dmNotesStorageKey}
					emptyMessage="No notes in this conversation yet."
					placeholder="Write a note specific to this DM..."
				/>
			</div>
		{/if}
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

	.dm-header-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.dm-notes-btn {
		height: 28px;
		padding: 0 0.5rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.dm-notes-btn:hover,
	.dm-notes-btn.active {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-header-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.dm-content {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}

	.dm-content.with-notes {
		grid-template-columns: minmax(0, 1fr) minmax(280px, 38%);
	}

	.dm-main {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.dm-notes-panel {
		border-left: 1px solid var(--border);
		min-height: 0;
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

	.dm-msg-encrypted {
		color: var(--accent, #5865f2);
		opacity: 0.7;
		display: inline-flex;
		align-items: center;
		margin-left: 2px;
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

	@media (max-width: 1024px) {
		.dm-content.with-notes {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr) 45%;
		}

		.dm-notes-panel {
			border-left: none;
			border-top: 1px solid var(--border);
		}
	}
</style>
