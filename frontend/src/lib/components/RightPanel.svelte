<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import { users, currentUser, channels, channelMessages, createDM, sendMessage, sendTyping, switchChannel, type User, type Message, type Channel } from '$lib/socket';
	import { startCall, startScreenShare } from '$lib/calling';
	import CreateDMModal from './CreateDMModal.svelte';
	import MessageList from './MessageList.svelte';
	import UserPopout from './UserPopout.svelte';

	const dispatch = createEventDispatcher();

	// Panel state
	export let activeTab: 'messages' | 'users' = 'messages';
	export let activeDM: { channelId: string; otherUser: User } | null = null;

	let showDMModal = false;
	let messageInput = '';
	let chatContainer: HTMLElement;
	let textareaElement: HTMLTextAreaElement;
	let typingTimeout: number;

	// User popout state
	let showUserPopout = false;
	let popoutUser: User | null = null;
	let popoutAnchorElement: HTMLElement | null = null;

	// File upload state
	let fileInput: HTMLInputElement;
	let selectedFiles: File[] = [];
	let filePreviews: { file: File; preview?: string }[] = [];
	let isUploading = false;
	let uploadProgress = 0;
	let isDragging = false;
	let dragCounter = 0;

	// Reactive data
	$: dmChannels = $channels.filter(ch => ch.type === 'dm').sort((a, b) => {
		const aLastMsg = ($channelMessages[a.id] || []).length > 0
			? ($channelMessages[a.id] || [])[$channelMessages[a.id].length - 1].timestamp
			: 0;
		const bLastMsg = ($channelMessages[b.id] || []).length > 0
			? ($channelMessages[b.id] || [])[$channelMessages[b.id].length - 1].timestamp
			: 0;
		return bLastMsg - aLastMsg;
	});

	$: onlineUsers = $users.filter(u => u.id !== $currentUser?.id);
	$: dmMessages = activeDM ? ($channelMessages[activeDM.channelId] || []) : [];

	// Switch channel when DM changes
	$: if (activeDM?.channelId) {
		switchChannel(activeDM.channelId);
	}

	// Scroll to bottom when messages change
	$: if (dmMessages.length > 0 && chatContainer) {
		scrollToBottom();
	}

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	function getOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const otherUserId = channel.members?.find((id: string) => id !== $currentUser?.id);
		if (!otherUserId) return null;
		return $users.find(u => u.id === otherUserId) || null;
	}

	function getLastMessagePreview(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages yet';
		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg.type === 'text') {
			return lastMsg.text.length > 40 ? lastMsg.text.slice(0, 40) + '...' : lastMsg.text;
		} else if (lastMsg.type === 'gif') {
			return 'Sent a GIF';
		} else if (lastMsg.type === 'file') {
			return lastMsg.fileName || 'Sent a file';
		}
		return '';
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'active': return 'var(--status-online)';
			case 'away': return 'var(--status-away)';
			case 'busy': return 'var(--status-busy)';
			default: return 'var(--status-offline)';
		}
	}

	function openDM(channel: Channel) {
		const otherUser = getOtherUser(channel);
		if (otherUser) {
			activeDM = { channelId: channel.id, otherUser };
		}
	}

	function openDMWithUser(user: User) {
		const memberIds = [$currentUser?.id, user.id].sort();
		const dmId = `dm-${memberIds.join('-')}`;
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			activeDM = { channelId: dmId, otherUser: user };
		} else {
			createDM(user.id);
			const unsubscribe = channels.subscribe(chs => {
				const newDM = chs.find(ch => ch.id === dmId);
				if (newDM) {
					activeDM = { channelId: dmId, otherUser: user };
					unsubscribe();
				}
			});
		}
	}

	function closeDM() {
		activeDM = null;
	}

	function closePanel() {
		dispatch('close');
	}

	function openProfile(user: User, anchorEl: HTMLElement) {
		popoutUser = user;
		popoutAnchorElement = anchorEl;
		showUserPopout = true;
	}

	// Call actions
	async function handleVoiceCall() {
		if (!activeDM?.otherUser) return;
		try {
			const socket = (await import('$lib/socket')).socket;
			await startCall(socket, activeDM.otherUser.id, false);
		} catch (error) {
			alert('Failed to start voice call.');
		}
	}

	async function handleVideoCall() {
		if (!activeDM?.otherUser) return;
		try {
			const socket = (await import('$lib/socket')).socket;
			await startCall(socket, activeDM.otherUser.id, true);
		} catch (error) {
			alert('Failed to start video call.');
		}
	}

	// Message handling
	function handleInput() {
		if (textareaElement) {
			textareaElement.style.height = 'auto';
			textareaElement.style.height = Math.min(textareaElement.scrollHeight, 120) + 'px';
		}
		clearTimeout(typingTimeout);
		sendTyping(true);
		typingTimeout = setTimeout(() => sendTyping(false), 2000);
	}

	function handleSubmit(event?: Event) {
		event?.preventDefault();
		if (!messageInput.trim() || !activeDM) return;
		sendMessage(activeDM.channelId, messageInput.trim(), 'text');
		messageInput = '';
		if (textareaElement) textareaElement.style.height = 'auto';
		sendTyping(false);
		clearTimeout(typingTimeout);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSubmit();
		}
	}

	function handleReply(message: Message) {
		// Future implementation
	}

	// File handling
	async function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		const maxSize = 1024 * 1024 * 1024;
		for (const file of files) {
			if (file.size > maxSize) {
				alert(`File too large! Max 1GB. "${file.name}" is ${(file.size / 1024 / 1024).toFixed(2)}MB`);
				input.value = '';
				return;
			}
		}

		selectedFiles = files;
		filePreviews = await Promise.all(
			files.map(async (file) => {
				if (file.type.startsWith('image/')) {
					const preview = await new Promise<string>((resolve) => {
						const reader = new FileReader();
						reader.onload = (e) => resolve(e.target?.result as string);
						reader.readAsDataURL(file);
					});
					return { file, preview };
				}
				return { file };
			})
		);
		input.value = '';
	}

	function removeFile(index: number) {
		selectedFiles = selectedFiles.filter((_, i) => i !== index);
		filePreviews = filePreviews.filter((_, i) => i !== index);
	}

	function cancelUpload() {
		selectedFiles = [];
		filePreviews = [];
	}

	async function uploadSelectedFiles() {
		if (selectedFiles.length === 0 || !activeDM) return;
		isUploading = true;
		// Upload logic here (reuse from DMPanel)
		// For brevity, marking as TODO - would integrate existing upload logic
		isUploading = false;
	}
