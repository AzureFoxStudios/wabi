<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import { users, currentUser, channels, channelMessages, createDM, sendMessage, sendTyping, switchChannel, type User, type Message, type Channel } from '$lib/socket';
	import { startCall, startScreenShare } from '$lib/calling';
	import CreateDMModal from './CreateDMModal.svelte';
	import MessageList from './MessageList.svelte';
	import UserPopout from './UserPopout.svelte';
	import AudioRecorder from './AudioRecorder.svelte';
	import CameraCapture from './CameraCapture.svelte';

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
	let showAudioRecorder = false;
	let showCameraCapture = false;
	let markAsSpoiler = false;

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

	function supportsMediaCapture(): boolean {
		return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
	}

	async function handleAudioSend(event: CustomEvent<Blob>) {
		const blob = event.detail;
		const ext = blob.type.includes('webm') ? 'webm' : 'm4a';
		const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: blob.type });

		if (file.size > 10 * 1024 * 1024) {
			alert('Audio too large (max 10MB). Please try again.');
			return;
		}

		selectedFiles = [file];
		await uploadSelectedFiles();
		showAudioRecorder = false;
	}

	async function handlePhotoCapture(event: CustomEvent<Blob>) {
		const blob = event.detail;
		const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });

		if (file.size > 10 * 1024 * 1024) {
			alert('Photo too large (max 10MB). Please try again.');
			return;
		}

		selectedFiles = [file];
		await uploadSelectedFiles();
		showCameraCapture = false;
	}

	async function uploadSelectedFiles() {
		if (selectedFiles.length === 0 || !activeDM) return;
		isUploading = true;
		uploadProgress = 0;

		try {
			const formData = new FormData();
			selectedFiles.forEach(file => {
				formData.append('files', file);
			});
			formData.append('channelId', activeDM.channelId);
			if (markAsSpoiler) {
				formData.append('spoiler', 'true');
			}

			const serverUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
				? 'http://localhost:3001'
				: '';

			await new Promise<void>((resolve, reject) => {
				const xhr = new XMLHttpRequest();

				xhr.upload.addEventListener('progress', (e) => {
					if (e.lengthComputable) {
						uploadProgress = (e.loaded / e.total) * 100;
					}
				});

				xhr.addEventListener('load', () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						resolve();
					} else {
						reject(new Error(`Upload failed with status ${xhr.status}`));
					}
				});

				xhr.addEventListener('error', () => {
					reject(new Error('Network error during upload'));
				});

				xhr.addEventListener('abort', () => {
					reject(new Error('Upload cancelled'));
				});

				xhr.open('POST', `${serverUrl}/api/upload`);

				const token = localStorage.getItem('token');
				if (token) {
					xhr.setRequestHeader('Authorization', `Bearer ${token}`);
				}

				xhr.send(formData);
			});

			selectedFiles = [];
			filePreviews = [];
			markAsSpoiler = false;
			uploadProgress = 0;
		} catch (err) {
			console.error('Upload error:', err);
			alert(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			isUploading = false;
		}
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

			{#if filePreviews.length > 0}
				<div class="file-gallery">
					{#each filePreviews as { file, preview }, i}
						<div class="gallery-item">
							{#if preview}
								<img src={preview} alt={file.name} />
							{:else}
								<div class="file-icon">
									<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
										<polyline points="13 2 13 9 20 9"/>
									</svg>
								</div>
							{/if}
							<div class="file-info">
								<span class="file-name">{file.name}</span>
								<span class="file-size">{(file.size / 1024).toFixed(1)} KB</span>
							</div>
							<button type="button" class="remove-file-btn" on:click={() => removeFile(i)} title="Remove">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
								</svg>
							</button>
						</div>
					{/each}
				</div>
				<div class="file-actions">
					<label class="spoiler-checkbox">
						<input type="checkbox" bind:checked={markAsSpoiler} />
						Mark as spoiler
					</label>
					<button type="button" class="btn-secondary" on:click={cancelUpload}>Cancel</button>
					<button type="button" class="btn-primary" on:click={uploadSelectedFiles} disabled={isUploading}>
						{isUploading ? `Uploading... ${uploadProgress.toFixed(0)}%` : 'Send Files'}
					</button>
				</div>
			{/if}

			{#if isUploading}
				<div class="upload-progress-bar">
					<div class="progress-fill" style="width: {uploadProgress}%"></div>
				</div>
			{/if}

			<form class="input-container" on:submit={handleSubmit}>
				<button type="button" class="icon-btn" on:click={() => fileInput?.click()} title="Attach file">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
					</svg>
				</button>

				{#if supportsMediaCapture()}
					<button type="button" class="icon-btn" on:click={() => showCameraCapture = true} title="Take photo">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
							<circle cx="12" cy="13" r="4"/>
						</svg>
					</button>

					<button type="button" class="icon-btn" on:click={() => showAudioRecorder = true} title="Record audio">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
							<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
							<line x1="12" y1="19" x2="12" y2="23"/>
							<line x1="8" y1="23" x2="16" y2="23"/>
						</svg>
					</button>
				{/if}

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

<AudioRecorder
	isOpen={showAudioRecorder}
	on:close={() => showAudioRecorder = false}
	on:send={handleAudioSend}
/>

<CameraCapture
	isOpen={showCameraCapture}
	on:close={() => showCameraCapture = false}
	on:capture={handlePhotoCapture}
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

	/* --- File Upload Gallery --- */
	.file-gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.5rem;
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border-color);
	}

	.gallery-item {
		position: relative;
		background: var(--bg-primary);
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		overflow: hidden;
		aspect-ratio: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}

	.gallery-item img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.file-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	.file-info {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: rgba(0, 0, 0, 0.7);
		padding: 0.25rem 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.file-name {
		font-size: var(--text-xs);
		color: white;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.file-size {
		font-size: var(--text-xs);
		color: rgba(255, 255, 255, 0.7);
	}

	.remove-file-btn {
		position: absolute;
		top: 0.25rem;
		right: 0.25rem;
		background: rgba(0, 0, 0, 0.7);
		border: none;
		border-radius: 50%;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		color: white;
		transition: background 0.2s;
	}

	.remove-file-btn:hover {
		background: rgba(220, 38, 38, 0.9);
	}

	.file-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border-color);
	}

	.spoiler-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-sm);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.spoiler-checkbox input {
		cursor: pointer;
	}

	.btn-secondary,
	.btn-primary {
		padding: 0.5rem 1rem;
		border: none;
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-secondary {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.btn-secondary:hover {
		background: var(--bg-hover);
	}

	.btn-primary {
		background: var(--accent-color);
		color: white;
		margin-left: auto;
	}

	.btn-primary:hover {
		opacity: 0.9;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* --- Upload Progress --- */
	.upload-progress-bar {
		height: 3px;
		background: var(--bg-tertiary);
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent-color);
		transition: width 0.3s ease;
	}
</style>
