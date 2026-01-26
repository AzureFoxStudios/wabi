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

	function handleBack() {
		dispatch('back');
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
	let fileInput: HTMLInputElement;
	let selectedFiles: File[] = [];
	let filePreviews: { file: File; preview?: string }[] = [];
	let isUploading = false;
	let uploadProgress = 0;
	let isDragging = false;
	let dragCounter = 0;
	let markAsSpoiler = false;

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

	async function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		// Check file sizes
		const maxSize = 1024 * 1024 * 1024; // 1GB
		for (const file of files) {
			if (file.size > maxSize) {
				alert(`File too large! Maximum size is 1GB per file. "${file.name}" is ${(file.size / 1024 / 1024).toFixed(2)}MB`);
				input.value = '';
				return;
			}
		}

		// Store selected files and generate previews for images
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

	function handleDragEnter(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		dragCounter++;
		if (e.dataTransfer?.types.includes('Files')) {
			isDragging = true;
		}
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		dragCounter--;
		if (dragCounter === 0) {
			isDragging = false;
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		e.stopPropagation();
		isDragging = false;
		dragCounter = 0;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;

		// Check file sizes
		const maxSize = 1024 * 1024 * 1024; // 1GB
		for (const file of files) {
			if (file.size > maxSize) {
				alert(`File too large! Maximum size is 1GB per file. "${file.name}" is ${(file.size / 1024 / 1024).toFixed(2)}MB`);
				return;
			}
		}

		// Store selected files and generate previews
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
	}

	async function uploadSelectedFiles() {
		if (selectedFiles.length === 0 || !dmChannelId) return;

		isUploading = true;
		const totalFiles = selectedFiles.length;
		let completedFiles = 0;

		try {
			let serverUrl: string;
			if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
				serverUrl = 'http://localhost:3000';
			} else if (window.location.origin.includes(':3000')) {
				serverUrl = window.location.origin.replace(':3000', ':8080');
			} else {
				serverUrl = window.location.origin;
			}

			const uploadedFiles: { fileUrl: string; fileName: string; fileSize: number }[] = [];

			for (const file of selectedFiles) {
				const result = await new Promise<{ fileUrl: string; fileName: string; fileSize: number }>((resolve, reject) => {
					const formData = new FormData();
					formData.append('file', file);
					formData.append('channelId', dmChannelId);

					const xhr = new XMLHttpRequest();

					xhr.upload.addEventListener('progress', (e) => {
						if (e.lengthComputable) {
							const fileProgress = (e.loaded / e.total) * 100;
							const overallProgress = ((completedFiles + fileProgress / 100) / totalFiles) * 100;
							uploadProgress = Math.round(overallProgress);
						}
					});

					xhr.addEventListener('load', () => {
						if (xhr.status === 200) {
							try {
								const uploadResult = JSON.parse(xhr.responseText);
								completedFiles++;
								resolve({
									fileUrl: uploadResult.fileUrl,
									fileName: uploadResult.fileName,
									fileSize: uploadResult.fileSize
								});
							} catch (parseError) {
								reject(new Error(`Invalid server response: ${xhr.responseText.substring(0, 100)}`));
							}
						} else {
							reject(new Error(`Upload failed with status ${xhr.status}`));
						}
					});

					xhr.addEventListener('error', () => {
						reject(new Error('Upload network error'));
					});

					const uploadUrl = `${serverUrl}/api/upload`;
					xhr.open('POST', uploadUrl);
					xhr.send(formData);
				});

				uploadedFiles.push(result);
			}

			// Send files as message
			if (uploadedFiles.length === 1) {
				sendMessage(dmChannelId, messageInput.trim() || `Shared: ${uploadedFiles[0].fileName}`, 'file', {
					fileUrl: uploadedFiles[0].fileUrl,
					fileName: uploadedFiles[0].fileName,
					fileSize: uploadedFiles[0].fileSize,
					isSpoiler: markAsSpoiler
				});
			} else {
				sendMessage(dmChannelId, messageInput.trim() || `Shared ${uploadedFiles.length} files`, 'file', {
					files: uploadedFiles,
					isSpoiler: markAsSpoiler
				});
			}

			messageInput = '';
			selectedFiles = [];
			filePreviews = [];
			isUploading = false;
			uploadProgress = 0;
		} catch (error) {
			console.error('Upload error:', error);
			alert('Failed to upload files. Please try again.');
			isUploading = false;
			uploadProgress = 0;
		}
	}
</script>

<div class="dm-panel">
	<div class="dm-header">
		{#if showDMList}
			<span class="dm-title">Direct Messages</span>
		{:else if otherUser}
			<button class="dm-back-btn" on:click={handleBack} title="Back to DM list">← Back</button>
			<div class="dm-user-info">
				<div class="dm-avatar-container">
					{#if otherUser.profilePicture}
						<img src={otherUser.profilePicture} alt={otherUser.username} class="dm-avatar" />
					{:else}
						<div class="dm-avatar-placeholder" style="background-color: {otherUser.color}">
							{otherUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<span class="dm-status-indicator" class:online={otherUser.status === 'active'} class:away={otherUser.status === 'away'} class:busy={otherUser.status === 'busy'}></span>
				</div>
				<span class="dm-username">{otherUser.username}</span>
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
		{#if isDragging}
			<div class="drag-overlay">
				<div class="drag-overlay-content">
					<div class="drag-icon">📁</div>
					<div class="drag-text">Drop files here to share</div>
				</div>
			</div>
		{/if}

		<div
			class="dm-messages"
			bind:this={chatContainer}
			on:dragenter={handleDragEnter}
			on:dragleave={handleDragLeave}
			on:dragover={handleDragOver}
			on:drop={handleDrop}
		>
			{#if messages.length === 0}
				<div class="dm-empty">
					<p>Start a conversation with {otherUser?.username || 'this user'}!</p>
				</div>
			{:else}
				<MessageList {messages} onReply={handleReply} firstUnreadMessageId={null} />
			{/if}
		</div>

		<div class="dm-input-wrapper">
			{#if filePreviews.length > 0 && !isUploading}
				<div class="file-gallery">
					<div class="gallery-header">
						<span>{filePreviews.length} file{filePreviews.length > 1 ? 's' : ''} selected</span>
						<button class="cancel-gallery" on:click={cancelUpload}>✕</button>
					</div>
					<div class="gallery-grid">
						{#each filePreviews as { file, preview }, index}
							<div class="gallery-item">
								{#if preview}
									<img src={preview} alt={file.name} class="gallery-preview" />
								{:else}
									<div class="gallery-file-icon">
										{#if file.type.startsWith('video/')}
											🎬
										{:else if file.type.startsWith('audio/')}
											🎵
										{:else}
											📄
										{/if}
									</div>
								{/if}
								<div class="gallery-file-info">
									<div class="gallery-file-name">{file.name}</div>
									<div class="gallery-file-size">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
								</div>
								<button class="remove-file" on:click={() => removeFile(index)}>✕</button>
							</div>
						{/each}
					</div>
					<label class="spoiler-checkbox">
						<input type="checkbox" bind:checked={markAsSpoiler} />
						<span>Mark as spoiler</span>
					</label>
					<button class="upload-files-btn" on:click={uploadSelectedFiles}>
						Upload {filePreviews.length} file{filePreviews.length > 1 ? 's' : ''}
					</button>
				</div>
			{/if}

			{#if isUploading}
				<div class="upload-progress-bar">
					<div class="upload-progress-info">
						<span>Uploading files...</span>
						<span>{uploadProgress}%</span>
					</div>
					<div class="progress-bar">
						<div class="progress-fill" style="width: {uploadProgress}%"></div>
					</div>
				</div>
			{/if}

			<input
				type="file"
				bind:this={fileInput}
				on:change={handleFileSelect}
				multiple
				style="display: none;"
			/>

				<form class="dm-input-container" on:submit={handleSubmit}>
				<button
					type="button"
					class="dm-attach-btn"
					on:click={() => fileInput?.click()}
					title="Attach file"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 0 19.8 4.3M22 12.5a10 10 0 0 0-19.8-4.2"></path></svg>
				</button>
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
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
				</button>
			</form>
		</div>
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
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		background: var(--gradient-fade-bottom-dark);
		border-bottom: 1px solid rgba(255, 0, 255, 0.1);
		height: 52px;
		box-sizing: border-box;
		z-index: 2;
	}

	.dm-user-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
	}

	.dm-avatar-container {
		position: relative;
		flex-shrink: 0;
	}

	.dm-avatar {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		object-fit: cover;
		border: 1px solid var(--accent);
	}

	.dm-avatar-placeholder {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 0.65rem;
		border: 1px solid var(--accent);
	}

	.dm-username {
		font-weight: 600;
		font-size: 1rem;
		color: var(--text-primary);
	}

	.dm-status-indicator {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dm-status-indicator.online {
		background-color: var(--status-online);
	}

	.dm-status-indicator.away {
		background-color: var(--status-away);
	}

	.dm-status-indicator.busy {
		background-color: var(--status-busy);
	}

	.dm-status-text {
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
		opacity: 0.7;
	}

	.dm-header:hover .dm-close-btn {
		opacity: 1;
	}

	.dm-close-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-messages {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem 1rem 1rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0;
		background: var(--bg-tertiary);
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
		align-items: center;
		background: transparent;
		border-radius: 8px;
		padding: 0.125rem;
		gap: 0.125rem;
		transition: background 0.2s;
	}

	.dm-input-container:focus-within {
		background: var(--bg-tertiary);
		box-shadow: inset 0 0 8px rgba(255, 0, 255, 0.2);
	}

	.dm-input {
		flex: 1;
		min-height: 24px;
		max-height: 120px;
		overflow-y: auto;
		resize: none;
		font-family: inherit;
		line-height: 1.3;
		padding: 0.375rem;
		border: none;
		background: transparent;
		color: var(--text-primary);
		outline: none;
		font-size: 0.95rem;
		-ms-overflow-style: none;
		scrollbar-width: none;
	}

	.dm-input::-webkit-scrollbar {
		display: none;
	}

	.dm-input:focus {
		outline: none;
	}

	.dm-input::placeholder {
		color: var(--text-tertiary);
	}

	.dm-send-btn {
		background: var(--accent);
		color: white;
		border: none;
		padding: 0 0.75rem;
		height: 32px;
		border-radius: 4px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.85rem;
		flex-shrink: 0;
	}

	.dm-send-btn:hover:not(:disabled) {
		box-shadow: inset 0 0 8px rgba(255, 0, 255, 0.2);
	}

	.dm-send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.dm-send-btn svg {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.dm-input-wrapper {
		flex-shrink: 0;
		background: var(--bg-primary);
		border-top: 1px solid var(--border);
		z-index: 2001;
		position: relative;
	}

	.dm-attach-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.1rem;
		cursor: pointer;
		padding: 0.25rem;
		transition: all 0.2s;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
	}

	.dm-attach-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.dm-attach-btn:hover {
		color: var(--text-primary);
		background: var(--bg-tertiary);
		border-radius: 4px;
	}

	/* Drag & Drop Overlay */
	.drag-overlay {
		position: absolute;
		top: 52px;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 999;
		border-radius: 0;
	}

	.drag-overlay-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		pointer-events: none;
	}

	.drag-icon {
		font-size: 3rem;
	}

	.drag-text {
		color: white;
		font-size: 1.2rem;
		font-weight: 600;
	}

	/* File Gallery */
	.file-gallery {
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
	}

	.gallery-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
		font-size: 0.9rem;
		font-weight: 500;
	}

	.cancel-gallery {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.2rem;
		padding: 0;
	}

	.gallery-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.gallery-item {
		position: relative;
		aspect-ratio: 1;
		border-radius: 8px;
		overflow: hidden;
		background: var(--bg-tertiary);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}

	.gallery-preview {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.gallery-file-icon {
		font-size: 2rem;
	}

	.gallery-file-info {
		display: none;
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: rgba(0, 0, 0, 0.8);
		color: white;
		padding: 0.5rem;
		font-size: 0.7rem;
		text-align: center;
	}

	.gallery-item:hover .gallery-file-info {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.gallery-file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}

	.gallery-file-size {
		opacity: 0.8;
	}

	.remove-file {
		position: absolute;
		top: 2px;
		right: 2px;
		background: rgba(0, 0, 0, 0.7);
		border: none;
		color: white;
		cursor: pointer;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.gallery-item:hover .remove-file {
		opacity: 1;
	}

	.spoiler-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--text-secondary);
		transition: color 0.2s;
		margin-bottom: 0.75rem;
	}

	.spoiler-checkbox:hover {
		color: var(--text-primary);
	}

	.spoiler-checkbox input[type="checkbox"] {
		cursor: pointer;
		width: 16px;
		height: 16px;
		accent-color: var(--accent);
	}

	.upload-files-btn {
		width: 100%;
		padding: 0.75rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-weight: 600;
		transition: all 0.2s;
		font-size: 0.9rem;
	}

	.upload-files-btn:hover {
		box-shadow: inset 0 0 8px rgba(255, 0, 255, 0.2);
	}

	/* Upload Progress */
	.upload-progress-bar {
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
	}

	.upload-progress-info {
		display: flex;
		justify-content: space-between;
		margin-bottom: 0.5rem;
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.progress-bar {
		width: 100%;
		height: 6px;
		background: var(--bg-tertiary);
		border-radius: 3px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.3s ease;
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
		opacity: 0.7;
	}

	.dm-header:hover .dm-back-btn {
		opacity: 1;
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

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.dm-panel {
			height: calc(100dvh - 65px); /* Account for bottom nav */
			border-left: none;
		}

		.dm-header {
			padding: 0.75rem;
			min-height: 52px;
		}

		.dm-avatar,
		.dm-avatar-placeholder {
			width: 36px;
			height: 36px;
		}

		.dm-username {
			font-size: 0.95rem;
		}

		.dm-close-btn {
			min-width: 44px;
			min-height: 44px;
			font-size: 1.5rem;
		}

		.dm-back-btn {
			min-width: 44px;
			min-height: 44px;
			font-size: 1.5rem;
		}

		.dm-messages {
			padding: 0.75rem;
		}

		.dm-input-container {
			padding: 0.75rem;
			gap: 0.5rem;
		}

		.dm-input {
			padding: 0.75rem;
			font-size: 16px; /* Prevents iOS zoom */
			min-height: 40px;
			border-radius: 6px;
		}

		.dm-send-btn {
			min-width: 40px;
			min-height: 40px;
			padding: 0.5rem 0.75rem;
		}

		/* DM List mobile */
		.dm-list-item {
			padding: 0.75rem;
			min-height: 64px;
		}

		.dm-list-avatar,
		.dm-list-avatar-placeholder {
			width: 44px;
			height: 44px;
		}

		.dm-list-username {
			font-size: 1rem;
		}

		.dm-list-preview {
			font-size: 0.85rem;
		}
	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.dm-header {
			padding: 0.5rem;
		}

		.dm-user-info {
			gap: 0.5rem;
		}

		.dm-avatar,
		.dm-avatar-placeholder {
			width: 32px;
			height: 32px;
		}

		.dm-input-container {
			padding: 0.5rem;
		}
	}
</style>
