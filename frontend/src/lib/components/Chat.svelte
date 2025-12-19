<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { channelMessages, channels, currentChannel, typingUsers, sendMessage, sendTyping, lastReadMessageId, editMessage, currentUser, emojis, type Message, type Emoji } from '$lib/socket';
	import GiphyPicker from './GiphyPicker.svelte';
	import EmojiPicker from './EmojiPicker.svelte';
	import MessageList from './MessageList.svelte';
	import PinnedMessages from './PinnedMessages.svelte';

	$: messages = $channelMessages[$currentChannel] || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: channelDisplayName = currentChannelData?.name || $currentChannel;

	// Safeguard: DM channels should never be displayed in the main chat area
	// They should only appear in the DM panel on the right side
	// This check prevents accidental rendering of DMs in the middle chat
	$: isDMChannel = currentChannelData?.type === 'dm';

	let messageInput = '';
	let chatContainer: HTMLElement;
	let typingTimeout: number;
	let showGiphyPicker = false;
	let showEmojiPicker = false;
	let emojiPickerButton: HTMLButtonElement;
	let replyingTo: Message | null = null;
	let fileInput: HTMLInputElement;
	let editingMessage: Message | null = null;
	let uploadProgress = 0;
	let isUploading = false;
	let selectedFiles: File[] = [];
	let filePreviews: { file: File; preview?: string }[] = [];
	let markAsSpoiler = false;
	let isDragging = false;
	let dragCounter = 0;
	let textareaElement: HTMLTextAreaElement;

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	$: if (messages.length) {
		scrollToBottom();
	}

	function autoResizeTextarea() {
		if (!textareaElement) return;

		// Reset height to auto to get the correct scrollHeight
		textareaElement.style.height = 'auto';

		// Set height based on content, up to max-height
		const newHeight = Math.min(textareaElement.scrollHeight, 120); // ~4 lines max
		textareaElement.style.height = `${newHeight}px`;
	}

	function handleInput() {
		autoResizeTextarea();
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
				const trimmedMessage = messageInput.trim();

				// Check if message is ONLY emoji syntax (e.g., ":smile:" or ":smile::heart:")
				const emojiOnlyPattern = /^(?::[\w_]+:)+$/;
				const isEmojiOnly = emojiOnlyPattern.test(trimmedMessage);

				if (isEmojiOnly) {
					// Extract emoji names and find their URLs
					const emojiNames = trimmedMessage.match(/:[\w_]+:/g)?.map(e => e.slice(1, -1)) || [];
					const firstEmojiName = emojiNames[0];
					const firstEmoji = $emojis.find(e => e.name === firstEmojiName);

					// Send as emoji type for large display
					sendMessage($currentChannel, trimmedMessage, 'emoji', {
						emojiUrl: firstEmoji?.url,
						emojiName: firstEmojiName,
						replyTo: replyingTo?.id,
						isSpoiler: markAsSpoiler
					});
				} else {
					// Send as regular text message
					sendMessage($currentChannel, trimmedMessage, 'text', {
						replyTo: replyingTo?.id,
						isSpoiler: markAsSpoiler
					});
				}
				replyingTo = null;
			}
			messageInput = '';
			sendTyping(false);

			if (typingTimeout) {
				clearTimeout(typingTimeout);
			}

			// Reset textarea height
			if (textareaElement) {
				textareaElement.style.height = 'auto';
			}
			textareaElement?.focus();
		}
	}

	function cancelEdit() {
		editingMessage = null;
		messageInput = '';

		// Reset textarea height
		if (textareaElement) {
			textareaElement.style.height = 'auto';
		}
	}

	function handleGifSelect(event: CustomEvent<string>) {
		sendMessage($currentChannel, '', 'gif', {
			gifUrl: event.detail,
			replyTo: replyingTo?.id,
			isSpoiler: markAsSpoiler
		});
		replyingTo = null;
		showGiphyPicker = false;
		textareaElement?.focus();
	}

	function handleEmojiSelect(event: CustomEvent<{ emoji: Emoji }>) {
		const emoji = event.detail.emoji;
		showEmojiPicker = false;

		// Insert emoji syntax and auto-send
		messageInput = messageInput.trim() ? messageInput + `:${emoji.name}:` : `:${emoji.name}:`;
		handleSubmit();
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

	async function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);

		if (files.length === 0) {
			console.log('No files selected');
			return;
		}

		console.log('Files selected:', files.length);

		// Check file sizes (1GB limit per file)
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
		return;
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
		if (selectedFiles.length === 0) return;

		isUploading = true;
		const totalFiles = selectedFiles.length;
		let completedFiles = 0;

		try {
			let serverUrl: string;
			if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
				// Dev mode or Tauri app: use localhost
				serverUrl = 'http://localhost:3000';
			} else {
				// Production: use current origin
				serverUrl = window.location.origin;
			}

			console.log('Upload serverUrl:', serverUrl);
			console.log('Upload URL will be:', `${serverUrl}/api/upload`);

			// Upload all files and collect their URLs
			const uploadedFiles: { fileUrl: string; fileName: string; fileSize: number }[] = [];

			for (const file of selectedFiles) {
				const result = await new Promise<{ fileUrl: string; fileName: string; fileSize: number }>((resolve, reject) => {
					const formData = new FormData();
					formData.append('file', file);
					formData.append('channelId', $currentChannel);

					console.log('Uploading file:', file.name, 'to channel:', $currentChannel);

					const xhr = new XMLHttpRequest();

					// Track upload progress
					xhr.upload.addEventListener('progress', (e) => {
						if (e.lengthComputable) {
							const fileProgress = (e.loaded / e.total) * 100;
							const overallProgress = ((completedFiles + fileProgress / 100) / totalFiles) * 100;
							uploadProgress = Math.round(overallProgress);
						}
					});

					// Handle completion
					xhr.addEventListener('load', () => {
						if (xhr.status === 200) {
							try {
								const uploadResult = JSON.parse(xhr.responseText);
								completedFiles++;
								resolve({
									fileUrl: uploadResult.fileUrl,
									fileName: file.name,
									fileSize: file.size
								});
							} catch (parseError) {
								console.error('Failed to parse upload response:', xhr.responseText);
								reject(new Error(`Invalid server response: ${xhr.responseText.substring(0, 100)}`));
							}
						} else {
							console.error('Upload failed with status', xhr.status, xhr.responseText);
							reject(new Error(`Upload failed with status ${xhr.status}`));
						}
					});

					xhr.addEventListener('error', () => {
						console.error('XHR error event');
						reject(new Error('Upload network error'));
					});

					const uploadUrl = `${serverUrl}/api/upload`;
					console.log('Opening XHR POST to:', uploadUrl);
					xhr.open('POST', uploadUrl);
					console.log('Sending FormData with file:', file.name);
					xhr.send(formData);
				});

				uploadedFiles.push(result);
			}

			// Send a single message with all uploaded files
			if (uploadedFiles.length === 1) {
				// Single file - use old format for backward compatibility
				sendMessage($currentChannel, messageInput.trim() || `Shared: ${uploadedFiles[0].fileName}`, 'file', {
					fileUrl: uploadedFiles[0].fileUrl,
					fileName: uploadedFiles[0].fileName,
					fileSize: uploadedFiles[0].fileSize,
					replyTo: replyingTo?.id,
					isSpoiler: markAsSpoiler
				});
			} else {
				// Multiple files - use new format
				sendMessage($currentChannel, messageInput.trim() || `Shared ${uploadedFiles.length} files`, 'file', {
					files: uploadedFiles,
					replyTo: replyingTo?.id,
					isSpoiler: markAsSpoiler
				});
			}

			console.log('All files uploaded');
			messageInput = '';
			replyingTo = null;
			selectedFiles = [];
			filePreviews = [];
			isUploading = false;
			uploadProgress = 0;
			textareaElement?.focus();
		} catch (error) {
			console.error('Upload error:', error);
			alert('Failed to upload files. Please try again.');
			isUploading = false;
			uploadProgress = 0;
		}
	}

	onMount(() => {
		scrollToBottom();
	});
