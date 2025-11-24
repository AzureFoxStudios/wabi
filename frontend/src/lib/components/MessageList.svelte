<script lang="ts">
	import type { Message, User } from '$lib/socket';
	import { users, currentUser, currentChannel, editMessage, deleteMessage, togglePinMessage } from '$lib/socket';
	import ProfileModal from './ProfileModal.svelte';
	import MessageContextMenu from './MessageContextMenu.svelte';
	import { parseMessage } from '$lib/markdown';
	import '$lib/prism-theme.css';

	export let messages: Message[];
	export let onReply: (message: Message) => void = () => {};
	export let firstUnreadMessageId: string | null = null;

	let showProfileModal = false;
	let selectedUser: User | null = null;
	let isOwnProfile = false;

	// Context menu state
	let contextMenuVisible = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuMessage: Message | null = null;

	// Edit mode state
	let editingMessageId: string | null = null;
	let editText = '';

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
		return user?.color || '#6b7280';
	}

	function openProfile(user: User) {
		selectedUser = user;
		isOwnProfile = user.id === $currentUser?.id;
		showProfileModal = true;
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
		if (confirm('Are you sure you want to delete this message?')) {
			deleteMessage($currentChannel, contextMenuMessage.id);
		}
		contextMenuVisible = false;
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

	function formatFileSize(bytes?: number): string {
		if (!bytes) return '';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	function getReplyToMessage(replyToId?: string): Message | undefined {
		if (!replyToId) return undefined;
		return messages.find(m => m.id === replyToId);
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

	let enlargedImage: string | null = null;

	function enlargeImage(imageUrl: string) {
		enlargedImage = imageUrl;
	}

	function closeEnlargedImage() {
		enlargedImage = null;
	}
</script>

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
		class="message {message.isPinned ? 'pinned' : ''}"
		on:contextmenu={(e) => handleContextMenu(e, message)}
	>
		<!-- Profile Picture -->
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
						<button class="username" style="color: {getUserColor(message.user)}" on:click={() => openProfile(user)}>
							{message.user}
						</button>
					{:else}
						<span class="username" style="color: {getUserColor(message.user)}">{message.user}</span>
					{/if}
					{#if message.isPinned}
						<span class="pin-badge" title="Pinned message">📌</span>
					{/if}
					{#if message.isEdited}
						<span class="edited-badge" title="Edited">(edited)</span>
					{/if}
				</div>
				<span class="timestamp">{formatTime(message.timestamp)}</span>
			</div>

			<!-- Reply Preview -->
			{#if replyToMsg}
				<div class="reply-preview">
					<div class="reply-line"></div>
					<div class="reply-content">
						<span class="reply-username" style="color: {getUserColor(replyToMsg.user)}">
							{replyToMsg.user}
						</span>
						<span class="reply-text">{replyToMsg.text.substring(0, 100)}{replyToMsg.text.length > 100 ? '...' : ''}</span>
					</div>
				</div>
			{/if}

			<!-- Message Content or Edit Mode -->
			{#if editingMessageId === message.id}
				<div class="edit-mode">
					<textarea bind:value={editText} class="edit-textarea" rows="3"></textarea>
					<div class="edit-actions">
						<button class="edit-cancel" on:click={cancelEdit}>Cancel</button>
						<button class="edit-save" on:click={() => saveEdit(message.id)}>Save</button>
					</div>
				</div>
			{:else}
				<div class="message-content">
					{#if message.type === 'gif' && message.gifUrl}
						<img src={message.gifUrl} alt="GIF" class="gif" />
					{:else if message.type === 'file' && message.fileUrl}
						{#if isImage(message.fileName)}
							<!-- Display image inline -->
							<div class="image-container">
								<!-- svelte-ignore a11y-click-events-have-key-events -->
								<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
								<img
									src={message.fileUrl}
									alt={message.fileName}
									class="inline-image"
									on:click={() => message.fileUrl && enlargeImage(message.fileUrl)}
									title="Click to enlarge"
								/>
								<a href={message.fileUrl} download={message.fileName} class="image-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
						{:else if isVideo(message.fileName)}
							<!-- Display video with player -->
							<div class="video-container">
								<!-- svelte-ignore a11y-media-has-caption -->
								<video controls class="inline-video">
									<source src={message.fileUrl} type="video/{message.fileName?.split('.').pop()}" />
									Your browser does not support the video tag.
								</video>
								<a href={message.fileUrl} download={message.fileName} class="video-download-link">
									<span class="file-icon">{getFileIcon(message.fileName)}</span>
									{message.fileName}
									<span class="file-size">({formatFileSize(message.fileSize)})</span>
								</a>
							</div>
						{:else}
							<!-- Display other files as download link -->
							<a href={message.fileUrl} download={message.fileName} class="file-attachment">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								<div class="file-info">
									<span class="file-name">{message.fileName}</span>
									<span class="file-size">{formatFileSize(message.fileSize)}</span>
								</div>
							</a>
						{/if}
						{#if message.text && message.text !== `Shared: ${message.fileName}`}
							<div class="markdown-content">{@html parseMessage(message.text)}</div>
						{/if}
					{:else}
						<div class="markdown-content">{@html parseMessage(message.text)}</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/each}

<ProfileModal bind:isOpen={showProfileModal} bind:user={selectedUser} {isOwnProfile} />

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
	/>
{/if}

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
		<button class="close-modal" on:click={closeEnlargedImage}>✕</button>
		<a href={enlargedImage} target="_blank" rel="noopener noreferrer" class="open-new-tab">
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
		color: #ef4444;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	.new-messages-divider::before,
	.new-messages-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: #ef4444;
	}

	.message {
		display: flex;
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

	.message.pinned {
		border-left: 3px solid #f59e0b;
		background: #fffbeb;
	}

	.message-avatar {
		flex-shrink: 0;
	}

	.avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid var(--border);
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
		border: 2px solid var(--border);
	}

	.message-body {
		flex: 1;
		min-width: 0;
	}

	.message-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.375rem;
		gap: 0.5rem;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.username {
		font-weight: 600;
		font-size: 0.9rem;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.username:hover {
		opacity: 0.8;
		text-decoration: underline;
	}

	.pin-badge {
		font-size: 0.875rem;
	}

	.edited-badge {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.timestamp {
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.reply-preview {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
		font-size: 0.875rem;
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
		border: 1px solid var(--border);
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
		border: 1px solid var(--border);
		color: var(--text-primary);
	}

	.edit-cancel:hover {
		background: var(--bg-tertiary);
	}

	.edit-save {
		background: var(--accent);
		border: 1px solid var(--accent);
		color: white;
	}

	.edit-save:hover {
		opacity: 0.9;
	}

	.message-content p {
		color: var(--text-primary);
		line-height: 1.5;
		word-wrap: break-word;
		margin: 0;
	}

	.gif {
		max-width: 100%;
		max-height: 300px;
		border-radius: 8px;
		display: block;
	}

	.file-attachment {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		text-decoration: none;
		color: var(--text-primary);
		transition: background-color 0.2s;
		margin-bottom: 0.5rem;
	}

	.file-attachment:hover {
		background: #e5e7eb;
	}

	.file-icon {
		font-size: 1.5rem;
	}

	.file-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.file-name {
		font-weight: 500;
		font-size: 0.875rem;
	}

	.file-size {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	/* Image display styles */
	.image-container {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		align-items: flex-start;
	}

	.inline-image {
		max-width: 400px;
		max-height: 300px;
		width: auto;
		height: auto;
		border-radius: 8px;
		display: block;
		cursor: pointer;
		transition: opacity 0.2s;
		object-fit: contain;
	}

	.inline-image:hover {
		opacity: 0.9;
	}

	.image-download-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
		text-decoration: none;
		color: var(--text-primary);
		font-size: 0.875rem;
		transition: background-color 0.2s;
	}

	.image-download-link:hover {
		background: #e5e7eb;
	}

	/* Video display styles */
	.video-container {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.inline-video {
		max-width: 100%;
		max-height: 400px;
		border-radius: 8px;
		background: #000;
	}

	.video-download-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border-radius: 6px;
		text-decoration: none;
		color: var(--text-primary);
		font-size: 0.875rem;
		transition: background-color 0.2s;
	}

	.video-download-link:hover {
		background: #e5e7eb;
	}

	/* Markdown content styles */
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
		color: #3b82f6;
		text-decoration: underline;
	}

	.markdown-content :global(a:hover) {
		color: #2563eb;
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
		max-width: 90vw;
		max-height: 90vh;
		object-fit: contain;
		border-radius: 8px;
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
</style>
