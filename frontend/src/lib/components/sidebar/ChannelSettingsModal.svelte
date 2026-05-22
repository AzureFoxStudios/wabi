<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { Channel, VoiceChannelSettings } from '$lib/socket';
	import {
		MESSAGE_RETENTION_LABELS,
		MESSAGE_RETENTION_PRESETS,
		type MessageRetentionDuration
	} from '../../../../../shared/messageRetention.js';

	export let channel: Channel;
	export let canTogglePersistMessages = false;
	export let canManageWatchQueue = false;
	export let canManageVoiceSettings = false;

	const dispatch = createEventDispatcher<{
		close: void;
		save: {
			channelId: string;
			updates: {
				autoDeleteAfter: MessageRetentionDuration | null;
				persistMessages?: boolean;
				description: string;
				name: string;
				watchQueueEnabled?: boolean;
				voiceSettings?: VoiceChannelSettings;
			};
		};
	}>();

	let activeChannelId = '';
	let tempPersistMessages = false;
	let tempDescription = '';
	let tempChannelName = '';
	let tempWatchQueueEnabled = false;
	let tempVoiceUserLimit = '';
	let tempVoiceForceSolo = false;

	$: if (channel && channel.id !== activeChannelId) {
		activeChannelId = channel.id;
		tempPersistMessages = channel.persistMessages || false;
		tempDescription = channel.description || '';
		tempChannelName = channel.name || '';
		tempWatchQueueEnabled = channel.watchQueueEnabled || false;
		tempVoiceUserLimit = channel.voiceSettings?.userLimit ? String(channel.voiceSettings.userLimit) : '';
		tempVoiceForceSolo = channel.voiceSettings?.forceSolo === true;
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
	}

	function parseVoiceUserLimitInput(rawValue: string): number | null {
		const trimmed = rawValue.trim();
		if (!trimmed) return null;
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isFinite(parsed) || parsed < 1) return 1;
		return Math.min(99, parsed);
	}

	function buildDraftVoiceSettings(): VoiceChannelSettings | undefined {
		if (channel.type !== 'voice') {
			return channel.voiceSettings;
		}

		const next: VoiceChannelSettings = {};
		const userLimit = parseVoiceUserLimitInput(tempVoiceUserLimit);
		if (userLimit !== null) {
			next.userLimit = userLimit;
		}
		if (tempVoiceForceSolo) {
			next.forceSolo = true;
		}
		if (channel.voiceSettings?.bitrateMode) {
			next.bitrateMode = channel.voiceSettings.bitrateMode;
		}
		return Object.keys(next).length > 0 ? next : undefined;
	}

	function saveChannelSettings(autoDeleteAfter: MessageRetentionDuration | null = channel.autoDeleteAfter || null): void {
		dispatch('save', {
			channelId: channel.id,
			updates: {
				autoDeleteAfter,
				persistMessages: canTogglePersistMessages ? tempPersistMessages : channel.persistMessages,
				description: tempDescription,
				name: tempChannelName.trim() || channel.name,
				watchQueueEnabled: canManageWatchQueue ? tempWatchQueueEnabled : channel.watchQueueEnabled,
				voiceSettings: canManageVoiceSettings ? buildDraftVoiceSettings() : channel.voiceSettings
			}
		});
	}

	function handleOverlayKeydown(event: KeyboardEvent): void {
		if (isEditableTarget(event.target)) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			dispatch('close');
		}
	}

	function handleModalKeydown(event: KeyboardEvent): void {
		if (isEditableTarget(event.target)) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
		}
	}
</script>

<div
	class="modal-overlay"
	role="button"
	tabindex="0"
	on:click={() => dispatch('close')}
	on:keydown={handleOverlayKeydown}
