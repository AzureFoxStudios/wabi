<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { channelMessages, channels, currentChannel, typingUsers, sendMessage, sendTyping, lastReadMessageId, editMessage, currentUser, type Message } from '$lib/socket';
	import GiphyPicker from './GiphyPicker.svelte';
	import MessageList from './MessageList.svelte';
	import PinnedMessages from './PinnedMessages.svelte';

	$: messages = $channelMessages[$currentChannel] || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: channelDisplayName = currentChannelData?.name || $currentChannel;

	let messageInput = '';
	let chatContainer: HTMLElement;
	let typingTimeout: number;
	let showGiphyPicker = false;
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
				// Send new message
				sendMessage($currentChannel, messageInput.trim(), 'text', {
					replyTo: replyingTo?.id,
					isSpoiler: markAsSpoiler
				});
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
			const serverUrl = window.location.origin.includes(':5173')
				? 'http://localhost:3000'
				: window.location.origin;

			// Upload all files and collect their URLs
			const uploadedFiles: { fileUrl: string; fileName: string; fileSize: number }[] = [];

			for (const file of selectedFiles) {
				const result = await new Promise<{ fileUrl: string; fileName: string; fileSize: number }>((resolve, reject) => {
					const formData = new FormData();
					formData.append('file', file);
					formData.append('channelId', $currentChannel);

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
							const uploadResult = JSON.parse(xhr.responseText);
							completedFiles++;
							resolve({
								fileUrl: uploadResult.fileUrl,
								fileName: file.name,
								fileSize: file.size
							});
						} else {
							reject(new Error('Upload failed'));
						}
					});

					xhr.addEventListener('error', () => {
						reject(new Error('Upload failed'));
					});

					xhr.open('POST', `${serverUrl}/api/upload`);
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
				class="send-button"
				on:click={handleSubmit}
				disabled={!messageInput.trim()}
			>
				Send
			</button>
		</div>
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
		padding: 0.625rem 1rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		height: 52px;
		box-sizing: border-box;
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
		background: var(--bg-warning-light);
		border-top: 1px solid var(--color-warning);
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
		color: var(--color-warning);
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
		background: var(--bg-info-light);
		border-top: 1px solid var(--color-info);
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
		color: var(--color-info);
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

	.upload-progress-bar {
		padding: 0.75rem;
		background: var(--bg-info-light);
		border: none;
		border-radius: 0;
		margin-bottom: 0.25rem;
	}

	.upload-progress-info {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
		font-size: 0.875rem;
		color: var(--text-primary);
		font-weight: 500;
	}

	.progress-bar {
		width: 100%;
		height: 8px;
		background: var(--ui-bg-light);
		border-radius: 4px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: linear-gradient(90deg, var(--color-info), var(--color-info-hover));
		transition: width 0.3s ease;
		border-radius: 4px;
	}

	.input-wrapper {
		padding: 0.25rem;
		background: transparent;
		border-top: none;
	}

	.input-container {
		display: flex;
		align-items: center;
		background: transparent;
		border: none;
		border-radius: 0;
		padding: 0.5rem;
		gap: 0.5rem;
		transition: border-color 0.2s;
	}

	.input-container:focus-within {
		border-color: var(--accent);
	}

	.input-buttons-left {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.input-icon-button {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.1rem;
		padding: 0.375rem 0.5rem;
		cursor: pointer;
		border-radius: 0;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
	}

	.input-icon-button:hover {
		background: var(--bg-tertiary);
		color: var(--accent);
	}

	textarea {
		flex: 1;
		min-height: 28px;
		max-height: 120px; /* ~4 lines with line-height 1.5 */
		overflow-y: auto;
		resize: none;
		font-family: inherit;
		line-height: 1.5;
		padding: 0.25rem;
		border: none;
		background: transparent;
		color: var(--text-primary);
		outline: none;
		transition: height 0.1s ease;
	}

	.send-button {
		background: var(--accent);
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 0;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.9rem;
	}

	.send-button:hover:not(:disabled) {
		background: var(--accent);
		opacity: 0.9;
		transform: translateY(-1px);
	}

	.send-button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.file-gallery {
		background: var(--bg-primary);
		border: none;
		border-radius: 0;
		padding: 1rem;
		margin-bottom: 0.25rem;
	}

	.gallery-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.cancel-gallery {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
		padding: 0.25rem;
		border-radius: 4px;
		transition: background-color 0.2s;
	}

	.cancel-gallery:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	.gallery-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.gallery-item {
		position: relative;
		background: var(--bg-secondary);
		border: none;
		border-radius: 8px;
		overflow: hidden;
		aspect-ratio: 1;
		display: flex;
		flex-direction: column;
	}

	.gallery-preview {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.gallery-file-icon {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 3rem;
		background: var(--bg-tertiary);
	}

	.gallery-file-info {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
		color: white;
		padding: 0.5rem;
		font-size: 0.75rem;
	}

	.gallery-file-name {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.gallery-file-size {
		font-size: 0.7rem;
		opacity: 0.9;
	}

	.remove-file {
		position: absolute;
		top: 0.25rem;
		right: 0.25rem;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		border: none;
		border-radius: 50%;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		font-size: 0.875rem;
		transition: background-color 0.2s;
	}

	.remove-file:hover {
		background: rgba(0, 0, 0, 0.8);
	}

	.upload-files-btn {
		width: 100%;
		background: var(--accent);
		color: white;
		border: none;
		padding: 0.75rem;
		border-radius: 0;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.upload-files-btn:hover {
		opacity: 0.9;
	}

	.drag-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(59, 130, 246, 0.1);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		pointer-events: none;
	}

	.drag-overlay-content {
		background: white;
		border: none;
		border-radius: 16px;
		padding: 3rem 4rem;
		text-align: center;
		box-shadow: none;
	}

	.drag-icon {
		font-size: 4rem;
		margin-bottom: 1rem;
		animation: bounce 0.6s ease-in-out infinite alternate;
	}

	.drag-text {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--accent);
	}

	@keyframes bounce {
		from {
			transform: translateY(0);
		}
		to {
			transform: translateY(-10px);
		}
	}

	.spoiler-checkbox-container {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--border);
		margin-top: 0.5rem;
		padding-top: 0.75rem;
	}

	.spoiler-checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--text-primary);
		user-select: none;
	}

	.spoiler-checkbox {
		width: 18px;
		height: 18px;
		cursor: pointer;
		accent-color: var(--color-warning);
	}

	.spoiler-hint {
		font-size: 1rem;
		cursor: help;
		opacity: 0.7;
		transition: opacity 0.2s;
	}

	.spoiler-hint:hover {
		opacity: 1;
	}
</style>
