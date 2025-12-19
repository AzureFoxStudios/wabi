<script lang="ts">
	import { onMount, afterUpdate } from 'svelte';
	import type { Message, User, Emoji } from '$lib/socket';
	import { users, currentUser, currentChannel, editMessage, deleteMessage, togglePinMessage, addReaction, removeReaction, emojis } from '$lib/socket';
	import MessageContextMenu from './MessageContextMenu.svelte';
	import UserPopout from './UserPopout.svelte';
	import ForwardDialog from './ForwardDialog.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import EmojiPicker from './EmojiPicker.svelte';
	import { parseMessage } from '$lib/markdown';
	import '$lib/prism-theme.css';
	export let messages: Message[];
	export let onReply: (message: Message) => void = () => {};
	export let firstUnreadMessageId: string | null = null;
	// User popout state
	let showUserPopout = false;
	let popoutUser: User | null = null;
	let popoutAnchorElement: HTMLElement | null = null;
	let popoutIsOwnProfile = false;
	// Context menu state
	let contextMenuVisible = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuMessage: Message | null = null;
	// Edit mode state
	let editingMessageId: string | null = null;
	let editText = '';
	// Delete confirmation state
	let showDeleteConfirm = false;
	let messageToDelete: Message | null = null;
	// Emoji picker for reactions
	// TODO: Add emoji reactions feature
	// - Right-click message → "Add Reaction" → Opens emoji picker
	// - Click emoji → Adds reaction to message
	// - Display reactions below messages with counts
	// - Click reaction to toggle your reaction on/off
	let showReactionPicker = false;
	let reactionPickerX = 0;
	let reactionPickerY = 0;
	let reactionPickerMessageId: string | null = null;
	function formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit'
		});
	}
	function getUserByUsername(username: string): User | undefined {
		return $users.find(u => u.username === username);
	}
	function getUserColor(username: string): string {
		const user = getUserByUsername(username);
		return user?.color || 'var(--status-offline)';
	}

	function handleContextMenu(event: MouseEvent, message: Message) {
		event.preventDefault();
		contextMenuMessage = message;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		contextMenuVisible = true;
	}
	function handleEdit() {
		if (!contextMenuMessage) return;
		editingMessageId = contextMenuMessage.id;
		editText = contextMenuMessage.text;
		contextMenuVisible = false;
	}
	function saveEdit(messageId: string) {
		if (editText.trim()) {
			editMessage($currentChannel, messageId, editText.trim());
		}
		editingMessageId = null;
		editText = '';
	}
	function cancelEdit() {
		editingMessageId = null;
		editText = '';
	}
	function handleDelete() {
		if (!contextMenuMessage) return;
		messageToDelete = contextMenuMessage;
		showDeleteConfirm = true;
		contextMenuVisible = false;
	}
	function confirmDeleteMessage() {
		if (messageToDelete) {
			deleteMessage($currentChannel, messageToDelete.id);
		}
		showDeleteConfirm = false;
	}
	function handlePin() {
		if (!contextMenuMessage) return;
		togglePinMessage($currentChannel, contextMenuMessage.id);
		contextMenuVisible = false;
	}
	function handleReply() {
		if (!contextMenuMessage) return;
		onReply(contextMenuMessage);
		contextMenuVisible = false;
	}
	async function handleDownload() {
		if (!contextMenuMessage?.fileUrl || !contextMenuMessage?.fileName) return;
		try {
			const fileUrl = getFileUrl(contextMenuMessage.fileUrl);
			const response = await fetch(fileUrl);
			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = contextMenuMessage.fileName;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Download failed:', error);
		}
		contextMenuVisible = false;
	}
	let showForwardDialog = false;
	let forwardMessage: Message | null = null;
	function handleForward() {
		if (!contextMenuMessage) return;
		forwardMessage = contextMenuMessage;
		showForwardDialog = true;
		contextMenuVisible = false;
	}
	function handleAddReaction() {
		if (!contextMenuMessage) return;
		// Open emoji picker at the context menu position
		reactionPickerMessageId = contextMenuMessage.id;
		reactionPickerX = contextMenuX;
		reactionPickerY = contextMenuY;
		showReactionPicker = true;
		contextMenuVisible = false;
	}
	function openReactionPicker(event: MouseEvent, messageId: string) {
		event.stopPropagation();
		reactionPickerMessageId = messageId;
		reactionPickerX = event.clientX;
		reactionPickerY = event.clientY;
		showReactionPicker = true;
	}
	function handleReactionSelect(event: CustomEvent<{ emoji: Emoji }>) {
		if (!reactionPickerMessageId) return;
		addReaction($currentChannel, reactionPickerMessageId, event.detail.emoji.id);
		showReactionPicker = false;
		reactionPickerMessageId = null;
	}
	function toggleReaction(messageId: string, emojiId: string) {
		const message = messages.find(m => m.id === messageId);
		if (!message || !message.reactions) {
			addReaction($currentChannel, messageId, emojiId);
			return;
		}
		const userReacted = message.reactions[emojiId]?.includes($currentUser?.id || '');
		if (userReacted) {
			removeReaction($currentChannel, messageId, emojiId);
		} else {
			addReaction($currentChannel, messageId, emojiId);
		}
	}
	function getEmojiById(emojiId: string): Emoji | undefined {
		return $emojis.find(e => e.id === emojiId);
	}
	function handleImageContextMenu(event: MouseEvent, message: Message) {
		event.preventDefault();
		contextMenuMessage = message;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		contextMenuVisible = true;
	}
	function formatFileSize(bytes?: number): string {
		if (!bytes) return '';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}
	function getFileUrl(fileUrl?: string): string {
		if (!fileUrl) return '';
		// If it's already a full URL (data: or http:), return as-is
		if (fileUrl.startsWith('data:') || fileUrl.startsWith('http:') || fileUrl.startsWith('https:')) {
			return fileUrl;
		}
		// Otherwise, prepend the backend server URL
		let serverUrl: string;
		if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
			serverUrl = 'http://localhost:3000';
		} else {
			serverUrl = window.location.origin;
		}
		return `${serverUrl}${fileUrl}`;
	}
	function getReplyToMessage(replyToId?: string): Message | undefined {
		if (!replyToId) return undefined;
		return messages.find(m => m.id === replyToId);
	}
	// Jump to referenced message
	let highlightedMessageId: string | null = null;
	function jumpToMessage(messageId: string) {
		const messageElement = document.getElementById(`message-${messageId}`);
		if (messageElement) {
			messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
			// Highlight the message briefly
			highlightedMessageId = messageId;
			setTimeout(() => {
				highlightedMessageId = null;
			}, 2000);
		}
	}
	function getFileIcon(fileName?: string): string {
		if (!fileName) return '📎';
		const ext = fileName.toLowerCase().split('.').pop() || '';
		const iconMap: Record<string, string> = {
			// Images
			'jpg': '🖼️',
			'jpeg': '🖼️',
			'png': '🖼️',
			'gif': '🖼️',
			'bmp': '🖼️',
			'svg': '🖼️',
			'webp': '🖼️',
			// Videos
			'mp4': '🎬',
			'mov': '🎬',
			'avi': '🎬',
			'mkv': '🎬',
			'webm': '🎬',
			'flv': '🎬',
			// Audio
			'mp3': '🎵',
			'wav': '🎵',
			'ogg': '🎵',
			'flac': '🎵',
			// Documents
			'pdf': '📄',
			'doc': '📝',
			'docx': '📝',
			'txt': '📝',
			'rtf': '📝',
			// Spreadsheets
			'xls': '📊',
			'xlsx': '📊',
			'csv': '📊',
			// Presentations
			'ppt': '📽️',
			'pptx': '📽️',
			// Archives
			'zip': '📦',
			'rar': '📦',
			'7z': '📦',
			'tar': '📦',
			'gz': '📦',
			// Code
			'js': '💻',
			'ts': '💻',
			'py': '💻',
			'java': '💻',
			'cpp': '💻',
			'c': '💻',
			'cs': '💻',
			'html': '💻',
			'css': '💻',
			'json': '💻',
			// 3D/Design
			'blend': '🎨',
			'fbx': '🎨',
			'obj': '🎨',
			'stl': '🎨',
			'psd': '🎨',
			'ai': '🎨',
			'sketch': '🎨',
		};
		return iconMap[ext] || '📎';
	}
	function isImage(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext);
	}
	function isVideo(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv'].includes(ext);
	}
	function isAudio(fileName?: string): boolean {
		if (!fileName) return false;
		const ext = fileName.toLowerCase().split('.').pop() || '';
		return ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'].includes(ext);
	}
	let enlargedImage: string | null = null;
	let enlargedVideo: string | null = null;
	let currentImageGallery: string[] = [];
	let currentImageIndex: number = 0;
	function enlargeImage(imageUrl: string, gallery: string[] = []) {
		enlargedImage = imageUrl;
		currentImageGallery = gallery.length > 0 ? gallery : [imageUrl];
		currentImageIndex = currentImageGallery.indexOf(imageUrl);
	}
	function closeEnlargedImage() {
		enlargedImage = null;
		currentImageGallery = [];
		currentImageIndex = 0;
	}
	function navigateImage(direction: 'prev' | 'next') {
		if (currentImageGallery.length === 0) return;
		if (direction === 'prev') {
			currentImageIndex = (currentImageIndex - 1 + currentImageGallery.length) % currentImageGallery.length;
		} else {
			currentImageIndex = (currentImageIndex + 1) % currentImageGallery.length;
		}
		enlargedImage = currentImageGallery[currentImageIndex];
	}
	function handleImageKeydown(e: KeyboardEvent) {
		if (!enlargedImage) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			navigateImage('prev');
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			navigateImage('next');
		} else if (e.key === 'Escape') {
			e.preventDefault();
			closeEnlargedImage();
		}
	}
	function enlargeVideo(videoUrl: string) {
		enlargedVideo = videoUrl;
	}
	function closeEnlargedVideo() {
		enlargedVideo = null;
	}
	// Attach click handlers to spoiler elements
	function attachSpoilerHandlers() {
		const spoilers = document.querySelectorAll('.spoiler[data-spoiler="true"]');
		spoilers.forEach(spoiler => {
			if (!spoiler.hasAttribute('data-listener-attached')) {
				spoiler.addEventListener('click', function(this: HTMLElement) {
					this.classList.toggle('revealed');
				});
				spoiler.setAttribute('data-listener-attached', 'true');
			}
		});
	}
	// Attach handlers when component mounts and updates
	onMount(attachSpoilerHandlers);
	afterUpdate(attachSpoilerHandlers);