</script>

<div
	class="chat-container"
	on:dragenter={handleDragEnter}
	on:dragleave={handleDragLeave}
	on:dragover={handleDragOver}
	on:drop={handleDrop}
>
	{#if isDragging}
		<div class="drag-overlay">
			<div class="drag-overlay-content">
				<div class="drag-icon">📁</div>
				<div class="drag-text">Drop files here to upload</div>
			</div>
		</div>
	{/if}

	{#if isDMChannel}
		<!-- DM channels should not be displayed in the main chat area -->
		<!-- They are only accessible through the DM panel on the right -->
		<div class="dm-redirect-message">
			<div class="dm-redirect-content">
				<h2>Direct Messages</h2>
				<p>Direct messages are displayed in the DM panel on the right side.</p>
				<p>Click on a user in the user panel to start or view a DM conversation.</p>
			</div>
		</div>
	{:else}
		<div class="chat-header">
			<h2>{channelDisplayName}</h2>
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

	{#if showEmojiPicker}
		<EmojiPicker
			on:select={handleEmojiSelect}
			on:close={() => showEmojiPicker = false}
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

	<div class="input-wrapper">
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
				<div class="spoiler-checkbox-container">
					<label class="spoiler-checkbox-label">
						<input type="checkbox" bind:checked={markAsSpoiler} class="spoiler-checkbox" />
						<span>Mark as spoiler</span>
					</label>
					<span class="spoiler-hint" title="Sensitive content will be hidden until clicked">⚠️</span>
				</div>
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
		<div class="input-container">
			<div class="input-buttons-left">
				<button
					class="input-icon-button"
					on:click={() => fileInput?.click()}
					title="Attach file"
				>
					📎
				</button>
			</div>
			<textarea
				bind:this={textareaElement}
				bind:value={messageInput}
				on:input={handleInput}
				on:keydown={handleKeyDown}
				placeholder="Type a message... (Shift+Enter for new line)"
				maxlength="2000"
				rows="1"
			></textarea>
			<button
				class="input-icon-button"
				on:click={() => showGiphyPicker = !showGiphyPicker}
				title="Add GIF"
			>
				GIF
			</button>
			<button
				bind:this={emojiPickerButton}
				class="input-icon-button"
				on:click|stopPropagation={() => {
				showEmojiPicker = !showEmojiPicker;
			}}
				title="Add emoji"
			>
				😀
			</button>
			<button
				class="send-button"
				on:click={handleSubmit}
				disabled={!messageInput.trim()}
			>
				Send
			</button>
		</div>
	</div>
	{/if}
</div>

<style>
	.chat-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		position: relative;
		background: var(--bg-primary);
		overflow: hidden;
	}

	.chat-header {
		flex-shrink: 0;
		padding: 0.625rem 1rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		height: 52px;
		box-sizing: border-box;
		z-index: 2;
	}

	.chat-header h2 {
		font-size: 1.25rem;
		margin: 0;
		font-weight: 600;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0; /* Important for flex overflow */
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

	.edit-bar, .reply-bar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 1rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
	}
	
	.edit-info, .reply-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
	}
	.edit-label { color: var(--color-warning); font-weight: 600; }
	.reply-label { color: var(--color-info); font-weight: 600; }
	.edit-hint { font-style: italic; }
	
	.cancel-edit, .cancel-reply {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
	}

	.input-wrapper {
		flex-shrink: 0;
		background: var(--bg-primary);
		padding: 0.5rem;
		padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		z-index: 2;
	}

	.input-container {
		display: flex;
		align-items: center;
		background: var(--bg-tertiary);
		border-radius: 8px;
		padding: 0.25rem;
		gap: 0.25rem;
	}

	.input-buttons-left {
		display: flex;
		align-items: center;
	}

	.input-icon-button {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.1rem;
		width: 40px;
		height: 40px;
		cursor: pointer;
		border-radius: 4px;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
	}

	.input-icon-button:hover {
		background: var(--bg-hover);
		color: var(--accent);
	}

	textarea {
		flex: 1;
		min-height: 28px;
		max-height: 120px;
		overflow-y: auto;
		resize: none;
		font-family: inherit;
		line-height: 1.5;
		padding: 0.5rem;
		border: none;
		background: transparent;
		color: var(--text-primary);
		outline: none;
		font-size: 1rem;
		/* Hide scrollbar while keeping scroll functionality */
		-ms-overflow-style: none;  /* IE and Edge */
		scrollbar-width: none;  /* Firefox */
	}

	/* Hide scrollbar for Chrome, Safari and Opera */
	textarea::-webkit-scrollbar {
		display: none;
	}

	.send-button {
		background: var(--accent);
		color: white;
		border: none;
		padding: 0 1rem;
		height: 36px;
		border-radius: 6px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.9rem;
	}
	
	.send-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.file-gallery, .upload-progress-bar {
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
	}

	.gallery-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.gallery-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.gallery-item {
		position: relative;
		aspect-ratio: 1;
		border-radius: 8px;
		overflow: hidden;
	}
	
	/* Other existing styles for uploads, spoilers, etc. can remain here */
	/* ... */

	/* ========== MOBILE OVERHAUL ========== */
	@media (max-width: 768px) {
		.chat-container {
			height: 100%;
		}

		.chat-header {
			padding: 0 1rem;
			height: 48px;
		}

		.chat-header h2 {
			font-size: 1rem;
		}

		.messages {
			padding: 0.5rem;
		}

		.input-wrapper {
			padding: 0.5rem;
			padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
			border-top: 1px solid var(--border);
			background: var(--bg-secondary);
		}

		.input-container {
			padding: 0.25rem;
			gap: 0.25rem;
			background: var(--bg-tertiary);
			border-radius: 8px;
		}

		textarea {
			font-size: 16px; /* Prevents iOS auto-zoom */
			padding: 0.75rem 0.5rem;
			min-height: 40px;
		}

		.input-icon-button {
			width: 40px;
			height: 40px;
			flex-shrink: 0;
		}

		/* Hide GIF button on mobile to reduce clutter */
		.input-buttons-left {
			display: none;
		}

		.send-button {
			height: 40px;
			padding: 0 1rem;
			flex-shrink: 0;
		}

		.edit-bar, .reply-bar {
			padding: 0.375rem 0.75rem;
		}
	}
</style>
