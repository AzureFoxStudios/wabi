<script lang="ts">
	import { onMount } from 'svelte';
	import { channelMessages, users, currentUser, emojis, updateProfile } from '$lib/socket';
	import StorageSettings from './StorageSettings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { playNotificationSound } from '$lib/notifications';
	import { getSocket } from '$lib/socket';
	import AvatarEditor from './AvatarEditor.svelte'; // Import the AvatarEditor

	export let isOpen = false;

	let soundEnabled = true;
	let notificationsEnabled = true;
	let micEnabled = true;
	let cameraEnabled = true;
	let theme: 'dark' | 'light' = 'dark';
	let notificationSound = '/sounds/ProjectSound.ogg';
	let notificationVolume = 0.5;

	let showClearDataConfirm = false;
	let showClearServerConfirm = false;

	// Profile Picture upload state
	let showAvatarEditor = false;
	let selectedAvatarFile: File | null = null;
	let selectedAvatarPreview: string | null = null;
	let uploadingAvatar = false;

	// Emoji upload state
	let emojiFileInput: HTMLInputElement;
	let emojiName = '';
	let emojiCategory = 'custom';
	let selectedEmojiFile: File | null = null;
	let emojiPreview: string | null = null;
	let uploadingEmoji = false;

	// Bulk emoji upload state
	let bulkEmojiFileInput: HTMLInputElement;
	let bulkEmojiFiles: { file: File; name: string; preview: string }[] = [];
	let uploadingBulk = false;

	// Load settings from localStorage
	onMount(() => {
		soundEnabled = localStorage.getItem('soundEnabled') !== 'false';
		notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		micEnabled = localStorage.getItem('micEnabled') !== 'false';
		cameraEnabled = localStorage.getItem('cameraEnabled') !== 'false';
		theme = (localStorage.getItem('theme') as 'dark' | 'light') || 'dark';
		notificationSound = localStorage.getItem('notificationSound') || '/sounds/ProjectSound.ogg';
		notificationVolume = parseFloat(localStorage.getItem('notificationVolume') || '0.5');
	});

	function toggleSound() {
		soundEnabled = !soundEnabled;
		localStorage.setItem('soundEnabled', soundEnabled.toString());
	}

	function toggleNotifications() {
		notificationsEnabled = !notificationsEnabled;
		localStorage.setItem('notificationsEnabled', notificationsEnabled.toString());
	}

	function toggleMic() {
		micEnabled = !micEnabled;
		localStorage.setItem('micEnabled', micEnabled.toString());
	}

	function toggleCamera() {
		cameraEnabled = !cameraEnabled;
		localStorage.setItem('cameraEnabled', cameraEnabled.toString());
	}

	function toggleTheme() {
		theme = theme === 'dark' ? 'light' : 'dark';
		localStorage.setItem('theme', theme);
		document.documentElement.setAttribute('data-theme', theme);
	}

	function updateNotificationSound(sound: string) {
		notificationSound = sound;
		localStorage.setItem('notificationSound', sound);
	}

	function updateNotificationVolume(volume: number) {
		notificationVolume = volume;
		localStorage.setItem('notificationVolume', volume.toString());
	}

	function testNotificationSound() {
		playNotificationSound();
	}

	function exportData() {
		const data = {
			channelMessages: $channelMessages,
			users: $users,
			currentUser: $currentUser,
			exportedAt: new Date().toISOString()
		};

		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `chat-export-all-channels-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function requestNotificationPermission() {
		if (!('Notification' in window)) {
			alert('This browser does not support notifications');
			return;
		}

		if (Notification.permission === 'granted') {
			alert('Notifications are already enabled!');
			return;
		}

		const permission = await Notification.requestPermission();
		if (permission === 'granted') {
			notificationsEnabled = true;
			localStorage.setItem('notificationsEnabled', 'true');
			new Notification('Community Chat', {
				body: 'Notifications enabled! You\'ll be notified of new messages.',
				icon: '/icon-192.png'
			});
		} else {
			notificationsEnabled = false;
			localStorage.setItem('notificationsEnabled', 'false');
		}
	}

	function clearAllData() {
		showClearDataConfirm = true;
	}

	function confirmClearData() {
		channelMessages.set({ general: [] });
		localStorage.clear();
		alert('All data cleared.');
		showClearDataConfirm = false;
	}

	async function clearServerMessages() {
		showClearServerConfirm = true;
	}

	async function handleEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (!file) return;

		// Check if it's an image
		if (!file.type.startsWith('image/')) {
			alert('Please select an image file (PNG, GIF, JPG, etc.)');
			return;
		}

		// Check file size (2MB limit)
		if (file.size > 2 * 1024 * 1024) {
			alert('File too large! Maximum size is 2MB');
			return;
		}

		selectedEmojiFile = file;

		// Generate preview
		const reader = new FileReader();
		reader.onload = (e) => {
			emojiPreview = e.target?.result as string;
		};
		reader.readAsDataURL(file);
	}

	async function uploadEmoji() {
		if (!selectedEmojiFile || !emojiName.trim()) {
			alert('Please select a file and enter an emoji name');
			return;
		}

		uploadingEmoji = true;

		try {
			let serverUrl: string;
			if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
				serverUrl = 'http://localhost:3000';
			} else {
				serverUrl = window.location.origin;
			}

			// Upload the file
			const formData = new FormData();
			formData.append('file', selectedEmojiFile);
			formData.append('name', emojiName.trim());
			formData.append('category', emojiCategory);

			const response = await fetch(`${serverUrl}/api/emoji/upload`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error('Upload failed');
			}

			const result = await response.json();

			// Emit socket event to notify all clients
			const socket = getSocket();
			socket?.emit('emoji-added', result.emoji);

			// Reset form
			emojiName = '';
			emojiCategory = 'custom';
			selectedEmojiFile = null;
			emojiPreview = null;
			if (emojiFileInput) emojiFileInput.value = '';

			alert(`Emoji "${result.emoji.name}" uploaded successfully!`);
		} catch (error) {
			console.error('Emoji upload error:', error);
			alert('Failed to upload emoji. Please try again.');
		} finally {
			uploadingEmoji = false;
		}
	}

	function deleteEmoji(emojiName: string) {
		if (!confirm(`Delete emoji ":${emojiName}:"?`)) return;

		const socket = getSocket();
		socket?.emit('delete-emoji', emojiName);
	}

	async function handleBulkEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);

		if (files.length === 0) return;

		// Filter only image files
		const imageFiles = files.filter(f => f.type.startsWith('image/'));

		if (imageFiles.length === 0) {
			alert('No valid image files selected');
			return;
		}

		// Check file sizes
		for (const file of imageFiles) {
			if (file.size > 2 * 1024 * 1024) {
				alert(`File "${file.name}" is too large! Maximum size is 2MB`);
				return;
			}
		}

		// Generate previews and auto-name from filename
		const filesWithPreviews = await Promise.all(
			imageFiles.map(async (file) => {
				const preview = await new Promise<string>((resolve) => {
					const reader = new FileReader();
					reader.onload = (e) => resolve(e.target?.result as string);
					reader.readAsDataURL(file);
				});

				// Auto-generate name from filename (remove extension, sanitize)
				const autoName = file.name
					.replace(/\.[^/.]+$/, '') // Remove extension
					.toLowerCase()
					.replace(/[^a-z0-9_]/g, '_') // Replace non-alphanumeric with underscore
					.replace(/_+/g, '_') // Replace multiple underscores with single
					.replace(/^_|_$/g, ''); // Remove leading/trailing underscores

				return { file, name: autoName, preview };
			})
		);

		bulkEmojiFiles = filesWithPreviews;
	}

	async function uploadBulkEmojis() {
		if (bulkEmojiFiles.length === 0) {
			alert('No files selected');
			return;
		}

		// Check for empty names
		const emptyNames = bulkEmojiFiles.filter(f => !f.name.trim());
		if (emptyNames.length > 0) {
			alert('All emojis must have a name');
			return;
		}

		uploadingBulk = true;
		let successCount = 0;
		let failCount = 0;

		try {
			let serverUrl: string;
			if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
				serverUrl = 'http://localhost:3000';
			} else {
				serverUrl = window.location.origin;
			}

			for (const item of bulkEmojiFiles) {
				try {
					const formData = new FormData();
					formData.append('file', item.file);
					formData.append('name', item.name.trim());
					formData.append('category', emojiCategory);

					const response = await fetch(`${serverUrl}/api/emoji/upload`, {
						method: 'POST',
						body: formData
					});

					if (!response.ok) {
						const error = await response.json();
						console.error(`Failed to upload ${item.name}:`, error);
						failCount++;
						continue;
					}

					const result = await response.json();

					// Emit socket event to notify all clients
					const socket = getSocket();
					socket?.emit('emoji-added', result.emoji);

					successCount++;
				} catch (error) {
					console.error(`Error uploading ${item.name}:`, error);
					failCount++;
				}
			}

			// Reset form
			bulkEmojiFiles = [];
			if (bulkEmojiFileInput) bulkEmojiFileInput.value = '';

			alert(`Upload complete!\n✅ ${successCount} successful\n❌ ${failCount} failed`);
		} catch (error) {
			console.error('Bulk upload error:', error);
			alert('Failed to upload emojis. Please try again.');
		} finally {
			uploadingBulk = false;
		}
	}

	function removeBulkEmoji(index: number) {
		bulkEmojiFiles = bulkEmojiFiles.filter((_, i) => i !== index);
	}

	async function confirmClearServer() {

		try {
			let serverUrl: string;
			if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
				serverUrl = 'http://localhost:3000';
			} else {
				serverUrl = window.location.origin;
			}

			const response = await fetch(`${serverUrl}/api/clear-messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				}
			});

			const result = await response.json();

			if (result.success) {
				// Also clear local data
				channelMessages.set({ general: [] });
				alert('All server messages have been deleted successfully!');
			} else {
				alert('Failed to clear server messages: ' + (result.error || 'Unknown error'));
			}
		} catch (error) {
			console.error('Error clearing server messages:', error);
			alert('Failed to clear server messages. Check console for details.');
		}
		showClearServerConfirm = false;
	}

	function closeModal() {
		isOpen = false;
	}

	function handleAvatarSelected(event: CustomEvent<{ file: File; dataUrl: string }>) {
		selectedAvatarFile = event.detail.file;
		selectedAvatarPreview = event.detail.dataUrl;
		uploadProfilePicture();
	}

	async function uploadProfilePicture() {
		if (!selectedAvatarFile) {
			alert('No image selected for upload.');
			return;
		}

		uploadingAvatar = true;

		try {
			let serverUrl: string;
			if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
				// Dev mode or Tauri app: use localhost
				serverUrl = 'http://localhost:3000';
			} else {
				// Production: use current origin
				serverUrl = window.location.origin;
			}

			const formData = new FormData();
			formData.append('profilePicture', selectedAvatarFile);

			const response = await fetch(`${serverUrl}/api/upload-profile-picture`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) {
				throw new Error('Failed to upload profile picture.');
			}

			const result = await response.json();
			if (result.profilePictureUrl) {
				updateProfile(undefined, result.profilePictureUrl);
				alert('Profile picture updated successfully!');
			} else {
				throw new Error('No profile picture URL returned.');
			}
		} catch (error) {
			console.error('Error uploading profile picture:', error);
			alert('Failed to upload profile picture. Please try again.');
		} finally {
			uploadingAvatar = false;
			selectedAvatarFile = null;
			selectedAvatarPreview = null;
		}
	}
