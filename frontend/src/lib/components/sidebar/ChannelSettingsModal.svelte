<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { Channel, VoiceChannelSettings } from '$lib/socket';
	import { currentUser } from '$lib/socket';
	import { getSocket } from '$lib/socketConnection';
	import {
		MESSAGE_RETENTION_LABELS,
		MESSAGE_RETENTION_PRESETS,
		DEFAULT_CHANNEL_RETENTION,
		LIVE_RETENTION,
		isLiveRetention,
		type MessageRetentionDuration
	} from '../../../../../shared/messageRetention.js';

	// A retention selection is either a durable preset, null (keep forever),
	// or the "live" sentinel (session-only, never persisted).
	type RetentionChoice = MessageRetentionDuration | null | typeof LIVE_RETENTION;

	// Only workspace owners and admins may bulk-clear a channel's messages.
	$: canClearMessages = ['owner', 'admin'].includes($currentUser?.highestRole || '');

	/** Effective timer for UI: 'live' stays live; unset → default 24h; null only when keep-forever. */
	$: effectiveAutoDelete =
		isLiveRetention(channel.autoDeleteAfter)
			? LIVE_RETENTION
			: channel.autoDeleteAfter === undefined
				? DEFAULT_CHANNEL_RETENTION
				: channel.autoDeleteAfter;

	function clearAllMessages(): void {
		if (!canClearMessages || channel.type === 'dm') return;
		const confirmed = window.confirm(
			`Purge ALL messages in #${channel.name}? This removes chat history for everyone. Attachment files on disk are not deleted. This cannot be undone.`
		);
		if (!confirmed) return;
		const sock = getSocket();
		if (!sock) return;
		sock.emit('clear-channel-messages', { channelId: channel.id });
	}

	function chooseRetention(next: RetentionChoice): void {
		const prev = effectiveAutoDelete;
		if (next === prev) return;
		// Opt into Live (session-only, no persistence).
		if (isLiveRetention(next) && !isLiveRetention(prev)) {
			const ok = window.confirm(
				`Make #${channel.name} a Live room?\n\nMessages are session-only and are lost when the server restarts. No history is stored. Note: Live is not private from the server owner while messages are live.`
			);
			if (!ok) return;
			saveChannelSettings(LIVE_RETENTION);
			return;
		}
		// Leaving Live → timed/forever: nothing was stored, so no purge needed.
		if (isLiveRetention(prev) && !isLiveRetention(next)) {
			saveChannelSettings(next);
			return;
		}
		// Opt into keep-forever (persistence).
		if (next === null && prev !== null) {
			const ok = window.confirm(
				`Keep messages in #${channel.name} forever?\n\nThis opts into persistence. History will be stored until you purge it or change retention.`
			);
			if (!ok) return;
		}
		// Leaving forever → timed: offer purge of stored history.
		if (prev === null && next !== null) {
			const purge = window.confirm(
				`Switch #${channel.name} back to timed chat (${next})?\n\nOK = also purge existing stored messages now.\nCancel = keep old messages, only apply the timer to new ones.`
			);
			saveChannelSettings(next);
			if (purge) {
				// Slight delay so settings save emits first.
				setTimeout(() => clearAllMessages(), 50);
			}
			return;
		}
		saveChannelSettings(next);
	}

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
				forceSpoiler?: boolean;
				voiceSettings?: VoiceChannelSettings;
			};
		};
	}>();

	let activeChannelId = '';
	let tempPersistMessages = false;
	let tempDescription = '';
	let tempChannelName = '';
	let tempWatchQueueEnabled = false;
	let tempForceSpoiler = false;
	let tempVoiceUserLimit = '';
	let tempVoiceForceSolo = false;
	let tempLiveTtl = '';
	let tempLiveCap = '';
	let tempLiveGrace = '';
	let tempLiveAttachMax = '';
	let tempAfkAnnounce = true;
	let tempLiveRenderWindow = getLiveRenderWindow();

	$: if (channel && channel.id !== activeChannelId) {
		activeChannelId = channel.id;
		tempPersistMessages = channel.persistMessages || false;
		tempDescription = channel.description || '';
		tempChannelName = channel.name || '';
		tempWatchQueueEnabled = channel.watchQueueEnabled || false;
		tempForceSpoiler = channel.forceSpoiler || false;
		tempVoiceUserLimit = channel.voiceSettings?.userLimit ? String(channel.voiceSettings.userLimit) : '';
		tempVoiceForceSolo = channel.voiceSettings?.forceSolo === true;
		tempLiveTtl = '';
		tempLiveCap = '';
		tempLiveGrace = '';
		tempLiveAttachMax = '';
		tempAfkAnnounce = true;
		tempLiveRenderWindow = getLiveRenderWindow();
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

	function parseDurationToMs(input: string): number | null {
		const trimmed = input.trim().toLowerCase();
		if (!trimmed) return null;
		const match = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
		if (!match) return null;
		const val = parseInt(match[1], 10);
		const unit = match[2] || 'ms';
		switch (unit) {
			case 'ms': return val;
			case 's': return val * 1000;
			case 'm': return val * 60 * 1000;
			case 'h': return val * 60 * 60 * 1000;
			case 'd': return val * 24 * 60 * 60 * 1000;
			default: return val;
		}
	}

	function parseNumberInput(input: string): number | null {
		const trimmed = input.trim();
		if (!trimmed) return null;
		const val = parseInt(trimmed, 10);
		return Number.isFinite(val) ? val : null;
	}

	function getLiveRenderWindow(): number {
		try {
			const v = localStorage.getItem('wabi:liveRenderWindow');
			if (v !== null) {
				const n = parseInt(v, 10);
				if (Number.isFinite(n) && n > 0) return n;
			}
		} catch {}
		return 250;
	}

	function setLiveRenderWindow(val: number): void {
		try {
			localStorage.setItem('wabi:liveRenderWindow', String(val));
		} catch {}
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

	function saveChannelSettings(autoDeleteAfter: RetentionChoice = channel.autoDeleteAfter || null): void {
		const liveUpdates: Record<string, unknown> = {};
		if (isLiveRetention(tempLiveTtl ? undefined : channel.autoDeleteAfter) || isLiveRetention(autoDeleteAfter)) {
			const ttlMs = parseDurationToMs(tempLiveTtl);
			if (ttlMs !== null) liveUpdates.liveTtlMs = ttlMs;
			const cap = parseNumberInput(tempLiveCap);
			if (cap !== null) liveUpdates.liveCap = cap;
			const grace = parseDurationToMs(tempLiveGrace);
			if (grace !== null) liveUpdates.liveGraceMs = grace;
			if (tempLiveAttachMax.trim()) liveUpdates.liveAttachMax = tempLiveAttachMax.trim();
			liveUpdates.afkAnnounce = tempAfkAnnounce;
		}
		dispatch('save', {
			channelId: channel.id,
			updates: {
				autoDeleteAfter: autoDeleteAfter as MessageRetentionDuration | null,
				persistMessages: canTogglePersistMessages ? tempPersistMessages : channel.persistMessages,
				description: tempDescription,
				name: tempChannelName.trim() || channel.name,
				watchQueueEnabled: canManageWatchQueue ? tempWatchQueueEnabled : channel.watchQueueEnabled,
				forceSpoiler: tempForceSpoiler,
				voiceSettings: canManageVoiceSettings ? buildDraftVoiceSettings() : channel.voiceSettings,
				...liveUpdates
			} as any
		});
		setLiveRenderWindow(tempLiveRenderWindow);
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
					<span class="setting-label">Message retention</span>
					<p class="setting-description">
						Live (session only) · Timed (default 24 hours) · Keep forever (opt-in persistence).
					</p>

					<div class="auto-delete-options">
						<button
							class="auto-delete-btn live-retention-btn"
							class:active={effectiveAutoDelete === LIVE_RETENTION}
							on:click={() => chooseRetention(LIVE_RETENTION)}
							type="button"
							title="Session only — messages are never saved and are lost on server restart"
						>
							Live · session only
						</button>
						<button
							class="auto-delete-btn"
							class:active={effectiveAutoDelete === null}
							on:click={() => chooseRetention(null)}
							type="button"
						>
							Keep forever
						</button>
						{#each MESSAGE_RETENTION_PRESETS as duration}
							<button
								class="auto-delete-btn"
								class:active={effectiveAutoDelete === duration}
								on:click={() => chooseRetention(duration)}
								type="button"
							>
								{MESSAGE_RETENTION_LABELS[duration]}
							</button>
						{/each}
					</div>
				</div>

			{#if channel.type !== 'dm'}
				<div class="setting-group">
					<label class="spoiler-toggle">
						<input
							type="checkbox"
							checked={tempForceSpoiler}
							on:change={(e) => (tempForceSpoiler = (e.currentTarget as HTMLInputElement).checked)}
						/>
						<span>
							<strong>🔒 Spoiler channel</strong>
							<span class="setting-description">
								Every message sent here is automatically hidden until clicked — including old messages.
							</span>
						</span>
					</label>
				</div>
			{/if}

			{#if channel.type !== 'dm' && canClearMessages}
				<div class="setting-group danger-zone">
					<span class="setting-label">Purge channel history</span>
					<p class="setting-description">
						Permanently delete every message in this channel for all members. Direct messages are never
						affected. Attachment files on disk are not deleted. Use this when turning off keep-forever
						or wiping local/server chat data for the channel.
					</p>
					<button class="clear-messages-btn" type="button" on:click={clearAllMessages}>
						Purge all messages
					</button>
				</div>
			{/if}

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

				{#if isLiveRetention(channel.autoDeleteAfter)}
					<div class="setting-section live-settings-section">
						<h3>Live Room</h3>

						<div class="setting-group">
							<label for="live-ttl" class="setting-label">Message TTL</label>
							<input
								id="live-ttl"
								type="text"
								bind:value={tempLiveTtl}
								placeholder="e.g. 10m"
								class="description-input"
							/>
							<p class="setting-description">How long messages stay alive before expiring (e.g. 10m, 30s, 1h).</p>
						</div>

						<div class="setting-group">
							<label for="live-cap" class="setting-label">Message Cap</label>
							<input
								id="live-cap"
								type="text"
								bind:value={tempLiveCap}
								placeholder="e.g. 1000"
								class="description-input"
							/>
							<p class="setting-description">Maximum number of alive messages in the server buffer.</p>
						</div>

						<div class="setting-group">
							<label for="live-grace" class="setting-label">Reconnect Grace Period</label>
							<input
								id="live-grace"
								type="text"
								bind:value={tempLiveGrace}
								placeholder="e.g. 60s"
								class="description-input"
							/>
							<p class="setting-description">Time after disconnect before a user is marked AFK (e.g. 60s, 5m).</p>
						</div>

						<div class="setting-group">
							<label for="live-attach-max" class="setting-label">Max Attachment Size</label>
							<input
								id="live-attach-max"
								type="text"
								bind:value={tempLiveAttachMax}
								placeholder="e.g. 8 MB"
								class="description-input"
							/>
							<p class="setting-description">Maximum attachment file size for live messages.</p>
						</div>

						<div class="setting-group">
							<label class="setting-label">
								<input
									type="checkbox"
									bind:checked={tempAfkAnnounce}
									class="setting-checkbox"
								/>
								AFK Announcements
							</label>
							<p class="setting-description">Show system messages when someone goes AFK or returns.</p>
						</div>

						<div class="setting-group">
							<label for="live-render-window" class="setting-label">Client Render Window</label>
							<input
								id="live-render-window"
								type="number"
								min="50"
								max="5000"
								step="50"
								bind:value={tempLiveRenderWindow}
								class="description-input"
							/>
							<p class="setting-description">Weaker PCs: keep last N messages in DOM. Server buffer is unaffected.</p>
						</div>

						<button class="save-description-btn" on:click={() => saveChannelSettings()}>
							Save Live Settings
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.danger-zone {
		border: 1px solid var(--danger-color, #e2484d);
		border-radius: 8px;
		padding: 12px;
		margin-top: 8px;
	}
	.clear-messages-btn {
		margin-top: 8px;
		background: var(--danger-color, #e2484d);
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 8px 14px;
		font-weight: 600;
		cursor: pointer;
	}
	.clear-messages-btn:hover {
		filter: brightness(0.92);
	}
</style>