</script>

<aside class="right-panel">
	{#if activeDM}
		<!-- DM Conversation View -->
		<header class="panel-header dm-header">
			<button class="back-btn" on:click={closeDM} title="Back to list">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M19 12H5M12 19l-7-7 7-7"/>
				</svg>
			</button>
			<div class="dm-user-info">
				<div class="avatar-wrapper">
					{#if activeDM.otherUser.profilePicture}
						<img src={activeDM.otherUser.profilePicture} alt={activeDM.otherUser.username} class="avatar" />
					{:else}
						<div class="avatar-placeholder" style="background-color: {activeDM.otherUser.color}">
							{activeDM.otherUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<span class="status-dot" style="background-color: {getStatusColor(activeDM.otherUser.status)}"></span>
				</div>
				<span class="username">{activeDM.otherUser.username}</span>
			</div>
			<div class="header-actions">
				<button class="icon-btn" on:click={handleVoiceCall} title="Voice call">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
					</svg>
				</button>
				<button class="icon-btn" on:click={handleVideoCall} title="Video call">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polygon points="23 7 16 12 23 17 23 7"/>
						<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
					</svg>
				</button>
			</div>
			<button class="close-btn mobile-only" on:click={closePanel} title="Close">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</header>

		<div class="dm-messages" bind:this={chatContainer}>
			{#if dmMessages.length === 0}
				<div class="empty-state">
					<p>Start a conversation with {activeDM.otherUser.username}!</p>
				</div>
			{:else}
				<MessageList messages={dmMessages} onReply={handleReply} firstUnreadMessageId={null} />
			{/if}
		</div>

		<div class="dm-input-wrapper">
			<input type="file" bind:this={fileInput} on:change={handleFileSelect} multiple style="display: none;" />
			<form class="input-container" on:submit={handleSubmit}>
				<button type="button" class="icon-btn" on:click={() => fileInput?.click()} title="Attach file">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
					</svg>
				</button>
				<textarea
					bind:this={textareaElement}
					bind:value={messageInput}
					on:input={handleInput}
					on:keydown={handleKeydown}
					placeholder="Message {activeDM.otherUser.username}..."
					rows="1"
				></textarea>
				<button type="submit" class="send-btn" disabled={!messageInput.trim()}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
					</svg>
				</button>
			</form>
		</div>

	{:else}
		<!-- List View (Messages/Users tabs) -->
		<header class="panel-header">
			<button class="close-btn mobile-only" on:click={closePanel} title="Close">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
			<nav class="tab-nav">
				<button class="tab-btn" class:active={activeTab === 'messages'} on:click={() => activeTab = 'messages'}>
					Messages
				</button>
				<button class="tab-btn" class:active={activeTab === 'users'} on:click={() => activeTab = 'users'}>
					Users ({onlineUsers.length})
				</button>
			</nav>
			{#if activeTab === 'messages'}
				<button class="icon-btn add-btn" on:click={() => showDMModal = true} title="New message">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
				</button>
			{/if}
		</header>

		<div class="panel-content">
			{#if activeTab === 'messages'}
				{#if dmChannels.length === 0}
					<div class="empty-state">
						<div class="empty-icon">💬</div>
						<p>No messages yet</p>
						<p class="hint">Click + to start a conversation</p>
					</div>
				{:else}
					<div class="list">
						{#each dmChannels as channel (channel.id)}
							{@const otherUser = getOtherUser(channel)}
							{#if otherUser}
								<button class="list-item" on:click={() => openDM(channel)}>
									<div class="avatar-wrapper">
										{#if otherUser.profilePicture}
											<img src={otherUser.profilePicture} alt={otherUser.username} class="avatar" />
										{:else}
											<div class="avatar-placeholder" style="background-color: {otherUser.color}">
												{otherUser.username.charAt(0).toUpperCase()}
											</div>
										{/if}
									</div>
									<div class="item-info">
										<span class="item-name">{otherUser.username}</span>
										<span class="item-preview">{getLastMessagePreview(channel.id)}</span>
									</div>
								</button>
							{/if}
						{/each}
					</div>
				{/if}
			{:else}
				{#if onlineUsers.length === 0}
					<div class="empty-state">
						<div class="empty-icon">👥</div>
						<p>No users online</p>
					</div>
				{:else}
					<div class="list">
						{#each onlineUsers as user (user.id)}
							<button class="list-item" on:click={() => openDMWithUser(user)}>
								<div class="avatar-wrapper">
									{#if user.profilePicture}
										<img src={user.profilePicture} alt={user.username} class="avatar" />
									{:else}
										<div class="avatar-placeholder" style="background-color: {user.color}">
											{user.username.charAt(0).toUpperCase()}
										</div>
									{/if}
									<span class="status-dot" style="background-color: {getStatusColor(user.status)}"></span>
								</div>
								<div class="item-info">
									<span class="item-name">{user.username}</span>
									<span class="item-status">{user.status}</span>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Current User Footer -->
		{#if $currentUser}
			<footer class="panel-footer">
				<button class="footer-user" on:click={(e) => openProfile($currentUser, e.currentTarget)}>
					<div class="avatar-wrapper">
						{#if $currentUser.profilePicture}
							<img src={$currentUser.profilePicture} alt={$currentUser.username} class="avatar avatar-sm" />
						{:else}
							<div class="avatar-placeholder avatar-sm" style="background-color: {$currentUser.color}">
								{$currentUser.username.charAt(0).toUpperCase()}
							</div>
						{/if}
						<span class="status-dot status-dot-sm" style="background-color: {getStatusColor($currentUser.status)}"></span>
					</div>
					<div class="footer-info">
						<span class="footer-name">{$currentUser.username} <span class="you-badge">(you)</span></span>
						<span class="footer-status">{$currentUser.status}</span>
					</div>
				</button>
			</footer>
		{/if}
	{/if}
</aside>

<CreateDMModal bind:isOpen={showDMModal} />

<UserPopout
	bind:isOpen={showUserPopout}
	bind:user={popoutUser}
	anchorElement={popoutAnchorElement}
	isOwnProfile={popoutUser?.id === $currentUser?.id}
	on:close={() => showUserPopout = false}
/>

<style>
	/* ============================================
	   RIGHT PANEL - Unified Design System
	   Following UI_GUIDE.md specifications
	   ============================================ */

	.right-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	/* --- Header (52px fixed) --- */
	.panel-header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 52px;
		padding: 0 0.75rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
	}

	.dm-header {
		gap: 0.75rem;
	}

	/* --- Tab Navigation --- */
	.tab-nav {
		display: flex;
		flex: 1;
		gap: 0;
	}

	.tab-btn {
		flex: 1;
		height: 52px;
		padding: 0 1rem;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		font-size: var(--text-base);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		cursor: pointer;
		transition: all 150ms ease;
	}

	.tab-btn:hover {
		color: var(--text-primary);
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.tab-btn.active {
		color: var(--accent-hex);
		border-bottom-color: var(--accent-hex);
		font-weight: 600;
	}

	/* --- Icon Buttons (consistent 32px touch targets) --- */
	.icon-btn {
		width: 32px;
		height: 32px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 100ms ease;
		flex-shrink: 0;
	}

	.icon-btn:hover {
		background: rgba(var(--accent-rgb), var(--opacity-light));
		color: var(--accent-hex);
	}

	.icon-btn svg {
		width: 18px;
		height: 18px;
	}

	.close-btn {
		width: 32px;
		height: 32px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 100ms ease;
	}

	.close-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.back-btn {
		width: 32px;
		height: 32px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 100ms ease;
		flex-shrink: 0;
	}

	.back-btn:hover {
		background: rgba(var(--accent-rgb), var(--opacity-light));
		color: var(--accent-hex);
	}

	.add-btn {
		margin-left: auto;
	}

	/* Mobile-only elements */
	.mobile-only {
		display: none;
	}

	/* --- DM User Info in Header --- */
	.dm-user-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.username {
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.header-actions {
		display: flex;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	/* --- Avatars (consistent sizing) --- */
	.avatar-wrapper {
		position: relative;
		flex-shrink: 0;
	}

	.avatar,
	.avatar-placeholder {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		font-size: var(--text-base);
		color: white;
	}

	.avatar-sm,
	.avatar-placeholder.avatar-sm {
		width: 32px;
		height: 32px;
		font-size: var(--text-xs);
	}

	.status-dot {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--bg-secondary);
	}

	.status-dot-sm {
		width: 8px;
		height: 8px;
	}

	/* --- Content Area (scrollable) --- */
	.panel-content {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.list {
		display: flex;
		flex-direction: column;
	}

	.list-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid rgba(var(--border-rgb), 0.5);
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: background 100ms ease;
	}

	.list-item:hover {
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.item-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.item-name {
		font-size: var(--text-base);
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.item-preview,
	.item-status {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-transform: capitalize;
	}

	/* --- Empty State --- */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 1.5rem;
		text-align: center;
		color: var(--text-secondary);
	}

	.empty-icon {
		font-size: 2.5rem;
		margin-bottom: 1rem;
		opacity: 0.5;
	}

	.empty-state p {
		margin: 0.25rem 0;
		font-size: var(--text-base);
	}

	.hint {
		font-size: var(--text-sm);
		opacity: 0.7;
	}

	/* --- Footer (current user, fixed) --- */
	.panel-footer {
		flex-shrink: 0;
		padding: 0.5rem 0.75rem;
		background: var(--bg-tertiary);
		border-top: 1px solid var(--border);
	}

	.footer-user {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem;
		background: transparent;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: background 100ms ease;
		text-align: left;
	}

	.footer-user:hover {
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.footer-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.footer-name {
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--text-primary);
	}

	.you-badge {
		font-weight: 400;
		color: var(--text-secondary);
	}

	.footer-status {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		text-transform: capitalize;
	}

	/* --- DM Messages View --- */
	.dm-messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
		background: var(--bg-primary);
	}

	/* --- DM Input --- */
	.dm-input-wrapper {
		flex-shrink: 0;
		padding: 0.5rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
	}

	.input-container {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
	}

	.input-container:focus-within {
		box-shadow: 0 0 0 2px rgba(var(--accent-rgb), var(--opacity-light));
	}

	textarea {
		flex: 1;
		min-height: 28px;
		max-height: 120px;
		padding: 0.5rem;
		background: transparent;
		border: none;
		color: var(--text-primary);
		font-size: var(--text-base);
		font-family: inherit;
		line-height: 1.4;
		resize: none;
		outline: none;
	}

	textarea::placeholder {
		color: var(--text-tertiary);
	}

	.send-btn {
		width: 36px;
		height: 36px;
		padding: 0;
		background: var(--accent);
		border: none;
		border-radius: 4px;
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 100ms ease;
		flex-shrink: 0;
	}

	.send-btn:hover:not(:disabled) {
		filter: brightness(1.1);
	}

	.send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ============================================
	   MOBILE STYLES (768px and below)
	   ============================================ */
	@media (max-width: 768px) {
		.right-panel {
			height: calc(100dvh - 56px);
		}

		.mobile-only {
			display: flex;
		}

		.panel-header {
			padding: 0 0.5rem;
		}

		.tab-btn {
			font-size: var(--text-sm);
			padding: 0 0.5rem;
		}

		.list-item {
			padding: 0.625rem;
			min-height: 56px;
		}

		.avatar,
		.avatar-placeholder {
			width: 40px;
			height: 40px;
		}

		textarea {
			font-size: 16px; /* Prevents iOS zoom */
			min-height: 40px;
		}

		.icon-btn,
		.close-btn,
		.back-btn {
			width: 40px;
			height: 40px;
		}

		.send-btn {
			width: 40px;
			height: 40px;
		}
	}
</style>