</script>

{#if isOpen}
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>⚙️ Settings</h2>
				<button class="close-btn" on:click={closeModal}>✕</button>
			</div>

			<div class="settings-sections">
				<!-- Profile Picture -->
				<div class="settings-section">
					<h3>🎨 Profile Picture</h3>
					<div class="pfp-upload-section">
						<div class="current-pfp">
							{#if $currentUser?.profilePicture}
								<img src={$currentUser.profilePicture} alt="Current PFP" class="pfp-current-img" />
							{:else}
								<div class="pfp-placeholder" style="background-color: var(--accent);">
									{$currentUser?.username?.charAt(0).toUpperCase() || '?'}
								</div>
							{/if}
						</div>
						<div class="pfp-upload-form">
							<button class="pfp-select-btn" on:click={() => showAvatarEditor = true}>
								Change Profile Picture
							</button>
							{#if uploadingAvatar}
								<p>Uploading...</p>
							{/if}
						</div>
					</div>
				</div>

				<!-- Audio & Video Settings -->
				<div class="settings-section">
					<h3>🎤 Audio & Video</h3>
					<div class="setting-item">
						<div class="setting-info">
							<span class="setting-label">Sound Effects</span>
							<span class="setting-description">Play sounds for messages and notifications</span>
						</div>
						<button class="toggle-btn" class:active={soundEnabled} on:click={toggleSound}>
							{soundEnabled ? '🔊' : '🔇'}
						</button>
					</div>
					<div class="setting-item">
						<div class="setting-info">
							<span class="setting-label">Microphone</span>
							<span class="setting-description">Enable microphone for voice calls</span>
						</div>
						<button class="toggle-btn" class:active={micEnabled} on:click={toggleMic}>
							{micEnabled ? '🎤' : '🔇'}
						</button>
					</div>
					<div class="setting-item">
						<div class="setting-info">
							<span class="setting-label">Camera</span>
							<span class="setting-description">Enable camera for video calls</span>
						</div>
						<button class="toggle-btn" class:active={cameraEnabled} on:click={toggleCamera}>
							{cameraEnabled ? '📹' : '📷'}
						</button>
					</div>
				</div>

				<!-- Notifications -->
				<div class="settings-section">
					<h3>🔔 Notifications</h3>
					<div class="setting-item">
						<div class="setting-info">
							<span class="setting-label">Desktop Notifications</span>
							<span class="setting-description">Get notified when you receive new messages</span>
						</div>
						<button class="action-btn" class:active={notificationsEnabled} on:click={requestNotificationPermission}>
							{notificationsEnabled ? '✅ Enabled' : '🔔 Enable'}
						</button>
					</div>

					<!-- Notification Sound -->
					<div class="setting-item-full">
						<div class="setting-info">
							<span class="setting-label">🔊 Notification Sound</span>
							<span class="setting-description">Choose which sound to play for notifications</span>
						</div>
						<div class="sound-options">
							<button
								class="sound-option"
								class:active={notificationSound === '/sounds/ProjectSound.ogg'}
								on:click={() => updateNotificationSound('/sounds/ProjectSound.ogg')}
							>
								ProjectSound.ogg
							</button>
							<!-- Add more sound options here as you add more .ogg files -->
						</div>
						<button class="test-sound-btn" on:click={testNotificationSound}>
							🎵 Test Sound
						</button>
					</div>

					<!-- Notification Volume -->
					<div class="setting-item-full">
						<div class="setting-info">
							<span class="setting-label">🔉 Notification Volume</span>
							<span class="setting-description">Adjust the volume of notification sounds ({Math.round(notificationVolume * 100)}%)</span>
						</div>
						<input
							type="range"
							min="0"
							max="1"
							step="0.05"
							bind:value={notificationVolume}
							on:input={(e) => updateNotificationVolume(parseFloat(e.currentTarget.value))}
							class="volume-slider"
						/>
					</div>
				</div>

				<!-- Appearance -->
				<div class="settings-section">
					<h3>🎨 Appearance</h3>
					<div class="setting-item">
						<div class="setting-info">
							<span class="setting-label">Theme</span>
							<span class="setting-description">Switch between light and dark mode</span>
						</div>
						<button class="toggle-btn" class:active={theme === 'light'} on:click={toggleTheme}>
							{theme === 'dark' ? '🌙' : '☀️'}
						</button>
					</div>
				</div>

				<!-- Server Management -->
				<div class="settings-section">
					<h3>🖥️ Server Management</h3>
					<div class="setting-item">
						<div class="setting-info">
							<span class="setting-label">Clear All Server Messages</span>
							<span class="setting-description">Delete all messages from the server for all users (cannot be undone)</span>
						</div>
						<button class="action-btn danger" on:click={clearServerMessages}>
							🗑️ Clear Server
						</button>
					</div>
				</div>

				<!-- Custom Emojis -->
				<div class="settings-section">
					<h3>🎨 Custom Emojis</h3>

					<!-- Single Upload Form -->
					<div class="emoji-upload-form">
						<input
							type="file"
							bind:this={emojiFileInput}
							on:change={handleEmojiFileSelect}
							accept="image/*"
							style="display: none;"
						/>

						{#if emojiPreview}
							<div class="emoji-preview">
								<img src={emojiPreview} alt="Preview" />
							</div>
						{/if}

						<button class="emoji-select-btn" on:click={() => emojiFileInput?.click()}>
							{emojiPreview ? '📷 Change Image' : '📁 Select Image'}
						</button>

						<input
							type="text"
							bind:value={emojiName}
							placeholder="Emoji name (e.g., parrot)"
							maxlength="30"
							class="emoji-name-input"
						/>

						<select bind:value={emojiCategory} class="emoji-category-select">
							<option value="custom">Custom</option>
							<option value="animated">Animated</option>
							<option value="art">Art</option>
							<option value="memes">Memes</option>
						</select>

						<button
							class="emoji-upload-btn"
							on:click={uploadEmoji}
							disabled={uploadingEmoji || !selectedEmojiFile || !emojiName.trim()}
						>
							{uploadingEmoji ? '⏳ Uploading...' : '⬆️ Upload Emoji'}
						</button>

						<p class="emoji-hint">Supports PNG, GIF (animated), JPG. Max 2MB.</p>
					</div>

					<!-- Bulk Upload Form -->
					<div class="emoji-upload-form bulk">
						<h4>📦 Bulk Upload</h4>
						<input
							type="file"
							bind:this={bulkEmojiFileInput}
							on:change={handleBulkEmojiFileSelect}
							accept="image/*"
							multiple
							style="display: none;"
						/>

						<button class="emoji-select-btn" on:click={() => bulkEmojiFileInput?.click()}>
							📂 Select Multiple Images
						</button>

						{#if bulkEmojiFiles.length > 0}
							<div class="bulk-emoji-list">
								<p class="bulk-count">{bulkEmojiFiles.length} file(s) selected</p>
								{#each bulkEmojiFiles as item, index (index)}
									<div class="bulk-emoji-item">
										<img src={item.preview} alt="Preview" class="bulk-preview" />
										<input
											type="text"
											bind:value={item.name}
											placeholder="emoji_name"
											maxlength="30"
											class="bulk-name-input"
										/>
										<button
											class="bulk-remove-btn"
											on:click={() => removeBulkEmoji(index)}
											title="Remove"
										>
											✕
										</button>
									</div>
								{/each}
								<button
									class="emoji-upload-btn"
									on:click={uploadBulkEmojis}
									disabled={uploadingBulk || bulkEmojiFiles.length === 0}
								>
									{uploadingBulk ? '⏳ Uploading...' : `⬆️ Upload ${bulkEmojiFiles.length} Emoji${bulkEmojiFiles.length > 1 ? 's' : ''}`}
								</button>
							</div>
						{/if}

						<p class="emoji-hint">Auto-names from filenames. Edit names before uploading.</p>
					</div>

					<!-- Emoji List -->
					<div class="emoji-list">
						<h4>Your Custom Emojis ({$emojis.filter(e => e.isCustom).length})</h4>
						<div class="emoji-grid-list">
							{#each $emojis.filter(e => e.isCustom) as emoji (emoji.id)}
								<div class="emoji-item">
									<img src={emoji.url} alt={emoji.name} class="emoji-thumb" />
									<span class="emoji-item-name">:{emoji.name}:</span>
									<button
										class="emoji-delete-btn"
										on:click={() => deleteEmoji(emoji.name)}
										title="Delete emoji"
									>
										🗑️
									</button>
								</div>
							{/each}
						</div>
					</div>
				</div>

				<!-- Local Storage Settings -->
				<div class="settings-section">
					<StorageSettings />
				</div>

				<!-- About -->
				<div class="settings-section">
					<h3>ℹ️ About</h3>
					<div class="about-info">
						<p><strong>Wabi Chat</strong></p>
						<p>Privacy-first ephemeral chat. No tracking. No data collection.</p>
						<p>Server stores nothing permanently. You control your data.</p>
						<p class="version">Version 1.0.0</p>
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}

<AvatarEditor bind:isOpen={showAvatarEditor} on:change={handleAvatarSelected} />

<ConfirmDialog
	isOpen={showClearDataConfirm}
	title="Clear Local Data"
	message="Are you sure you want to clear all chat data? This cannot be undone."
	confirmText="Clear Data"
	variant="danger"
	onConfirm={confirmClearData}
	onCancel={() => showClearDataConfirm = false}
/>

<ConfirmDialog
	isOpen={showClearServerConfirm}
	title="Clear Server Messages"
	message="Are you sure you want to delete ALL messages from the server? This will clear messages for all users and cannot be undone!"
	confirmText="Delete All"
	variant="danger"
	onConfirm={confirmClearServer}
	onCancel={() => showClearServerConfirm = false}
/>

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(4px);
	}

	.modal-content {
		background: var(--bg-secondary);
		border-radius: 12px;
		width: 90%;
		max-width: 600px;
		max-height: 80vh;
		overflow-y: auto;
		box-shadow: none;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		background: var(--bg-secondary);
		z-index: 1;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.5rem;
		color: var(--text-primary);
	}

	.close-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.25rem 0.5rem;
		transition: all 0.2s;
	}

	.close-btn:hover {
		color: var(--text-primary);
		transform: scale(1.1);
	}

	.settings-sections {
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.settings-section h3 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--text-primary);
		font-weight: 600;
	}

	.setting-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		transition: all 0.2s;
	}

	.setting-item:hover {
		background: var(--bg-hover);
	}

	.setting-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
	}

	.setting-label {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.setting-description {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.toggle-btn {
		background: var(--bg-secondary);
		border: none;
		border-radius: 8px;
		padding: 0.5rem 1rem;
		font-size: 1.2rem;
		cursor: pointer;
		transition: all 0.2s;
		min-width: 60px;
	}

	.toggle-btn:hover {
		transform: scale(1.05);
		border-color: var(--primary);
	}

	.toggle-btn.active {
		background: var(--primary);
		border-color: var(--primary);
	}

	.action-buttons {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.action-btn {
		padding: 0.875rem 1.25rem;
		border-radius: 8px;
		border: none;
		font-size: 0.95rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		text-align: left;
	}

	.action-btn.export {
		background: var(--color-info);
		color: white;
	}

	.action-btn.export:hover {
		background: var(--color-info-hover);
		transform: translateY(-2px);
	}

	.action-btn.import {
		background: var(--color-success);
		color: white;
	}

	.action-btn.import:hover {
		background: var(--color-success-hover);
		transform: translateY(-2px);
	}

	.action-btn.danger {
		background: var(--color-danger);
		color: white;
	}

	.action-btn.danger:hover {
		background: var(--color-danger-hover);
		transform: translateY(-2px);
	}

	.about-info {
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.about-info p {
		margin: 0.5rem 0;
		color: var(--text-secondary);
	}

	.about-info p strong {
		color: var(--text-primary);
		font-size: 1.1rem;
	}

	.version {
		font-size: 0.85rem;
		color: var(--text-tertiary);
		margin-top: 1rem !important;
	}

	/* Notification Sound Settings */
	.setting-item-full {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.sound-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.sound-option {
		padding: 0.5rem 1rem;
		background: var(--bg-secondary);
		border: 2px solid transparent;
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.sound-option:hover {
		background: var(--bg-primary);
		border-color: var(--accent);
	}

	.sound-option.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.test-sound-btn {
		padding: 0.75rem 1rem;
		background: var(--primary);
		border: none;
		border-radius: 6px;
		color: white;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		align-self: flex-start;
	}

	.test-sound-btn:hover {
		background: var(--primary-hover);
		transform: translateY(-2px);
	}

	.volume-slider {
		width: 100%;
		height: 6px;
		border-radius: 3px;
		background: var(--bg-secondary);
		outline: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.volume-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		transition: all 0.2s;
	}

	.volume-slider::-webkit-slider-thumb:hover {
		transform: scale(1.2);
		background: var(--primary);
	}

	.volume-slider::-moz-range-thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		border: none;
		transition: all 0.2s;
	}

	.volume-slider::-moz-range-thumb:hover {
		transform: scale(1.2);
		background: var(--primary);
	}

	/* Profile Picture Upload Styles */
	.pfp-upload-section {
		display: flex;
		align-items: flex-start;
		gap: 1.5rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.current-pfp {
		flex-shrink: 0;
	}

	.pfp-current-img {
		width: 80px;
		height: 80px;
		border-radius: 50%;
		object-fit: cover;
		border: 3px solid var(--accent);
	}

	.pfp-placeholder {
		width: 80px;
		height: 80px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 2rem;
		font-weight: bold;
		color: white;
	}

	.pfp-upload-form {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pfp-preview {
		text-align: center;
	}

	.pfp-preview img {
		width: 60px;
		height: 60px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid var(--accent);
	}

	.pfp-select-btn,
	.pfp-upload-btn {
		padding: 0.75rem;
		border-radius: 8px;
		border: none;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
	}

	.pfp-select-btn {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.pfp-select-btn:hover {
		background: var(--bg-primary);
	}

	.pfp-upload-btn {
		background: var(--accent);
		color: white;
	}

	.pfp-upload-btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.pfp-upload-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pfp-hint {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin: 0;
	}

	/* Banner Upload Styles */
	.banner-upload-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.current-banner {
		width: 100%;
		max-width: 600px;
	}

	.current-banner img {
		width: 100%;
		height: auto;
		display: block;
		border-radius: 8px;
		border: 2px solid var(--border);
	}

	.banner-preview {
		width: 100%;
		max-width: 600px;
	}

	.banner-preview img {
		width: 100%;
		height: auto;
		display: block;
		border-radius: 8px;
		border: 2px solid var(--accent);
	}

	.banner-label {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
		margin-bottom: 0;
	}

	.banner-upload-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	/* Status Selector Styles */
	.status-selector {
		display: flex;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		flex-wrap: wrap;
	}

	.status-btn {
		flex: 1;
		min-width: 100px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--bg-secondary);
		border: 2px solid transparent;
		border-radius: 8px;
		color: var(--text-primary);
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.status-btn:hover {
		background: var(--bg-primary);
		border-color: var(--accent);
	}

	.status-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		display: inline-block;
	}

	/* Emoji Upload Styles */
	.emoji-upload-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		margin-bottom: 1.5rem;
	}

	.emoji-preview {
		text-align: center;
		padding: 1rem;
		background: var(--bg-primary);
		border-radius: 8px;
	}

	.emoji-preview img {
		max-width: 128px;
		max-height: 128px;
		object-fit: contain;
	}

	.emoji-select-btn,
	.emoji-upload-btn {
		padding: 0.75rem;
		border-radius: 8px;
		border: none;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
	}

	.emoji-select-btn {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.emoji-select-btn:hover {
		background: var(--bg-primary);
	}

	.emoji-upload-btn {
		background: var(--accent);
		color: white;
	}

	.emoji-upload-btn:hover:not(:disabled) {
		opacity: 0.9;
		transform: translateY(-1px);
	}

	.emoji-upload-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.emoji-name-input,
	.emoji-category-select {
		padding: 0.75rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 1rem;
	}

	.emoji-hint {
		font-size: 0.875rem;
		color: var(--text-secondary);
		text-align: center;
		margin: 0;
	}

	.emoji-list h4 {
		margin: 0 0 1rem 0;
		color: var(--text-primary);
	}

	.emoji-grid-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0.75rem;
	}

	.emoji-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		position: relative;
	}

	.emoji-thumb {
		width: 32px;
		height: 32px;
		object-fit: contain;
		flex-shrink: 0;
	}

	.emoji-item-name {
		flex: 1;
		font-size: 0.875rem;
		font-family: monospace;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.emoji-delete-btn {
		background: none;
		border: none;
		font-size: 1.1rem;
		cursor: pointer;
		padding: 0.25rem;
		opacity: 0.6;
		transition: opacity 0.2s;
	}

	.emoji-delete-btn:hover {
		opacity: 1;
	}

	/* Bulk Upload Styles */
	.emoji-upload-form.bulk {
		background: var(--bg-secondary);
		border: 2px dashed var(--border);
	}

	.emoji-upload-form.bulk h4 {
		margin: 0 0 1rem 0;
		color: var(--text-primary);
	}

	.bulk-emoji-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.bulk-count {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.bulk-emoji-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.bulk-preview {
		width: 48px;
		height: 48px;
		object-fit: contain;
		flex-shrink: 0;
		background: var(--bg-primary);
		border-radius: 4px;
	}

	.bulk-name-input {
		flex: 1;
		padding: 0.5rem;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: monospace;
	}

	.bulk-remove-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.25rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		opacity: 0.6;
		transition: opacity 0.2s;
	}

	.bulk-remove-btn:hover {
		opacity: 1;
		color: var(--color-danger);
	}
</style>
