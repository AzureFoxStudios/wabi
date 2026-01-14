<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { channelMessages, channels, currentChannel, typingUsers, sendMessage, sendTyping, lastReadMessageId, editMessage, currentUser, emojis, users, type Message, type Emoji } from '$lib/socket';
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
	let resourceSearchResults: any[] = []; // Store /res command results
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

	// Search functionality
	let searchInput = '';

	// Get icon for resource type
	function getResourceIcon(type: string): string {
		const icons: Record<string, string> = {
			brush: '🖌️',
			image: '🖼️',
			url: '🔗',
			note: '📝',
			file: '📁',
			code: '💻'
		};
		return icons[type] || '📄';
	}

	// Open resource in graph
	function openResourceInGraph(resourceId: string) {
		// Open graph page with highlight
		window.open(`/art?highlight=${resourceId}`, '_blank');
	}
	let filteredMessages: Message[] = [];
	let searchSuggestions: string[] = [];
	let selectedSuggestionIndex = -1;
	let showSuggestions = false;

	// Generate search suggestions
	function generateSearchSuggestions(query: string): string[] {
		if (!query.trim()) return [];

		const suggestions: string[] = [];

		// If user is typing "ha", suggest "has:"
		if (query.toLowerCase().includes('has:')) {
			// User is typing with has:, suggest filter types
			const hasMatch = query.match(/has:(\w*)/);
			const prefix = hasMatch ? hasMatch[0] : 'has:';
			const filterTypes = ['image', 'video', 'file', 'link', 'gif', 'website'];
			return filterTypes.map(type => query.replace(/has:\w*/, `has:${type}`));
		} else if (query.toLowerCase().endsWith('ha')) {
			// Suggest starting "has:" filter
			suggestions.push(query.slice(0, -2) + 'has:');
		}

		// Suggest active users
		const userSuggestions = $users
			.filter(u => u.username.toLowerCase().includes(query.toLowerCase()))
			.slice(0, 3)
			.map(u => `by:${u.username}`);

		return [...suggestions, ...userSuggestions];
	}

	// Update suggestions when search input changes
	$: {
		if (searchInput.trim()) {
			searchSuggestions = generateSearchSuggestions(searchInput);
			showSuggestions = searchSuggestions.length > 0;
			selectedSuggestionIndex = -1;
		} else {
			searchSuggestions = [];
			showSuggestions = false;
		}
	}

	function applySuggestion(suggestion: string) {
		searchInput = suggestion;
		showSuggestions = false;
		selectedSuggestionIndex = -1;
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (!showSuggestions) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedSuggestionIndex = (selectedSuggestionIndex + 1) % searchSuggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedSuggestionIndex = selectedSuggestionIndex <= 0 ? searchSuggestions.length - 1 : selectedSuggestionIndex - 1;
		} else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
			e.preventDefault();
			applySuggestion(searchSuggestions[selectedSuggestionIndex]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			showSuggestions = false;
		}
	}

	// Parse search syntax: by:username, has:image, has:video, has:file, has:link, and text content
	function parseSearchQuery(query: string): { text: string; byUser?: string; hasTypes: string[] } {
		const byUserMatch = query.match(/by:(\S+)/);
		const hasMatches = query.match(/has:(\S+)/g) || [];

		const byUser = byUserMatch ? byUserMatch[1] : undefined;
		const hasTypes = hasMatches.map(m => m.replace('has:', '').toLowerCase());

		const text = query.replace(/by:\S+/g, '').replace(/has:\S+/g, '').trim().toLowerCase();

		return { text, byUser, hasTypes };
	}

	// Filter messages based on search query
	function filterMessages(msgs: Message[], query: string): Message[] {
		if (!query.trim()) return msgs;

		const { text, byUser, hasTypes } = parseSearchQuery(query);

		return msgs.filter(msg => {
			// Filter by user
			if (byUser && msg.user.toLowerCase() !== byUser.toLowerCase()) {
				return false;
			}

			// Filter by type (has:image, has:file, etc.)
			if (hasTypes.length > 0) {
				const hasMatch = hasTypes.some(type => {
					if (type === 'image' && msg.type === 'file' && msg.fileUrl?.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return true;
					if (type === 'video' && msg.type === 'file' && msg.fileUrl?.match(/\.(mp4|webm|mov)$/i)) return true;
					if (type === 'file' && msg.type === 'file') return true;
					if (type === 'link' && msg.text.match(/https?:\/\//i)) return true;
					if (type === 'gif' && msg.type === 'gif') return true;
					return false;
				});
				if (!hasMatch) return false;
			}

			// Filter by text content
			if (text && !msg.text.toLowerCase().includes(text)) {
				return false;
			}

			return true;
		});
	}

	// Reactive search
	$: filteredMessages = filterMessages(messages, searchInput);

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

	async function handleSubmit() {
		if (messageInput.trim()) {
			if (editingMessage) {
				// Edit the existing message
				editMessage($currentChannel, editingMessage.id, messageInput.trim());
				editingMessage = null;
			} else {
				const trimmedMessage = messageInput.trim();

				// Check for slash commands
				if (trimmedMessage.startsWith('/')) {
					const { executeCommand } = await import('$lib/commands/CommandRegistry');
					const result = await executeCommand(trimmedMessage, {
						userId: $currentUser?.id || '',
						channelId: $currentChannel,
						workspaceId: 'default-workspace',
						messageInput: trimmedMessage
					});

					if (result.success) {
						if (result.action === 'send-message' && result.message) {
							// Send command result as a system message
							sendMessage($currentChannel, result.message, 'text');
						} else if (result.action === 'show-resource-links') {
							// Store resource search results for display
							resourceSearchResults = result.data?.resourceNodes || [];
							// Send summary message
							sendMessage($currentChannel, result.message || '', 'text');
						} else if (result.action === 'navigate') {
							// Navigate to a different route
							if (result.data?.path) {
								// Use path directly if provided
								goto(result.data.path);
							} else if (result.data?.filter) {
								goto(`/business/graph?filter=${encodeURIComponent(result.data.filter)}`);
							} else {
								goto('/business/graph');
							}
						} else if (result.action === 'clear-channel') {
							// Clear channel messages (TODO: implement)
							console.log('Clear channel not yet implemented');
						}
						// action: 'open-modal' and other types can be handled as needed
					} else {
						// Send error message to chat
						sendMessage($currentChannel, `⚠️ ${result.message || 'Command failed'}`, 'text');
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
					return;
				}

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
			} else if (window.location.origin.includes(':3000')) {
				// Docker deployment: if on port 3000 (frontend), connect to port 8080 (backend)
				serverUrl = window.location.origin.replace(':3000', ':8080');
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

	<!-- Resource Search Results Display -->
	{#if resourceSearchResults.length > 0}
		<div class="resource-results">
			<div class="resource-results-header">
				<span>Found {resourceSearchResults.length} resource{resourceSearchResults.length === 1 ? '' : 's'}</span>
				<button class="close-results-btn" on:click={() => resourceSearchResults = []}>✕</button>
			</div>
			<div class="resource-results-list">
				{#each resourceSearchResults as node}
					<div class="resource-link-item">
						<span class="resource-icon">{getResourceIcon(node.type)}</span>
						<a
							href="#"
							on:click|preventDefault={() => openResourceInGraph(node.id)}
							class="resource-link">
							{node.name}
						</a>
						<span class="resource-meta">
							{#if !node.isAnonymous && node.author}
								by {node.author}
							{:else if node.isAnonymous}
								🔒 Anonymous
							{/if}
						</span>
						{#if node.tags.length > 0}
							<div class="resource-tags">
								{#each node.tags as tag}
									<span class="result-tag">#{tag}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
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
		background: var(--bg-primary);
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
		flex: 1;
	}

	.search-container {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.search-input-wrapper {
		position: relative;
	}

	.search-input {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: 0.9rem;
		min-width: 250px;
		transition: all 0.2s;
	}

	.search-input::placeholder {
		color: var(--text-secondary);
	}

	.search-input:focus {
		outline: none;
		border-color: var(--accent);
		background: var(--bg-tertiary);
	}

	.search-suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-top: none;
		border-radius: 0 0 6px 6px;
		max-height: 250px;
		overflow-y: auto;
		z-index: 10;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.suggestion-item {
		display: block;
		width: 100%;
		padding: 0.75rem;
		border: none;
		background: transparent;
		color: var(--text-primary);
		text-align: left;
		cursor: pointer;
		font-size: 0.9rem;
		transition: all 0.15s;
		border-bottom: 1px solid var(--border);
	}

	.suggestion-item:last-child {
		border-bottom: none;
	}

	.suggestion-item:hover {
		background: var(--bg-tertiary);
	}

	.suggestion-item.selected {
		background: var(--accent);
		color: white;
	}

	.search-results {
		font-size: 0.8rem;
		color: var(--text-secondary);
		white-space: nowrap;
		padding: 0 0.5rem;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0; /* Important for flex overflow */
		background: var(--bg-primary);
		position: relative;
		z-index: 1;
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
		z-index: 2001;
		position: relative;
	}

	.input-container {
		display: flex;
		align-items: center;
		background: transparent;
		border-radius: 8px;
		padding: 0.25rem;
		gap: 0.25rem;
		transition: background 0.2s;
	}

	.input-container:focus-within {
		background: var(--bg-tertiary);
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

	/* Drag & Drop Overlay - smooth fade effect */
	.drag-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 999;
		animation: fadeIn 0.2s ease-in-out forwards;
	}

	@keyframes fadeIn {
		from {
			background-color: rgba(0, 0, 0, 0);
			opacity: 0;
		}
		to {
			background-color: rgba(0, 0, 0, 0.5);
			opacity: 1;
		}
	}

	@keyframes fadeOut {
		from {
			background-color: rgba(0, 0, 0, 0.5);
			opacity: 1;
		}
		to {
			background-color: rgba(0, 0, 0, 0);
			opacity: 0;
		}
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
		animation: pulse 1s ease-in-out infinite;
	}

	.drag-text {
		color: white;
		font-size: 1.2rem;
		font-weight: 600;
	}

	@keyframes pulse {
		0%, 100% {
			transform: scale(1);
			opacity: 1;
		}
		50% {
			transform: scale(1.1);
			opacity: 0.8;
		}
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

		.search-container {
			flex-direction: column;
			gap: 0.25rem;
		}

		.search-input {
			min-width: unset;
			width: 100%;
			font-size: 0.85rem;
			padding: 0.4rem 0.5rem;
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
	.resource-results {
		background: #2a2a2e;
		border-radius: 8px;
		padding: 12px;
		margin: 8px 0;
		border: 1px solid #444;
	}

	.resource-results-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
		font-size: 14px;
		color: #fff;
		font-weight: 600;
	}

	.close-results-btn {
		background: transparent;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 18px;
		padding: 4px;
	}

	.close-results-btn:hover {
		color: #fff;
	}

	.resource-results-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.resource-link-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px;
		background: #3a3a3e;
		border-radius: 6px;
		transition: background 0.2s;
	}

	.resource-link-item:hover {
		background: #4a4a4e;
	}

	.resource-icon {
		font-size: 20px;
	}

	.resource-link {
		flex: 1;
		color: #fff;
		text-decoration: none;
		font-weight: 600;
	}

	.resource-link:hover {
		color: #6366f1;
	}

	.resource-meta {
		font-size: 12px;
		color: #aaa;
		white-space: nowrap;
	}

	.resource-tags {
		display: flex;
		gap: 4px;
		margin-top: 4px;
	}

	.result-tag {
		background: #6366f1;
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 11px;
	}
</style>
