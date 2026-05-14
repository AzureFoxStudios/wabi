<script lang="ts">
	import { onMount } from 'svelte';
	import { getUserSettings, saveUserSettings } from '$lib/api';
	import { getAuthToken } from '$lib/authSession';

	let retentionPeriod: '1d' | '7d' | '30d' | 'forever' = '7d';
	let allowTempMessages: boolean = true;
	let isLoading = false;
	let isSaving = false;
	let message = '';
	let messageType: 'success' | 'error' = 'success';
	let token: string | null = null;

	onMount(async () => {
		token = getAuthToken();

		// Load user settings if registered
		if (token) {
			await loadSettings();
		}
	});

	async function loadSettings() {
		if (!token) return;

		isLoading = true;
		try {
			const settings = await getUserSettings(token);
			retentionPeriod = settings.offline_message_retention || '7d';
			allowTempMessages = settings.allow_temp_user_messages !== false;
		} catch (error) {
			console.error('Failed to load settings:', error);
			messageType = 'error';
			message = 'Failed to load settings';
		} finally {
			isLoading = false;
		}
	}

	async function saveSettings() {
		if (!token) return;

		isSaving = true;
		messageType = 'success';
		message = '';

		try {
			await saveUserSettings(token, {
				offline_message_retention: retentionPeriod,
				allow_temp_user_messages: allowTempMessages
			});

			messageType = 'success';
			message = '✓ Settings saved successfully';

			// Clear message after 3 seconds
			setTimeout(() => {
				message = '';
			}, 3000);
		} catch (error) {
			console.error('Failed to save settings:', error);
			messageType = 'error';
			message = error instanceof Error ? error.message : 'Failed to save settings';
		} finally {
			isSaving = false;
		}
	}
</script>

<div class="settings-panel">
	<div class="settings-header">
		<h3>Offline Message Settings</h3>
		<p class="subtitle">Configure how offline messages are handled</p>
	</div>

	{#if isLoading}
		<div class="loading">Loading settings...</div>
	{:else}
		<div class="settings-content">
			<!-- Retention Period Setting -->
			<div class="setting-item">
				<label for="retention">Message Retention Period</label>
				<p class="setting-description">
					How long offline messages are kept before automatically deleted
				</p>
				<select
					id="retention"
					bind:value={retentionPeriod}
					disabled={isSaving}
					class="select-input"
				>
					<option value="1d">1 Day</option>
					<option value="7d">7 Days (recommended)</option>
					<option value="30d">30 Days</option>
					<option value="forever">Forever (never delete)</option>
				</select>
			</div>

			<!-- Allow Temp Users Setting -->
			<div class="setting-item">
				<label for="allowTemp" class="checkbox-label">
					<input
						id="allowTemp"
						type="checkbox"
						bind:checked={allowTempMessages}
						disabled={isSaving}
						class="checkbox-input"
					/>
					<span class="checkbox-text">Allow temporary users to send me offline messages</span>
				</label>
				<p class="setting-description">
					When disabled, only registered users can send you messages while you're offline
				</p>
			</div>

			<!-- Info Box -->
			<div class="info-box">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
					<circle cx="12" cy="12" r="10"></circle>
					<line x1="12" y1="16" x2="12" y2="12"></line>
					<line x1="12" y1="8" x2="12.01" y2="8"></line>
				</svg>
				<div>
					<p><strong>ℹ️ How offline messages work:</strong></p>
					<ul>
						<li>When you're offline, messages are queued on the server</li>
						<li>They're delivered when you reconnect</li>
						<li>After the retention period, old messages are automatically deleted</li>
						<li>Real-time messages are lost if you're offline (only registered users get queuing)</li>
					</ul>
				</div>
			</div>

			<!-- Message Feedback -->
			{#if message}
				<div class={`message ${messageType}`}>
					{message}
				</div>
			{/if}

			<!-- Save Button -->
			<button
				on:click={saveSettings}
				disabled={isSaving}
				class="save-btn"
			>
				{isSaving ? '💾 Saving...' : '💾 Save Settings'}
			</button>
		</div>
	{/if}
</div>

<style>
	.settings-panel {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1.5rem;
		background: var(--surface-base);
		border-radius: 12px;
	}

	.settings-header {
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 1rem;
	}

	.settings-header h3 {
		margin: 0 0 0.25rem 0;
		font-size: 1.2rem;
		color: var(--text-heading);
	}

	.subtitle {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.loading {
		text-align: center;
		padding: 2rem 1rem;
		color: var(--text-secondary);
	}

	.settings-content {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.setting-item {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.setting-item label {
		color: var(--text-heading);
		font-weight: 600;
		font-size: 0.95rem;
	}

	.setting-description {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.select-input {
		padding: 0.75rem;
		background: var(--surface-raised);
		color: var(--text-heading);
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		font-size: 0.95rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.select-input:hover:not(:disabled) {
		border-color: var(--accent-primary);
		background: var(--surface-base);
	}

	.select-input:focus {
		outline: none;
		border-color: var(--accent-primary);
		box-shadow: 0 0 0 3px rgba(var(--accent-primary-rgb, 88, 101, 242), 0.1);
	}

	.select-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		cursor: pointer;
		user-select: none;
		color: var(--text-heading);
		font-weight: 600;
		font-size: 0.95rem;
	}

	.checkbox-input {
		width: 20px;
		height: 20px;
		cursor: pointer;
		accent-color: var(--accent-primary);
		flex-shrink: 0;
	}

	.checkbox-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.checkbox-text {
		margin: 0;
	}

	.info-box {
		display: flex;
		gap: 1rem;
		padding: 1rem;
		background: rgba(var(--accent-primary-rgb, 88, 101, 242), 0.05);
		border: 1px solid var(--accent-primary);
		border-radius: 8px;
		color: var(--text-heading);
	}

	.info-box svg {
		color: var(--accent-primary);
		flex-shrink: 0;
		margin-top: 0.25rem;
	}

	.info-box p {
		margin: 0 0 0.5rem 0;
		font-size: 0.9rem;
	}

	.info-box p strong {
		color: var(--accent-primary);
	}

	.info-box ul {
		margin: 0.5rem 0 0 0;
		padding-left: 1.2rem;
		list-style: disc;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.info-box li {
		margin: 0.25rem 0;
	}

	.message {
		padding: 0.75rem 1rem;
		border-radius: 8px;
		font-size: 0.9rem;
		text-align: center;
	}

	.message.success {
		background: rgba(var(--status-online-rgb, 34, 197, 94), 0.1);
		border: 1px solid rgb(34, 197, 94);
		color: var(--text-success, var(--text-success, #86efac));
	}

	.message.error {
		background: var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.1));
		border: 1px solid var(--color-danger, rgb(239, 68, 68));
		color: var(--accent-danger-soft, var(--accent-danger-soft, var(--accent-danger-soft, #fca5a5)));
	}

	.save-btn {
		padding: 0.75rem 1.5rem;
		background: var(--accent-primary);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		align-self: flex-start;
	}

	.save-btn:hover:not(:disabled) {
		background: var(--accent-hover, var(--accent-primary, #4752c4));
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(var(--accent-primary-rgb, 88, 101, 242), 0.3);
	}

	.save-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Mobile responsive */
	@media (max-width: 768px) {
		.settings-panel {
			padding: 1rem;
			gap: 1rem;
		}

		.settings-header h3 {
			font-size: 1.1rem;
		}

		.setting-item {
			gap: 0.4rem;
		}

		.select-input,
		.save-btn {
			font-size: 16px; /* Prevent zoom on mobile */
		}
	}
</style>
