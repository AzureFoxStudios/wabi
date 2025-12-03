<script lang="ts">
	import { onMount } from 'svelte';
	import { channelMessages, users, currentUser } from '$lib/socket';
	import StorageSettings from './StorageSettings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { playNotificationSound } from '$lib/notifications';

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

	async function confirmClearServer() {

		try {
			const serverUrl = window.location.origin.includes(':5173')
				? 'http://localhost:3000'
				: window.location.origin;

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
</script>

{#if isOpen}
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>⚙️ Settings</h2>
				<button class="close-btn" on:click={closeModal}>✕</button>
			</div>

			<div class="settings-sections">
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
</style>