</script>

<!-- Window-level keyboard listener for image navigation -->
<svelte:window on:keydown={handleImageKeydown} />

{#each messages as message (message.id)}
	{@const user = getUserByUsername(message.user)}
	{@const replyToMsg = getReplyToMessage(message.replyTo)}

	<!-- New Messages Divider -->
	{#if firstUnreadMessageId === message.id}
		<div class="new-messages-divider">
			<span>New Messages</span>
		</div>
	{/if}

	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		id="message-{message.id}"
		class="message {message.isPinned ? 'pinned' : ''} {highlightedMessageId === message.id ? 'highlighted' : ''}"
		on:contextmenu={(e) => handleContextMenu(e, message)}
	>
		<div class="message-actions">
			<button class="action-btn" title="Add Reaction" on:click={(e) => openReactionPicker(e, message.id)}>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
			</button>
			<span class="timestamp-action">{formatTime(message.timestamp)}</span>
			<button class="action-btn" title="Forward" on:click={() => handleForward(message)}>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17l5-5-5-5"/></svg>
			</button>
			<button class="action-btn" title="Reply" on:click={() => handleReply(message)}>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
			</button>
			<button class="action-btn" title="More" on:click={(e) => handleContextMenu(e, message)}>
				<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
			</button>
		</div>

		<!-- Profile Picture -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="message-avatar">
				{#if user?.profilePicture}
					<img src={user.profilePicture} alt={message.user} class="avatar" />
				{:else}
					<div class="avatar-placeholder" style="background-color: {getUserColor(message.user)}">
						{message.user.charAt(0).toUpperCase()}
					</div>
				{/if}
			</div>
		<!-- Message Content -->
		<div class="message-body">
			<div class="message-header">
				<div class="header-left">
					{#if user}
						<!-- svelte-ignore a11y-click-events-have-key-events -->
						<!-- svelte-ignore a11y-no-static-element-interactions -->
						<span class="username" style="color: {getUserColor(message.user)}">
							{message.user}
						</span>
					{:else}
						<span class="username">{message.user}</span>
					{/if}
					{#if message.isPinned}
						<span class="pin-badge" title="Pinned message">📌</span>
					{/if}
					{#if message.isEdited}
						<span class="edited-badge" title="Edited">(edited)</span>
					{/if}
				</div>
			</div>

			<!-- Reply Preview -->
			{#if replyToMsg}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<div class="reply-preview" on:click={() => jumpToMessage(replyToMsg.id)}>
					<div class="reply-line"></div>
					<div class="reply-content">
						<span class="reply-username">
							{replyToMsg.user}
						</span>
						<span class="reply-text">{replyToMsg.text.substring(0, 100)}{replyToMsg.text.length > 100 ? '...' : ''}</span>
					</div>
				</div>
			{/if}

			<!-- Message Content or Edit Mode -->
			{#if editingMessageId === message.id}
				<div class="edit-mode">
					<textarea
						bind:value={editText}
						class="edit-textarea"
						rows="3"
						on:keydown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								saveEdit(message.id);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								cancelEdit();
							}
						}}
					></textarea>
					<div class="edit-actions">
						<button class="edit-cancel" on:click={cancelEdit}>Cancel</button>
						<button class="edit-save" on:click={() => saveEdit(message.id)}>Save</button>
					</div>
				</div>
			{:else}
				<div class="message-content">
					{#if message.type === 'gif' && message.gifUrl}
						<img src={message.gifUrl} alt="GIF" class="gif {message.isSpoiler ? 'spoiler' : ''}" data-spoiler={message.isSpoiler ? 'true' : 'false'} />
					{:else if message.type === 'emoji' && message.emojiUrl}
						<img src={message.emojiUrl} alt={message.emojiName || 'emoji'} class="emoji-large {message.isSpoiler ? 'spoiler' : ''}" data-spoiler={message.isSpoiler ? 'true' : 'false'} />
					{:else if message.type === 'file' && (message.fileUrl || message.files)}
						{#if message.files && message.files.length > 1}
							<!-- Multiple files gallery -->
							<div class="files-gallery" class:has-more={message.files.length > 4}>
								{#each message.files.slice(0, 4) as fileAttachment, index}
									{#if isImage(fileAttachment.fileName)}
										<!-- svelte-ignore a11y-click-events-have-key-events -->
										<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
										<div class="gallery-file-item" class:last-item={index === 3 && message.files.length > 4}>
											<img
												src={getFileUrl(fileAttachment.fileUrl)}
												alt={fileAttachment.fileName}
												class="gallery-file-image {message.isSpoiler ? 'spoiler' : ''}"
												data-spoiler={message.isSpoiler ? 'true' : 'false'}
												on:click={(e) => {
													if (e.button === 0) {
														const imageGallery = message.files
															.filter(f => isImage(f.fileName))
															.map(f => getFileUrl(f.fileUrl));
														enlargeImage(getFileUrl(fileAttachment.fileUrl), imageGallery);
													}
												}}
												title="Click to enlarge"
											/>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else if isVideo(fileAttachment.fileName)}
										<!-- svelte-ignore a11y-media-has-caption -->
										<!-- svelte-ignore a11y-click-events-have-key-events -->
										<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
										<div class="gallery-file-item" class:last-item={index === 3 && message.files.length > 4}>
											<video
												class="gallery-file-video {message.isSpoiler ? 'spoiler' : ''}"
												data-spoiler={message.isSpoiler ? 'true' : 'false'}
												on:click={(e) => e.button === 0 && enlargeVideo(getFileUrl(fileAttachment.fileUrl))}
												title="Click to enlarge"
											>
												<source src={getFileUrl(fileAttachment.fileUrl)} />
											</video>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else if isAudio(fileAttachment.fileName)}
										<!-- svelte-ignore a11y-media-has-caption -->
										<div class="gallery-file-item audio-item" class:last-item={index === 3 && message.files.length > 4}>
											<audio
												controls
												class="gallery-file-audio"
											>
												<source src={getFileUrl(fileAttachment.fileUrl)} type="audio/{fileAttachment.fileName?.split('.').pop()}" />
												Your browser does not support the audio element.
											</audio>
											<div class="audio-file-name">{fileAttachment.fileName}</div>
											{#if index === 3 && message.files.length > 4}
												<div class="more-overlay">
													<span class="more-count">+{message.files.length - 4}</span>
												</div>
											{/if}
										</div>
									{:else}
										<a href={getFileUrl(fileAttachment.fileUrl)} download={fileAttachment.fileName} class="gallery-file-item file-link">
											<div class="gallery-file-icon-large">{getFileIcon(fileAttachment.fileName)}</div>
											<div class="gallery-file-overlay">
												<span class="file-name-truncate">{fileAttachment.fileName}</span>
												<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
											</div>
										</a>
									{/if}
								{/each}
							</div>
						{:else if message.fileUrl}
							{#if isImage(message.fileName)}
							<!-- Display image inline -->
							<div class="image-container">
								<!-- svelte-ignore a11y-click-events-have-key-events -->
								<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
								<img
									src={getFileUrl(message.fileUrl)}
									alt={message.fileName}
									class="inline-image {message.isSpoiler ? 'spoiler' : ''}"
									data-spoiler={message.isSpoiler ? 'true' : 'false'}
									on:click={(e) => e.button === 0 && message.fileUrl && enlargeImage(getFileUrl(message.fileUrl))}
									on:contextmenu={(e) => handleImageContextMenu(e, message)}
									title="Click to enlarge, right-click for options"
								/>
								<a href={getFileUrl(message.fileUrl)} download={message.fileName} class="image-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
						{:else if isVideo(message.fileName)}
							<!-- Display video with player -->
							<div class="video-container">
								<!-- svelte-ignore a11y-media-has-caption -->
								<!-- svelte-ignore a11y-click-events-have-key-events -->
								<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
								<video
									controls
									class="inline-video {message.isSpoiler ? 'spoiler' : ''}"
									data-spoiler={message.isSpoiler ? 'true' : 'false'}
									on:click={(e) => {
										if (e.button === 0 && message.fileUrl) {
											enlargeVideo(getFileUrl(message.fileUrl));
										}
									}}
									on:contextmenu={(e) => handleImageContextMenu(e, message)}
									title="Click to enlarge, right-click for options"
								>
									<source src={getFileUrl(message.fileUrl)} type="video/{message.fileName?.split('.').pop()}" />
									Your browser does not support the video tag.
								</video>
								<a href={getFileUrl(message.fileUrl)} download={message.fileName} class="video-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
						{:else if isAudio(message.fileName)}
							<!-- Display audio with player -->
							<div class="audio-container">
								<!-- svelte-ignore a11y-media-has-caption -->
								<audio
									controls
									class="inline-audio"
								>
									<source src={getFileUrl(message.fileUrl)} type="audio/{message.fileName?.split('.').pop()}" />
									Your browser does not support the audio element.
								</audio>
								<div class="audio-file-info">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</div>
							</div>
						{:else}
							<!-- Display other files as download link -->
							<a href={getFileUrl(message.fileUrl)} download={message.fileName} class="file-attachment">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								<div class="file-info">
									<span class="file-name">{message.fileName}</span>
									<span class="file-size">{formatFileSize(message.fileSize)}</span>
								</div>
							</a>
						{/if}
						{/if}
						{#if message.text && (message.files ? message.text !== `Shared ${message.files.length} files` : message.text !== `Shared: ${message.fileName}`)}
							<div class="markdown-content">{@html parseMessage(message.text)}</div>
						{/if}
					{:else}
						<div class="markdown-content">{@html parseMessage(message.text)}</div>
					{/if}
				</div>
			{/if}

			{#if message.reactions && Object.keys(message.reactions).length > 0}
				<div class="reactions">
					{#each Object.entries(message.reactions) as [emojiId, userIds]}
						{@const emoji = getEmojiById(emojiId)}
						{#if emoji && userIds.length > 0}
							{@const userReacted = userIds.includes($currentUser?.id || '')}
							<button
								class="reaction-btn"
								class:user-reacted={userReacted}
								on:click={() => toggleReaction(message.id, emojiId)}
								title={userIds.map(id => $users.find(u => u.id === id)?.username).filter(Boolean).join(', ')}
							>
								<img src={emoji.url} alt={emoji.name} class="reaction-emoji" />
								<span class="reaction-count">{userIds.length}</span>
							</button>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/each}

<UserPopout
	bind:isOpen={showUserPopout}
	bind:user={popoutUser}
	anchorElement={popoutAnchorElement}
	isOwnProfile={popoutIsOwnProfile}
	on:close={() => showUserPopout = false}
/>

{#if showReactionPicker}
	<EmojiPicker
		on:select={handleReactionSelect}
		on:close={() => showReactionPicker = false}
	/>
{/if}

{#if contextMenuMessage}
	<MessageContextMenu
		message={contextMenuMessage}
		bind:visible={contextMenuVisible}
		x={contextMenuX}
		y={contextMenuY}
		onEdit={handleEdit}
		onDelete={handleDelete}
		onPin={handlePin}
		onReply={handleReply}
		onDownload={handleDownload}
		onForward={handleForward}
		onAddReaction={handleAddReaction}
	/>
{/if}

<ForwardDialog bind:visible={showForwardDialog} bind:message={forwardMessage} />

<ConfirmDialog
	isOpen={showDeleteConfirm}
	title="Delete Message"
	message="Are you sure you want to delete this message?"
	confirmText="Delete"
	variant="danger"
	onConfirm={confirmDeleteMessage}
	onCancel={() => showDeleteConfirm = false}
/>

{#if enlargedImage}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="image-modal" on:click={closeEnlargedImage}>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<img
			src={enlargedImage}
			alt="Enlarged"
			class="enlarged-image"
			on:click|stopPropagation
		/>

		<!-- Navigation arrows (only show if multiple images) -->
		{#if currentImageGallery.length > 1}
			<button class="nav-arrow nav-prev" on:click|stopPropagation={() => navigateImage('prev')} title="Previous (←)">
				‹
			</button>
			<button class="nav-arrow nav-next" on:click|stopPropagation={() => navigateImage('next')} title="Next (→)">
				›
			</button>
			<div class="image-counter">
				{currentImageIndex + 1} / {currentImageGallery.length}
			</div>
		{/if}

		<button class="close-modal" on:click={closeEnlargedImage}>✕</button>
		<a href={enlargedImage} target="_blank" rel="noopener noreferrer" class="open-new-tab">
			Open in new tab
		</a>
	</div>
{/if}

{#if enlargedVideo}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="video-modal" on:click={closeEnlargedVideo}>
		<!-- svelte-ignore a11y-media-has-caption -->
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<video
			controls
			autoplay
			class="enlarged-video"
			on:click|stopPropagation
		>
			<source src={enlargedVideo} />
			Your browser does not support the video tag.
		</video>
		<button class="close-modal" on:click={closeEnlargedVideo}>✕</button>
		<a href={enlargedVideo} target="_blank" rel="noopener noreferrer" class="open-new-tab">
			Open in new tab
		</a>
	</div>
{/if}

<style>
	.new-messages-divider {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin: 1rem 0;
		color: var(--color-danger-hover);
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	.new-messages-divider::before,
	.new-messages-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-danger-hover);
	}

	.message {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 8px;
		background: var(--bg-secondary);
		margin-bottom: 0.5rem;
		transition: all 0.2s;
		position: relative;
	}

	.message:hover {
		background: var(--bg-tertiary);
	}

	.message.highlighted {
		background: #5865f2;
		animation: highlight-pulse 2s ease-out;
		border: 2px solid #5865f2;
	}

	@keyframes highlight-pulse {
		0%, 100% {
			box-shadow: 0 0 0 0 rgba(88, 101, 242, 0.7);
		}
		50% {
			box-shadow: 0 0 20px 10px rgba(88, 101, 242, 0.3);
		}
	}

	.message.pinned {
		border-left: 3px solid var(--color-warning);
		background: var(--bg-warning-light);
	}

	.message-avatar {
		flex-shrink: 0;
		cursor: pointer;
	}

	.avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
	}

	.avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 1rem;
	}

	.message-body {
		flex: 1;
		min-width: 0;
		position: relative; /* Added for message-actions positioning */
	}

	.message-header {
		display: flex;
		justify-content: flex-start; /* Changed to flex-start */
		align-items: center;
		margin-bottom: 0.375rem;
		gap: 0.5rem;
	}

	.username {
		font-weight: 600;
		cursor: pointer;
	}

	.username:hover {
		text-decoration: underline;
	}

	.timestamp {
		/* Moved timestamp to message-actions */
		display: none;
	}

	.message-actions {
		position: absolute;
		top: -10px; /* Adjusted position to be slightly above the message body */
		right: 0px;
		display: flex;
		align-items: center;
		background: var(--bg-tertiary); /* Changed for more opacity */
		border-radius: 8px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); /* Increased shadow opacity */
		z-index: 10;
		opacity: 0;
		visibility: hidden;
		transform: translateY(10px);
		transition: opacity 0.2s ease-out, visibility 0.2s ease-out, transform 0.2s ease-out;
		padding: 0 5px; /* Added padding to the action bar itself */
		height: 30px; /* Fixed height for consistency */
	}

	.message:hover .message-actions {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
	}

	.timestamp-action {
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
		margin-right: 5px; /* Space between timestamp and first button */
		/* Added for better visibility against background */
		background-color: var(--bg-secondary);
		padding: 0 5px;
		border-radius: 4px;
	}

	.action-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		padding: 0.25rem; /* Adjusted padding for smaller buttons */
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		transition: color 0.2s, background-color 0.2s;
		height: 24px; /* Fixed height for icon */
		width: 24px; /* Fixed width for icon */
	}

	.action-btn:hover {
		color: var(--accent);
		background-color: var(--bg-tertiary);
		border-radius: 8px;
	}

	.action-btn svg {
		width: 18px;
		height: 18px;
		stroke-width: 2;
	}

	.reply-preview {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.reply-preview:hover {
		background: #5865f2;
		transform: translateX(4px);
	}

	.reply-preview:hover .reply-username,
	.reply-preview:hover .reply-text {
		color: #ffffff;
	}

	.reply-line {
		width: 3px;
		background: var(--accent);
		border-radius: 2px;
		flex-shrink: 0;
	}

	.reply-content {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.reply-username {
		font-weight: 600;
		font-size: 0.8125rem;
	}

	.reply-text {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.edit-mode {
		margin-top: 0.5rem;
	}

	.edit-textarea {
		width: 100%;
		padding: 0.75rem;
		border: none;
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.875rem;
		resize: vertical;
		min-height: 60px;
	}

	.edit-textarea:focus {
		outline: none;
		border-color: var(--accent);
	}

	.edit-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
		justify-content: flex-end;
	}

	.edit-cancel,
	.edit-save {
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.edit-cancel {
		background: white;
		border: none;
		color: var(--text-primary);
	}

	.edit-cancel:hover {
		background: var(--bg-tertiary);
	}

	.edit-save {
		background: var(--accent);
		border: none;
		color: white;
	}

	.edit-save:hover {
		opacity: 0.9;
	}

	.message-content {
		min-height: 24px; /* Ensure minimum height for message content */
	}

	.markdown-content :global(p) {
		margin: 0;
		line-height: 1.5;
	}

	.markdown-content :global(p:not(:last-child)) {
		margin-bottom: 0.5rem;
	}

	.markdown-content :global(strong) {
		font-weight: 600;
	}

	.markdown-content :global(em) {
		font-style: italic;
	}

	.markdown-content :global(a) {
		color: var(--color-info);
		text-decoration: underline;
	}

	.markdown-content :global(a:hover) {
		color: var(--color-info-hover);
	}

	/* Emote styles */
	.markdown-content :global(.emote) {
		display: inline-block;
		height: 1.5em;
		width: auto;
		vertical-align: middle;
		margin: 0 0.1em;
	}

	.markdown-content :global(.emote-animated) {
		/* Animated emotes can have special styling if needed */
	}

	/* Image modal styles */
	.image-modal {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.9);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 2rem;
	}

	.enlarged-image {
		max-width: 85vw;
		max-height: 85vh;
		object-fit: contain;
		border-radius: 8px;
		cursor: default;
	}

	.video-modal {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.9);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 2rem;
	}

	.enlarged-video {
		max-width: 85vw;
		max-height: 85vh;
		border-radius: 8px;
		cursor: default;
	}

	.close-modal {
		position: absolute;
		top: 1rem;
		right: 1rem;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.1);
		border: 2px solid rgba(255, 255, 255, 0.3);
		color: white;
		font-size: 1.5rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.close-modal:hover {
		background: rgba(255, 255, 255, 0.2);
		transform: scale(1.1);
	}

	.nav-arrow {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 50px;
		height: 50px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.1);
		border: 2px solid rgba(255, 255, 255, 0.3);
		color: white;
		font-size: 2.5rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		font-weight: 300;
		line-height: 1;
	}

	.nav-arrow:hover {
		background: rgba(255, 255, 255, 0.2);
		transform: translateY(-50%) scale(1.1);
	}

	.nav-prev {
		left: 2rem;
	}

	.nav-next {
		right: 2rem;
	}

	.image-counter {
		position: absolute;
		top: 1rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.5rem 1rem;
		background: rgba(0, 0, 0, 0.7);
		border: 1px solid rgba(255, 255, 255, 0.3);
		border-radius: 20px;
		color: white;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.open-new-tab {
		position: absolute;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.75rem 1.5rem;
		background: rgba(255, 255, 255, 0.1);
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 8px;
		color: white;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 500;
		transition: all 0.2s;
	}

	.open-new-tab:hover {
		background: rgba(255, 255, 255, 0.2);
		transform: translateX(-50%) translateY(-2px);
	}

	.files-gallery {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.25rem;
		margin-top: 0.5rem;
		max-width: 450px;
	}

	.gallery-file-item {
		position: relative;
		aspect-ratio: 1;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--border);
		cursor: pointer;
		transition: transform 0.2s;
		display: flex;
		flex-direction: column;
	}

	.gallery-file-item:hover {
		transform: scale(1.02);
	}

	.gallery-file-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.gallery-file-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		cursor: pointer;
	}

	.gallery-file-icon-large {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 4rem;
		background: var(--bg-secondary);
	}

	.gallery-file-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
		color: white;
		padding: 0.5rem;
		font-size: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.file-name-truncate {
		overflow: hidden;
		text-overflow: ellipsis;
		white-writeSpace: nowrap;
		font-weight: 500;
	}

	.file-size-small {
		font-size: 0.7rem;
		opacity: 0.9;
	}

	.file-link {
		text-decoration: none;
		color: inherit;
	}

	.more-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}

	.more-count {
		color: white;
		font-size: 2rem;
		font-weight: 700;
		text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
	}

	.gallery-file-item.last-item {
		cursor: pointer;
	}

	/* Spoiler styles */
	.spoiler {
		filter: blur(20px);
		cursor: pointer;
		position: relative;
		transition: filter 0.2s ease;
	}

	.spoiler::before {
		content: 'SPOILER - Click to reveal';
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: rgba(0, 0, 0, 0.8);
		color: white;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
		pointer-events: none;
		z-index: 1;
	}

	.spoiler.revealed {
		filter: none;
		cursor: default;
	}

	.spoiler.revealed::before {
		display: none;
	}

	/* Reactions */
	.reactions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.5rem;
	}

	.reaction-btn {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		background: var(--bg-tertiary);
		border: 1px solid var(--border);
		border-radius: 12px;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.reaction-btn:hover {
		background: var(--bg-hover);
		border-color: var(--color-primary);
		transform: scale(1.05);
	}

	.reaction-btn.user-reacted {
		background: rgba(88, 101, 242, 0.2);
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.reaction-emoji {
		width: 16px;
		height: 16px;
		object-fit: contain;
	}

	.reaction-count {
		font-weight: 600;
		font-size: 0.75rem;
	}

	/* ========== IMAGE & VIDEO SIZE LIMITS ========== */
	.inline-image {
		max-width: 450px;
		max-height: 400px;
		border-radius: 8px;
		cursor: pointer;
		object-fit: contain;
		display: block;
	}

	.inline-video {
		max-width: 450px;
		max-height: 400px;
		border-radius: 8px;
		cursor: pointer;
		display: block;
	}

	.gif {
		max-width: 400px;
		max-height: 350px;
		border-radius: 8px;
		cursor: pointer;
		display: block;
	}

	.image-container,
	.video-container {
		margin-top: 0.5rem;
		margin-bottom: 0.25rem;
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.message {
			padding: 0.6rem 0.5rem;
			gap: 0.375rem;
			margin-bottom: 0.125rem;
			border-radius: 4px;
		}

		/* Compact avatars */
		.avatar,
		.avatar-placeholder {
			width: 28px;
			height: 28px;
			font-size: 0.75rem;
		}

		.message-body {
			padding-right: 0.5rem;
		}

		.message-header {
			margin-bottom: 0.125rem;
		}

		.username {
			font-size: 0.9rem;
		}

		/* Hide message actions by default on mobile - use long press */
		.message-actions {
			display: none;
		}

		.message:active .message-actions {
			display: flex;
			position: absolute;
			top: -8px;
			right: 0;
			opacity: 1;
			visibility: visible;
		}

		.action-btn {
			width: 28px;
			height: 28px;
			padding: 0.25rem;
		}

		.action-btn svg {
			width: 14px;
			height: 14px;
		}

		.timestamp-action {
			font-size: 0.65rem;
			padding: 0 3px;
		}

		/* Compact reply preview */
		.reply-preview {
			padding: 0.25rem;
			font-size: 0.75rem;
			margin-bottom: 0.25rem;
		}

		.reply-line {
			width: 2px;
		}

		.reply-username {
			font-size: 0.7rem;
		}

		.reply-text {
			font-size: 0.7rem;
		}

		/* Edit mode */
		.edit-textarea {
			font-size: 16px;
			padding: 0.375rem;
			min-height: 50px;
		}

		.edit-actions {
			gap: 0.25rem;
			margin-top: 0.25rem;
		}

		.edit-cancel,
		.edit-save {
			padding: 0.375rem 0.75rem;
			font-size: 0.8rem;
			min-height: 36px;
		}

		/* Compact media */
		.inline-image {
			max-width: 100%;
			max-height: 180px;
			border-radius: 6px;
		}

		.inline-video {
			max-width: 100%;
			max-height: 180px;
			border-radius: 6px;
		}

		.gif {
			max-width: 100%;
			max-height: 150px;
			border-radius: 6px;
		}

		.emoji-large {
			width: 48px;
			height: 48px;
		}

		/* Compact file gallery */
		.files-gallery {
			grid-template-columns: repeat(2, 1fr);
			gap: 0.25rem;
			max-width: 100%;
		}

		.gallery-file-icon-large {
			font-size: 2rem;
		}

		.gallery-file-overlay {
			padding: 0.25rem;
			font-size: 0.65rem;
		}

		/* File attachments */
		.file-attachment {
			padding: 0.375rem;
		}

		.file-icon {
			font-size: 1.25rem;
		}

		.file-name {
			font-size: 0.75rem;
		}

		.file-size {
			font-size: 0.65rem;
		}

		/* Image/Video modal */
		.image-modal,
		.video-modal {
			padding: 0.25rem;
		}

		.enlarged-image,
		.enlarged-video {
			max-width: 98vw;
			max-height: 85vh;
			border-radius: 4px;
		}

		.close-modal {
			top: 0.25rem;
			right: 0.25rem;
			width: 36px;
			height: 36px;
			font-size: 1.25rem;
		}

		.nav-arrow {
			width: 36px;
			height: 36px;
			font-size: 1.5rem;
		}

		.nav-prev {
			left: 0.25rem;
		}

		.nav-next {
			right: 0.25rem;
		}

		.image-counter {
			top: 0.25rem;
			font-size: 0.7rem;
			padding: 0.25rem 0.5rem;
		}

		.open-new-tab {
			bottom: 0.25rem;
			padding: 0.375rem 0.75rem;
			font-size: 0.75rem;
		}

		/* Compact reactions */
		.reactions {
			gap: 0.125rem;
			margin-top: 0.25rem;
		}

		.reaction-btn {
			padding: 0.25rem 0.375rem;
			min-height: 24px;
			border-radius: 8px;
		}

		.reaction-emoji {
			width: 14px;
			height: 14px;
		}

		.reaction-count {
			font-size: 0.65rem;
		}

		/* Compact markdown */
		.markdown-content {
			font-size: 16px;
			line-height: 1.5;
		}

		.markdown-content :global(p) {
			line-height: 1.5;
		}

		/* New messages divider */
		.new-messages-divider {
			margin: 0.375rem 0;
			font-size: 0.7rem;
		}

		/* Pin badge */
		.pin-badge {
			font-size: 0.7rem;
		}

		.edited-badge {
			font-size: 0.65rem;
		}
	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.message {
			padding: 0.25rem;
			gap: 0.25rem;
		}

		.avatar,
		.avatar-placeholder {
			width: 24px;
			height: 24px;
			font-size: 0.65rem;
		}

		.username {
			font-size: 0.75rem;
		}

		.markdown-content {
			font-size: 0.8rem;
		}

		.inline-image,
		.inline-video,
		.gif {
			max-height: 140px;
		}

		.emoji-large {
			width: 40px;
			height: 40px;
		}

		.files-gallery {
			grid-template-columns: 1fr 1fr;
		}
	}

/* --- Refined Mobile/Desktop Readability Styles --- */

/* Apply padding for desktop hover actions */
@media (min-width: 769px) {
    .message-body {
        padding-right: 90px;
    }
}

/* Apply improved readability styles for mobile */
@media (max-width: 768px) {
    .markdown-content {
        font-size: 16px;
        line-height: 1.5;
    }
    .markdown-content :global(p) {
        line-height: 1.5;
    }
    .message-body {
        padding-right: 0.5rem;
    }
    .message {
        padding-top: 0.6rem;
        padding-bottom: 0.6rem;
    }
}
</style>