>
	<div
		class="modal-content"
		role="button"
		tabindex="0"
		on:click|stopPropagation
		on:keydown|stopPropagation={handleModalKeydown}
	>
		<div class="modal-header">
			<h2>
				<svg class="modal-title-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				Channel Settings
			</h2>
			<button class="close-btn" on:click={() => dispatch('close')}>&times;</button>
		</div>
		<div class="modal-body">
			<div class="setting-section">
				<h3>Channel: #{channel.name}</h3>

				<div class="setting-group">
					<label for="channel-settings-name">Name</label>
					<input
						id="channel-settings-name"
						type="text"
						bind:value={tempChannelName}
						placeholder="Channel name"
						class="description-input"
						maxlength="64"
					/>
				</div>

				<div class="setting-group">
					<label for="channel-settings-description">Description</label>
					<input
						id="channel-settings-description"
						type="text"
						bind:value={tempDescription}
						placeholder="Add a channel description..."
						class="description-input"
						maxlength="200"
					/>
					<button class="save-description-btn" on:click={() => saveChannelSettings()}>
						Save Settings
					</button>
				</div>

				<div class="setting-group">
					<span class="setting-label">Auto-Delete Messages</span>
					<p class="setting-description">Automatically delete messages after a set period of time</p>

					<div class="auto-delete-options">
						<button
							class="auto-delete-btn"
							class:active={!channel.autoDeleteAfter}
							on:click={() => saveChannelSettings(null)}
						>
							Never
						</button>
						{#each MESSAGE_RETENTION_PRESETS as duration}
							<button
								class="auto-delete-btn"
								class:active={channel.autoDeleteAfter === duration}
								on:click={() => saveChannelSettings(duration)}
							>
								{MESSAGE_RETENTION_LABELS[duration]}
							</button>
						{/each}
					</div>
				</div>

				{#if channel.type !== 'dm'}
					<div class="setting-group">
						<label class="setting-label">
							<input
								type="checkbox"
								bind:checked={tempPersistMessages}
								class="setting-checkbox"
								disabled={!canTogglePersistMessages}
							/>
							Persist Messages Locally (Owner Only)
						</label>
						<p class="setting-description">
							Save messages to your browser's local storage so you can see them after the server restarts.
							Each client controls their own message history.
						</p>
						{#if !canTogglePersistMessages}
							<p class="setting-description">Only workspace owners can change this setting.</p>
						{/if}
					</div>
				{/if}

				{#if channel.type !== 'dm' && channel.type !== 'voice'}
					<div class="setting-group">
						<label class="setting-label">
							<input
								type="checkbox"
								bind:checked={tempWatchQueueEnabled}
								class="setting-checkbox"
								disabled={!canManageWatchQueue}
							/>
							YouTube Queue Channel
						</label>
						<p class="setting-description">
							Enable the dedicated watch queue embed area in this channel while keeping standard YouTube link previews.
						</p>
						{#if !canManageWatchQueue}
							<p class="setting-description">Only workspace owners or admins can change this setting.</p>
						{/if}
					</div>
				{/if}

				{#if channel.type === 'voice'}
					<div class="setting-group">
						<div class="setting-label">Voice Capacity</div>
						<p class="setting-description">Leave blank for unlimited. The sidebar will show current users as x/y when a limit is set.</p>
						<input
							type="number"
							min="1"
							max="99"
							step="1"
							value={tempVoiceUserLimit}
							on:input={(event) => {
								tempVoiceUserLimit = event.currentTarget.value;
							}}
							placeholder="Unlimited"
							class="description-input"
							disabled={!canManageVoiceSettings}
						/>
						{#if !canManageVoiceSettings}
							<p class="setting-description">Only workspace owners or admins can change voice capacity.</p>
						{/if}
					</div>

					<div class="setting-group">
						<label class="setting-label">
							<input
								type="checkbox"
								bind:checked={tempVoiceForceSolo}
								class="setting-checkbox"
								disabled={!canManageVoiceSettings}
							/>
							Focused Audio
						</label>
						<p class="setting-description">When enabled, joining this voice channel forces listen/transmit focus to this channel only. Use voice capacity `1` if you want a true one-person room.</p>
						{#if !canManageVoiceSettings}
							<p class="setting-description">Only workspace owners or admins can change focused audio mode.</p>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
