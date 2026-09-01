<script lang="ts">
	import { createEventDispatcher } from 'svelte';
import { get } from 'svelte/store';
	import type { Channel, VoiceChannelSettings } from '$lib/socket';
	import { currentUser, channels } from '$lib/socket';
	import { getLoreBinding, setLoreBinding, deleteLoreBinding, parseLoreChannelId } from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';
	import { hasAddonCapability } from '$lib/addonInventory';
	import { getSocket, connected } from '$lib/socketConnection';
	import { getWabiDB } from '$lib/wabidb';
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
	$: canDeleteChannel = ['owner', 'admin'].includes($currentUser?.highestRole || '') && channel.id !== 'general' && channel.id !== 'voice';

	/** Effective timer for UI: 'live' stays live; unset → default 24h; null only when keep-forever. */
	$: effectiveAutoDelete =
		isLiveRetention(channel.autoDeleteAfter)
			? LIVE_RETENTION
			: channel.autoDeleteAfter === undefined
				? DEFAULT_CHANNEL_RETENTION
				: channel.autoDeleteAfter;

	async function clearAllMessages(): Promise<void> {
		if (!canClearMessages || channel.type === 'dm') return;
		const confirmed = window.confirm(
			`Purge ALL messages in #${channel.name}? This removes chat history for everyone. Attachment files on disk are not deleted. This cannot be undone.`
		);
		if (!confirmed) return;
		const sock = getSocket();
		if (!sock) return;
		const db = getWabiDB();
		const online = get(connected);
		if (db && !online) {
			await db.enqueue({ scopeId: 'corechat', type: 'clear-channel-messages', payload: { channelId: channel.id } });
			return;
		}
		sock.emit('clear-channel-messages', { channelId: channel.id });
	}

	/** Clear this channel's history only on this browser (IndexedDB/local cache). */
	async function clearLocalMessagesOnly(): Promise<void> {
		if (channel.type === 'dm') return;
		const confirmed = window.confirm(
			`Clear local cache for #${channel.name} on this device only?\n\nOther members keep their history. Server history is unchanged.`
		);
		if (!confirmed) return;
		try {
			const { chatStorage } = await import('$lib/storage');
			const { channelMessages } = await import('$lib/socket');
			await chatStorage.clearChannelMessages(channel.id);
			channelMessages.update((state) => ({ ...state, [channel.id]: [] }));
		} catch (err) {
			console.warn('[channel-settings] local clear failed', err);
			window.alert('Could not clear local messages. Check console for details.');
		}
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
		delete: { channel: Channel };
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

	// --- Lore binding (spec 2026-08-28 P1.4) ---
	let loreBindingAvailable = false;
	let loreBindingActive = false;
	let loreBindingStatus = '';
	let tempLoreRepoChannel = '';
	let tempLorePath = '/';
	let tempLoreBranch = 'main';
	let tempLoreMode = 'hybrid';
	let tempLoreAllowedTypes = '';
	$: loreChannels = $channels.filter((c) => (c.type || 'text') === 'lore');
	void hasAddonCapability('lore').then((ok) => {
		loreBindingAvailable = ok;
	});

	async function loadLoreBinding(channelId: string): Promise<void> {
		loreBindingActive = false;
		loreBindingStatus = '';
		tempLoreRepoChannel = '';
		tempLorePath = '/';
		tempLoreBranch = 'main';
		tempLoreMode = 'hybrid';
		tempLoreAllowedTypes = '';
		const numeric = parseLoreChannelId(channelId);
		const token = getAuthToken();
		if (!numeric || !token || !loreBindingAvailable) return;
		try {
			const b = await getLoreBinding(token, numeric);
			if (b) {
				loreBindingActive = true;
				tempLoreRepoChannel = `ch_${b.repoChannelId.toString(16)}`;
				tempLorePath = b.path;
				tempLoreBranch = b.branch;
				tempLoreMode = b.mode;
				tempLoreAllowedTypes = b.allowedTypes.join(', ');
			}
		} catch {
			// Leave the form blank; saving will surface errors.
		}
	}

	async function saveLoreBinding(): Promise<void> {
		const numeric = parseLoreChannelId(channel.id);
		const repoNumeric = parseLoreChannelId(tempLoreRepoChannel);
		const token = getAuthToken();
		if (!numeric || !repoNumeric || !token) return;
		loreBindingStatus = 'Saving…';
		try {
			await setLoreBinding(token, numeric, {
				repoChannelId: repoNumeric,
				path: tempLorePath,
				branch: tempLoreBranch || 'main',
				mode: tempLoreMode,
				allowedTypes: tempLoreAllowedTypes
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			});
			loreBindingActive = true;
			loreBindingStatus = 'Binding saved.';
		} catch (e) {
			loreBindingStatus = e instanceof Error ? e.message : String(e);
		}
	}

	async function removeLoreBinding(): Promise<void> {
		const numeric = parseLoreChannelId(channel.id);
		const token = getAuthToken();
		if (!numeric || !token) return;
		loreBindingStatus = 'Removing…';
		try {
			await deleteLoreBinding(token, numeric);
			loreBindingActive = false;
			tempLoreRepoChannel = '';
			tempLorePath = '/';
			loreBindingStatus = 'Binding removed.';
		} catch (e) {
			loreBindingStatus = e instanceof Error ? e.message : String(e);
		}
	}

	$: channelKind = (channel.type || 'text') as string;
	$: isWikiChannel = channelKind === 'wiki';
	$: isForumChannel = channelKind === 'forum';
	$: isGalleryChannel = channelKind === 'gallery';
	$: isChatLikeChannel = !isWikiChannel && !isForumChannel && !isGalleryChannel && channelKind !== 'voice';
	$: settingsTitle = isWikiChannel
		? 'Wiki Settings'
		: isForumChannel
			? 'Forum Settings'
			: isGalleryChannel
				? 'Gallery Settings'
				: 'Channel Settings';
	$: channelHeadingPrefix = isWikiChannel ? '◈' : isForumChannel ? '◫' : isGalleryChannel ? '▣' : '#';

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
		void loadLoreBinding(channel.id);
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
				<svg class="modal-title-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path></svg>
				{settingsTitle}
			</h2>
			<button class="close-btn" on:click={() => dispatch('close')}>&times;</button>
		</div>
		<div class="modal-body">
			<div class="setting-section">
				<h3>Channel: {channelHeadingPrefix}{channel.name}</h3>

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

				{#if isChatLikeChannel}
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
				{#if isChatLikeChannel && loreBindingAvailable}
				<div class="setting-group">
					<span class="setting-label">Lore binding</span>
					<p class="setting-description">
						Bind this channel to a path in a Lore repo — attachments can be promoted there
						via their context menu.
					</p>
					{#if loreChannels.length === 0}
						<p class="setting-description">No Lore channels exist yet — create one first.</p>
					{:else}
						<label class="setting-field">
							<span class="setting-label">Repo (Lore channel)</span>
							<select bind:value={tempLoreRepoChannel}>
								<option value="" disabled>Select a Lore channel…</option>
								{#each loreChannels as c (c.id)}
									<option value={c.id}>{c.name}</option>
								{/each}
							</select>
						</label>
						<label class="setting-field">
							<span class="setting-label">Target path</span>
							<input type="text" bind:value={tempLorePath} placeholder="/art/concepts/" />
						</label>
						<label class="setting-field">
							<span class="setting-label">Branch</span>
							<input type="text" bind:value={tempLoreBranch} placeholder="main" />
						</label>
						<label class="setting-field">
							<span class="setting-label">Mode</span>
							<select bind:value={tempLoreMode}>
								<option value="none">None (manual promote only)</option>
								<option value="direct">Direct commit</option>
								<option value="stage">Stage for review</option>
								<option value="hybrid">Hybrid (role-based)</option>
							</select>
						</label>
						<label class="setting-field">
							<span class="setting-label">Allowed types (comma-separated, e.g. image/*, .blend)</span>
							<input type="text" bind:value={tempLoreAllowedTypes} placeholder="image/*" />
						</label>
						<div class="lore-binding-actions">
							<button class="save-btn" type="button" disabled={!tempLoreRepoChannel || !tempLorePath.startsWith('/')} on:click={saveLoreBinding}>
								{loreBindingActive ? 'Update binding' : 'Save binding'}
							</button>
							{#if loreBindingActive}
								<button class="danger-btn" type="button" on:click={removeLoreBinding}>Remove binding</button>
							{/if}
							{#if loreBindingStatus}
								<span class="setting-description">{loreBindingStatus}</span>
							{/if}
						</div>
					{/if}
				</div>
				{/if}
				{:else if isWikiChannel}
				<div class="setting-group">
					<span class="setting-label">Wiki options</span>
					<p class="setting-description">
						Pages live in this wiki channel. Name and description above identify the wiki surface.
						Page history and permissions will expand here; chat retention does not apply.
					</p>
				</div>
				{:else if isForumChannel}
				<div class="setting-group">
					<span class="setting-label">Forum options</span>
					<p class="setting-description">
						Threads and posts live in this forum. Chat spoiler/retention controls do not apply.
						Moderation tools for threads will expand here.
					</p>
				</div>
				{:else if isGalleryChannel}
				<div class="setting-group">
					<span class="setting-label">Gallery options</span>
					<p class="setting-description">
						Media albums are scoped to this gallery channel. Chat message retention does not apply.
					</p>
				</div>
				{/if}

			{#if isChatLikeChannel && channel.type !== 'dm'}
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

			{#if isChatLikeChannel && channel.type !== 'dm' && canClearMessages}
				<div class="setting-group danger-zone">
					<span class="setting-label">Purge channel history</span>
					<p class="setting-description">
						Server purge removes history for everyone. Local only clears this browser’s cache for the
						channel (server and other members unchanged). Attachments on disk are not deleted.
					</p>
					<div class="purge-actions">
						<button class="clear-messages-btn" type="button" on:click={clearAllMessages}>Purge all</button>
						<button class="clear-messages-btn local-only" type="button" on:click={clearLocalMessagesOnly}>Local only</button>
					</div>
				</div>
			{/if}

			{#if channel.type !== 'dm' && canTogglePersistMessages}
				<div class="setting-group">
					<label class="inline-check">
						<input type="checkbox" bind:checked={tempPersistMessages} class="setting-checkbox" />
						<span>Keep offline cache on this device</span>
					</label>
					<p class="setting-description">
						When on, this browser may retain channel messages across restarts. Separate from purge —
						Storage settings can still wipe local data.
					</p>
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

				{#if canDeleteChannel}
					<div class="setting-group danger-zone delete-zone">
						<div class="danger-zone-heading">
							<div>
								<span class="setting-label">Danger zone</span>
								<p class="setting-description">Delete this channel or folder from the server. Folder deletion will ask whether to keep its channels.</p>
							</div>
							<button class="delete-channel-btn" type="button" on:click={() => dispatch('delete', { channel })}>Delete {channel.type === 'category' ? 'folder' : 'channel'}</button>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.danger-zone {
		border: 1px solid color-mix(in srgb, var(--color-danger, #e2484d) 45%, transparent);
		border-radius: var(--radius-lg, 12px);
		padding: 0.95rem 1rem;
		margin-top: 0.5rem;
		background: color-mix(in srgb, var(--color-danger, #e2484d) 8%, transparent);
	}

	.delete-zone {
		margin-top: 1rem;
		background: linear-gradient(135deg, color-mix(in srgb, var(--color-danger, #e2484d) 9%, transparent), color-mix(in srgb, var(--surface-raised) 72%, transparent));
	}

	.danger-zone-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.delete-channel-btn {
		flex: 0 0 auto;
		border: 1px solid color-mix(in srgb, var(--color-danger, #e2484d) 68%, transparent);
		border-radius: var(--radius-md, 8px);
		padding: 0.55rem 0.8rem;
		background: color-mix(in srgb, var(--color-danger, #e2484d) 16%, transparent);
		color: var(--color-danger, #e2484d);
		font-weight: 700;
		cursor: pointer;
	}

	.delete-channel-btn:hover {
		background: var(--color-danger, #e2484d);
		color: var(--text-on-danger, #fff);
	}

	.purge-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.55rem;
		margin-top: 0.75rem;
	}

	.clear-messages-btn {
		margin-top: 0;
		background: var(--color-danger, #e2484d);
		color: #fff;
		border: none;
		border-radius: var(--radius-md, 8px);
		padding: 0.55rem 0.95rem;
		font-weight: 650;
		cursor: pointer;
		transition: filter 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
	}

	.clear-messages-btn:hover {
		filter: brightness(1.05);
		transform: translateY(-1px);
		box-shadow: 0 8px 18px color-mix(in srgb, var(--color-danger, #e2484d) 28%, transparent);
	}

	.clear-messages-btn.local-only {
		background: transparent;
		color: var(--text-heading);
		border: 1px solid color-mix(in srgb, var(--color-danger, #e2484d) 40%, transparent);
	}

	.clear-messages-btn.local-only:hover {
		background: color-mix(in srgb, var(--color-danger, #e2484d) 12%, transparent);
		box-shadow: none;
	}

	.inline-check {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		cursor: pointer;
		font-weight: 600;
		color: var(--text-heading);
		user-select: none;
	}

	.inline-check input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--accent-secondary-color, #818cf8);
	}
</style>
