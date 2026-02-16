<script lang="ts">
	import { onMount, tick, createEventDispatcher } from 'svelte';
	import { channelMessages, channels, currentChannel, typingUsers, sendMessage, sendTyping, lastReadMessageId, editMessage, currentUser, emojis, users, dmPanelSignal, createDM, getDMChannelIdForUser, socket, type Message, type Emoji, type User, type Channel } from '$lib/socket';
	import { resources, graphEdges } from '$lib/business/store';
	import { todos, projects, calendarEvents, diaryEntries } from '$lib/business/store';
	import type { Resource } from '$lib/business/types';
	import { pinChannel, unpinChannel } from '$lib/socket';
	import EmojiPicker from './EmojiPicker.svelte';
	import MessageList from './MessageList.svelte';
	import PinnedMessages from './PinnedMessages.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import AudioRecorder from './AudioRecorder.svelte';
	import CameraCapture from './CameraCapture.svelte';
	import { parseCommand, formatCommandHelp, getMatchingCommands, type Command } from '$lib/commands';
	import { layoutStore } from '$lib/layoutStore';
	import { isInCall, startCall } from '$lib/calling';
	import { getServerUrl } from '$lib/serverUrl';

	const dispatch = createEventDispatcher();

	$: messages = $channelMessages[$currentChannel] || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: channelDisplayName = currentChannelData?.name || $currentChannel;
	$: channelDescription = currentChannelData?.description?.trim() || '';

	// Safeguard: DM channels should never be displayed in the main chat area
	// They should only appear in the DM panel on the right side
	// This check prevents accidental rendering of DMs in the middle chat
	$: isDMChannel = currentChannelData?.type === 'dm';
	$: dmCallTargetUser = getDMOtherUser(currentChannelData);

	let messageInput = '';
	let chatContainer: HTMLElement;
	let typingTimeout: number;
	let lastTypingEmit = 0;
	const TYPING_THROTTLE_MS = 300; // Max one typing event per 300ms
	let showEmojiPicker = false;
	let showMediaMenu = false;
	let emojiPickerButton: HTMLButtonElement;
	let emojiPickerContainer: HTMLElement | null = null;
	let mediaMenuContainer: HTMLElement | null = null;
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

	// Command palette
	let commandPalette: CommandPalette;
	let showCommandPalette = false;
	let commandPaletteSelectedIndex = 0;

	// Search functionality
	let searchInput = '';
	let filteredMessages: Message[] = [];

	// Photo and audio capture
	let showCameraCapture = false;
	let showAudioRecorder = false;

	// Format typing users list with proper grammar
	function formatTypingUsers(users: string[]): string {
		if (users.length === 0) return '';
		if (users.length === 1) return `${users[0]} is typing...`;
		if (users.length === 2) return `${users[0]} and ${users[1]} are typing...`;
		if (users.length >= 6) return 'Many users are typing...';

		// 3-5 users: "User1, User2, and User3 are typing..."
		const allButLast = users.slice(0, -1).join(', ');
		const lastUser = users[users.length - 1];
		return `${allButLast}, and ${lastUser} are typing...`;
	}

	function getDMOtherUser(channel?: Channel): User | null {
		if (!channel || channel.type !== 'dm') return null;
		if (channel.otherUser) return channel.otherUser;

		const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
		const otherStableId = (channel.members || []).find((id: string) => id !== myStableId);
		if (!otherStableId) return null;

		if (otherStableId.startsWith('user-')) {
			const dbId = parseInt(otherStableId.substring(5), 10);
			return $users.find(u => u.dbUserId === dbId) || null;
		}
		return $users.find(u => u.id === otherStableId) || null;
	}

	async function startDMVoiceCall() {
		if (!$socket || !dmCallTargetUser) return;
		try {
			await startCall($socket, dmCallTargetUser.id, false);
		} catch (error) {
			alert('Failed to start voice call. Please check microphone permissions.');
		}
	}

	async function startDMVideoCall() {
		if (!$socket || !dmCallTargetUser) return;
		try {
			await startCall($socket, dmCallTargetUser.id, true);
		} catch (error) {
			alert('Failed to start video call. Please check camera and microphone permissions.');
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

		// Throttle typing emissions - max once per TYPING_THROTTLE_MS
		const now = Date.now();
		if (now - lastTypingEmit >= TYPING_THROTTLE_MS) {
			sendTyping(true, $currentChannel);
			lastTypingEmit = now;
		}

		// Debounce stop typing
		if (typingTimeout) {
			clearTimeout(typingTimeout);
		}

		typingTimeout = setTimeout(() => {
			sendTyping(false, $currentChannel);
		}, 1000) as unknown as number;
	}

	function handleInputChange() {
		// Show command palette if input starts with /
		if (messageInput.startsWith('/')) {
			showCommandPalette = getMatchingCommands(messageInput).length > 0;
		} else {
			showCommandPalette = false;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		// Command palette navigation
		if (showCommandPalette && commandPalette) {
			const handled = commandPalette.handleKeyDown(e.key);
			if (handled) {
				e.preventDefault();
				return;
			}
		}

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
		// Escape to cancel editing/command palette
		else if (e.key === 'Escape') {
			e.preventDefault();
			if (showCommandPalette) {
				showCommandPalette = false;
			} else if (editingMessage) {
				cancelEdit();
			}
		}
		// Enter without shift sends the message
		else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
		// Shift+Enter adds a new line (default textarea behavior)
	}

	function handleCommandSelect(command: Command) {
		// Replace the / command with selected command name
		messageInput = `/${command.name} `;
		showCommandPalette = false;
		textareaElement?.focus();
	}

	function executeCommand(commandInput: string) {
		const parsed = parseCommand(commandInput);

		if (parsed.error) {
			console.warn(parsed.error);
			return;
		}

		if (!parsed.command) return;

		const commandName = parsed.command.name;

		switch (commandName) {
			case 'help':
			case 'h':
			case '?':
				alert(`Available Commands:\n\n${formatCommandHelp()}`);
				break;

			case 'resource':
			case 'res':
			case 'r': {
				// /resource <name> [-a] [-tag tagname]
				const resourceName = parsed.args.join(' ');
				if (!resourceName) {
					alert('Resource name is required.\nUsage: /resource <name> [-a] [-tag tagname]');
					return;
				}

					const tag = typeof parsed.flags['tag'] === 'string' ? parsed.flags['tag'] : undefined;
					const newResource: Resource = {
						id: `res-${Date.now()}`,
						name: resourceName,
						type: 'note',
						storageType: 'inline',
						createdAt: Date.now(),
						updatedAt: Date.now(),
						createdBy: parsed.flags['a'] ? 'Anonymous' : ($currentUser?.username || 'Unknown'),
						isAnonymous: !!parsed.flags['a'],
						visibilityType: 'public',
						tags: tag ? [tag] : []
					};

				resources.update(r => [...r, newResource]);
				alert(`Resource "${resourceName}" created!`);
				break;
			}

			case 'search':
			case 's': {
				// /search <term> [-by username] [-has image|video|file|link]
				const searchTerm = parsed.args.join(' ');
				if (!searchTerm) {
					alert('Search term is required.\nUsage: /search <term> [-by username] [-has image|video|file|link]');
					return;
				}
				searchInput = searchTerm;
				if (parsed.flags['by']) {
					searchInput += ` by:${parsed.flags['by']}`;
				}
				if (parsed.flags['has']) {
					searchInput += ` has:${parsed.flags['has']}`;
				}
				break;
			}

			case 'pin':
			case 'p': {
				// /pin [channelName] - pin a channel by name, or current channel if no arg
				let targetChannelId = $currentChannel;
				if (parsed.args.length > 0) {
					const channelName = parsed.args.join(' ');
					const targetChannel = $channels.find(ch =>
						ch.name.toLowerCase() === channelName.toLowerCase()
					);
					if (!targetChannel) {
						alert(`Channel "${channelName}" not found!`);
						return;
					}
					targetChannelId = targetChannel.id;
				}
				pinChannel(targetChannelId);
				const channelName = $channels.find(ch => ch.id === targetChannelId)?.name || 'Channel';
				alert(`"${channelName}" pinned!`);
				break;
			}

			case 'unpin':
			case 'up': {
				// /unpin [channelName] - unpin a channel by name, or current channel if no arg
				let targetChannelId = $currentChannel;
				if (parsed.args.length > 0) {
					const channelName = parsed.args.join(' ');
					const targetChannel = $channels.find(ch =>
						ch.name.toLowerCase() === channelName.toLowerCase()
					);
					if (!targetChannel) {
						alert(`Channel "${channelName}" not found!`);
						return;
					}
					targetChannelId = targetChannel.id;
				}
				unpinChannel(targetChannelId);
				const channelName = $channels.find(ch => ch.id === targetChannelId)?.name || 'Channel';
				alert(`"${channelName}" unpinned!`);
				break;
			}

			case 'todo':
			case 'todos':
			case 'tasks': {
				// /todo [-open]
				const todoList = $todos;
				if (todoList.length === 0) {
					alert('No todos yet!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const todoText = todoList
					.map((t, i) => `${i + 1}. ${t.status === 'done' ? 'DONE' : 'OPEN'} ${t.title}`)
					.join('\n');

				const message = `My Todos${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${todoText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`My Todos:\n\n${todoText}`);
				}
				break;
			}

			case 'calendar':
			case 'cal':
			case 'events': {
				// /calendar [-open]
				const now = Date.now();
				const upcoming = $calendarEvents
					.filter(e => e.startDate >= now)
					.sort((a, b) => a.startDate - b.startDate)
					.slice(0, 10);

				if (upcoming.length === 0) {
					alert('No upcoming events!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const eventText = upcoming
					.map(e => {
						const date = new Date(e.startDate).toLocaleDateString();
						return `${e.title} - ${date}`;
					})
					.join('\n');

				const message = `Upcoming Events${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${eventText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`Upcoming Events:\n\n${eventText}`);
				}
				break;
			}

			case 'journal':
			case 'j':
			case 'diary': {
				// /journal [-open]
				const entries = $diaryEntries.slice(0, 5);

				if (entries.length === 0) {
					alert('No journal entries yet!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const entryText = entries
					.map(e => {
						const date = new Date(e.createdAt).toLocaleDateString();
						return `${date}: ${e.content.substring(0, 100)}...`;
					})
					.join('\n');

				const message = `Recent Journal Entries${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${entryText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`Recent Journal Entries:\n\n${entryText}`);
				}
				break;
			}

			case 'projects':
			case 'proj': {
				// /projects [-open]
				const projectList = $projects;

				if (projectList.length === 0) {
					alert('No projects yet!');
					return;
				}

				const isOpen = !!parsed.flags['open'];
				const projText = projectList
					.map(p => `${p.name} - ${p.status}`)
					.join('\n');

				const message = `My Projects${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${projText}\n\`\`\``;

				if (isOpen) {
					sendMessage($currentChannel, message, 'text', {});
				} else {
					alert(`My Projects:\n\n${projText}`);
				}
				break;
			}

			case 'art':
			case 'a':
			case 'graph':
			case 'resources': {
				// /art - Navigate to Art/Knowledge Graph portal
				window.location.href = '/art';
				break;
			}

			case 'business':
			case 'b':
			case 'hub':
			case 'tasks': {
				// /business - Navigate to Business Hub
				window.location.href = '/business';
				break;
			}

			case 'mainchat':
			case 'main':
			case 'chat':
			case 'home': {
				// /mainchat - Return to main Wabi Chat
				window.location.href = '/';
				break;
			}

			case 'dm':
			case 'message':
			case 'msg': {
				const username = parsed.args.join(' ');
				if (!username) {
					alert('Please specify a username.\nUsage: /dm <username>');
					return;
				}

				const targetUser = $users.find(u =>
					u.username.toLowerCase() === username.toLowerCase()
				);

				if (!targetUser) {
					alert(`User "${username}" not found or offline.`);
					return;
				}

				// Check if DM already exists using stable IDs
				const dmId = getDMChannelIdForUser($currentUser, targetUser);
				const existingDM = $channels.find(ch => ch.id === dmId);

				if (existingDM) {
					// Open existing DM in right panel
					dmPanelSignal.set({ channelId: dmId, otherUser: targetUser });
				} else {
					// Create new DM (will auto-open via dmPanelSignal)
					createDM(targetUser.id);
				}
				break;
			}

			case 'logout':
			case 'signout':
			case 'exit': {
				// /logout - Log out and clear session
				dispatch('logout');
				break;
			}

			default:
				console.warn(`Unknown command: ${commandName}`);
		}
	}

	function handleSubmit() {
		if (messageInput.trim()) {
			if (editingMessage) {
				// Edit the existing message
				editMessage($currentChannel, editingMessage.id, messageInput.trim());
				editingMessage = null;
			} else {
				const trimmedMessage = messageInput.trim();

				// Check if it's a command
				if (trimmedMessage.startsWith('/')) {
					executeCommand(trimmedMessage);
					messageInput = '';
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
			showMediaMenu = false;
			sendTyping(false, $currentChannel);

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
		showEmojiPicker = false;
		showMediaMenu = false;
		textareaElement?.focus();
	}

	function handleEmojiSelect(event: CustomEvent<{ emoji: Emoji }>) {
		const emoji = event.detail.emoji;
		showEmojiPicker = false;
		showMediaMenu = false;

		// Insert emoji syntax into the composer and let the user send explicitly.
		const emojiToken = `:${emoji.name}:`;
		const shouldAddSpace = messageInput.length > 0 && !/\s$/.test(messageInput);
		messageInput = shouldAddSpace ? `${messageInput} ${emojiToken}` : `${messageInput}${emojiToken}`;
		textareaElement?.focus();
	}

	function handleReply(message: Message) {
		replyingTo = message;
		textareaElement?.focus();
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

	async function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;

		// Check for files/images in clipboard
		const files: File[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) {
					e.preventDefault(); // Prevent default paste
					files.push(file);
				}
			}
		}

		// If files found, add to selectedFiles (reuse existing upload logic)
		if (files.length > 0) {
			// Check file sizes
			const maxSize = 1024 * 1024 * 1024; // 1GB
			for (const file of files) {
				if (file.size > maxSize) {
					alert(`File too large! Maximum size is 1GB per file. "${file.name}" is ${(file.size / 1024 / 1024).toFixed(2)}MB`);
					return;
				}
			}

			selectedFiles = [...selectedFiles, ...files];
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
			return;
		}

		// If no files, check if text content exists
		const text = e.clipboardData?.getData('text');
		if (text && text.trim()) {
			// Only send typing indicator if actual text content exists
			handleInput();
		}
		// If empty paste (no files, no text), do nothing - prevents false typing
	}

	async function uploadSelectedFiles() {
		if (selectedFiles.length === 0) return;

		isUploading = true;
		const totalFiles = selectedFiles.length;
		let completedFiles = 0;

		try {
			const serverUrl = getServerUrl();

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

					// Add authentication header
					const authToken = localStorage.getItem('authToken');
					if (authToken) {
						xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
					} else {
						const sessionId = localStorage.getItem('sessionId');
						if (sessionId) {
							xhr.setRequestHeader('X-Session-Id', sessionId);
						}
					}

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

	// Handle photo capture
	async function handlePhotoCapture(event: CustomEvent<Blob>) {
		const blob = event.detail;
		const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });

		// Validate file size (10MB limit)
		if (file.size > 10 * 1024 * 1024) {
			alert('Photo too large (max 10MB). Please try again.');
			return;
		}

		selectedFiles = [file];
		await uploadSelectedFiles();
		showCameraCapture = false;
		showMediaMenu = false;
	}

	// Handle audio recording
	async function handleAudioSend(event: CustomEvent<Blob>) {
		const blob = event.detail;
		const ext = blob.type.includes('webm') ? 'webm' : 'm4a';
		const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: blob.type });

		// Validate file size (10MB limit)
		if (file.size > 10 * 1024 * 1024) {
			alert('Audio too large (max 10MB). Please try again.');
			return;
		}

		selectedFiles = [file];
		await uploadSelectedFiles();
		showAudioRecorder = false;
		showMediaMenu = false;
	}

	function handleOpenFilePicker() {
		showMediaMenu = false;
		fileInput?.click();
	}

	function handleOpenCameraCapture() {
		showMediaMenu = false;
		showCameraCapture = true;
	}

	function handleOpenAudioRecorder() {
		showMediaMenu = false;
		showAudioRecorder = true;
	}

	// Check if browser supports media capture
	function supportsMediaCapture(): boolean {
		return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
	}

	onMount(() => {
		scrollToBottom();

		const handleGlobalClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && emojiPickerContainer?.contains(target)) return;
			if (target && mediaMenuContainer?.contains(target)) return;
			showMediaMenu = false;
			showEmojiPicker = false;
		};

		document.addEventListener('click', handleGlobalClick);
		return () => {
			document.removeEventListener('click', handleGlobalClick);
		};
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

	<div class="chat-header" class:dm-channel={isDMChannel}>
		<h2>
			<span class="channel-title">{channelDisplayName}</span>
			{#if isDMChannel}
				<span class="dm-badge">Direct Message</span>
			{:else if channelDescription}
				<span class="channel-description">{channelDescription}</span>
			{/if}
		</h2>
		<div class="header-actions">
			{#if isDMChannel && dmCallTargetUser}
				<div class="dm-call-actions">
					<button class="dm-call-btn" on:click={startDMVoiceCall} title="Voice call {dmCallTargetUser.username}">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
						<span>Call</span>
					</button>
					<button class="dm-call-btn" on:click={startDMVideoCall} title="Video call {dmCallTargetUser.username}">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
						<span>Video</span>
					</button>
				</div>
			{/if}
			<div class="search-container">
			<input
				type="text"
				bind:value={searchInput}
				placeholder="Search (by:username, has:image, etc.)"
				class="search-input"
			/>
			{#if searchInput}
				<span class="search-results">{filteredMessages.length} result{filteredMessages.length !== 1 ? 's' : ''}</span>
			{/if}
			</div>
		</div>
	</div>

	<!-- TEMPORARY: DMs now render in center like channels -->
	<div class="messages" bind:this={chatContainer}>
			{#if !searchInput}
				<PinnedMessages pinnedMessages={pinnedMessages} />
			{/if}
			<MessageList messages={filteredMessages} onReply={handleReply} firstUnreadMessageId={$lastReadMessageId} />

			{#if ($typingUsers[$currentChannel] || []).length > 0}
				<div class="typing-indicator">
					<span class="typing-dots"></span>
					<span>{formatTypingUsers($typingUsers[$currentChannel] || [])}</span>
				</div>
			{/if}
		</div>

		{#if showEmojiPicker}
			<div class="emoji-picker-container" bind:this={emojiPickerContainer}>
				<EmojiPicker
					on:select={handleEmojiSelect}
					on:gif={handleGifSelect}
					on:close={() => showEmojiPicker = false}
				/>
			</div>
		{/if}

		<CameraCapture
			isOpen={showCameraCapture}
			on:close={() => showCameraCapture = false}
			on:capture={handlePhotoCapture}
		/>

		<AudioRecorder
			isOpen={showAudioRecorder}
			on:close={() => showAudioRecorder = false}
			on:send={handleAudioSend}
		/>

		{#if !($layoutStore.isMobile && $isInCall)}
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
					<span class="reply-preview">
						{#if replyingTo.text}
							{replyingTo.text.substring(0, 50)}{replyingTo.text.length > 50 ? '...' : ''}
						{:else if replyingTo.type === 'gif'}
							GIF
						{:else if replyingTo.type === 'emoji'}
							:{replyingTo.emojiName || 'sticker'}:
						{:else}
							Attachment
						{/if}
					</span>
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
			<CommandPalette
				bind:this={commandPalette}
				bind:input={messageInput}
				bind:isVisible={showCommandPalette}
				bind:selectedIndex={commandPaletteSelectedIndex}
				onSelect={handleCommandSelect}
			/>
			<div class="input-buttons-left">
				<div class="media-menu-container" bind:this={mediaMenuContainer}>
					<button
						class="input-icon-button"
						on:click|stopPropagation={() => {
							showMediaMenu = !showMediaMenu;
							if (showMediaMenu) showEmojiPicker = false;
						}}
						title="Add media"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
					</button>
					{#if showMediaMenu}
						<div class="media-menu">
							<button class="media-menu-item" on:click={handleOpenFilePicker}>Upload file</button>
							{#if supportsMediaCapture()}
								<button class="media-menu-item" on:click={handleOpenCameraCapture}>Take photo</button>
								<button class="media-menu-item" on:click={handleOpenAudioRecorder}>Record audio</button>
							{/if}
						</div>
					{/if}
				</div>
			</div>
			<textarea
				bind:this={textareaElement}
				bind:value={messageInput}
				on:paste={handlePaste}
				on:input={() => {
					handleInput();
					handleInputChange();
				}}
				on:keydown={handleKeyDown}
				placeholder="Type a message... or /help for commands (Shift+Enter for new line)"
				maxlength="2000"
				rows="1"
			></textarea>
			<button
				bind:this={emojiPickerButton}
				class="input-icon-button"
				on:click|stopPropagation={() => {
				showEmojiPicker = !showEmojiPicker;
				if (showEmojiPicker) showMediaMenu = false;
			}}
				title="Add emoji"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
			</button>
			<button
				class="send-button"
				on:click={handleSubmit}
				disabled={!messageInput.trim()}
				title="Send message"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
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
		background-image: var(--background-image-url, none);
		background-size: var(--background-image-size, cover);
		background-position: var(--background-image-position, center);
		background-repeat: var(--background-image-repeat, no-repeat);
		background-blend-mode: var(--background-image-blend, overlay);
		overflow: hidden;
	}

	.chat-container::before {
		content: '';
		position: absolute;
		inset: 0;
		background-color: rgba(0, 0, 0, calc(1 - var(--background-image-opacity, 1)));
		filter: blur(var(--background-image-blur, 0px));
		pointer-events: none;
		z-index: 0;
	}

	.chat-header {
		flex-shrink: 0;
		padding: 0.75rem 1rem;
		background: var(--bg-primary);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 52px;
		box-sizing: border-box;
		z-index: 2;
	}

	.chat-header h2 {
		font-size: var(--text-xl);
		margin: 0;
		font-weight: var(--font-weight-semibold);
		flex: 1;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.channel-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.channel-description {
		font-size: var(--text-sm);
		font-weight: var(--font-weight-regular);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-badge {
		display: inline-block;
		padding: 0.25rem 0.5rem;
		background: var(--accent);
		color: white;
		font-size: var(--text-xs);
		border-radius: var(--radius-sm);
		font-weight: var(--font-weight-medium);
	}

	.dm-redirect-message {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 1rem;
		color: var(--text-secondary);
		text-align: center;
		padding: 2rem;
	}

	.dm-redirect-message svg {
		color: var(--text-tertiary);
		opacity: 0.5;
	}

	.dm-redirect-message h3 {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-lg);
		font-weight: var(--font-weight-semibold);
	}

	.dm-redirect-message p {
		margin: 0;
		font-size: var(--text-sm);
		max-width: 300px;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.dm-call-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.dm-call-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: var(--text-sm);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition: all var(--duration-fast);
	}

	.dm-call-btn svg {
		width: 14px;
		height: 14px;
	}

	.dm-call-btn:hover {
		border-color: var(--accent);
		background: var(--bg-tertiary);
	}

	.search-container {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.search-input {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: var(--text-base);
		min-width: 250px;
		transition: all var(--duration-fast);
	}

	.search-input::placeholder {
		color: var(--text-secondary);
	}

	.search-input:focus {
		outline: none;
		border-color: var(--accent);
		background: var(--bg-tertiary);
	}


	.search-results {
		font-size: var(--text-sm);
		color: var(--text-secondary);
		white-space: nowrap;
		padding: 0 0.5rem;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0; /* Important for flex overflow */
		background: transparent;
		position: relative;
		z-index: 1;
	}

	.typing-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		font-size: var(--text-sm);
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
		z-index: 10;
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

	.media-menu-container {
		position: relative;
	}

	.media-menu {
		position: absolute;
		left: 0;
		bottom: calc(100% + 0.4rem);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 10rem;
		padding: 0.35rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		background: var(--bg-secondary);
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
		z-index: 20;
	}

	.media-menu-item {
		border: none;
		background: transparent;
		color: var(--text-primary);
		text-align: left;
		padding: 0.45rem 0.55rem;
		border-radius: 0.4rem;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.media-menu-item:hover {
		background: var(--bg-hover);
		color: var(--accent);
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
		padding: 0;
	}

	.input-icon-button svg {
		width: 20px;
		height: 20px;
		stroke: currentColor;
		stroke-width: 2;
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
		padding: 0 0.75rem;
		height: 36px;
		border-radius: 6px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.send-button svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
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
			padding: 0.75rem 1rem;
			height: 52px;
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

		/* Show attach/camera buttons on mobile */
		.input-buttons-left {
			display: flex;
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
