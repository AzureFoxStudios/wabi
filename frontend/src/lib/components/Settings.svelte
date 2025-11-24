<script lang="ts">
	import { onMount } from 'svelte';
	import { channelMessages, users, currentUser } from '$lib/socket';
	import StorageSettings from './StorageSettings.svelte';

	export let isOpen = false;

	let soundEnabled = true;
	let notificationsEnabled = true;
	let micEnabled = true;
	let cameraEnabled = true;
	let theme: 'dark' | 'light' = 'dark';

	// Load settings from localStorage
	onMount(() => {
		soundEnabled = localStorage.getItem('soundEnabled') !== 'false';
		notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		micEnabled = localStorage.getItem('micEnabled') !== 'false';
		cameraEnabled = localStorage.getItem('cameraEnabled') !== 'false';
		theme = (localStorage.getItem('theme') as 'dark' | 'light') || 'dark';
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
		if (confirm('Are you sure you want to clear all chat data? This cannot be undone.')) {
			channelMessages.set({ general: [] });
			localStorage.clear();
			alert('All data cleared.');
		}
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
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
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
		border: 2px solid var(--border);
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
		background: #3b82f6;
		color: white;
	}

	.action-btn.export:hover {
		background: #2563eb;
		transform: translateY(-2px);
	}

	.action-btn.import {
		background: #10b981;
		color: white;
	}

	.action-btn.import:hover {
		background: #059669;
		transform: translateY(-2px);
	}

	.action-btn.danger {
		background: #ef4444;
		color: white;
	}

	.action-btn.danger:hover {
		background: #dc2626;
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
</style>
