<!--
	Channel settings (design contract §7.13, §8.9): a BaseModal lg (760) with a fixed title row,
	a scrolling body and a footer that stays put.

	- General · Permissions · Retention as a vertical segmented tablist on the left. Retention only
	  exists where a chat stream keeps messages.
	- Settings rows (.w-srow) with switches; permission rows wear the seal glyph (§5.1: the seal is
	  for who can open or change something). The danger zone ends General as a hairline section
	  with outlined danger buttons; it never wears the seal.
	- One Save path: the footer's "Save changes" sends everything, the message lifetime included.
	  Confirms go through confirmAction, errors render inline where the action happened.
-->
<script lang="ts">
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { currentRetentionFromPrivacy, explicitRetentionUpdate } from '$lib/retentionDisplay';
	import { get } from 'svelte/store';
	import type { Channel, VoiceChannelSettings } from '$lib/socket';
	import { currentUser, channels } from '$lib/socket';
	import { getLoreBinding, setLoreBinding, deleteLoreBinding, parseLoreChannelId } from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';
	import { hasAddonCapability } from '$lib/addonInventory';
	import { getSocket, connected } from '$lib/socketConnection';
	import { confirmAction } from '$lib/confirm';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import {
		GATE_OPTIONS,
		canManageChannel,
		channelDraftDirty,
		channelSettingsNote,
		channelSettingsTabs,
		channelSettingsTitle,
		hasChannelGate,
		isChatLikeKind,
		nextTab,
		retentionChoiceFor,
		retentionOptions,
		retentionValue,
		type ChannelDraftBaseline,
		type ChannelSettingsTab,
		type RetentionChoice
	} from './channelSettingsModel';
	import { LIVE_RETENTION, isLiveRetention, type MessageRetentionDuration } from '../../../../../shared/messageRetention.js';

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
				autoDeleteAfter?: MessageRetentionDuration | null;
				persistMessages?: boolean;
				description: string;
				name: string;
				watchQueueEnabled?: boolean;
				forceSpoiler?: boolean;
				voiceSettings?: VoiceChannelSettings;
			};
		};
	}>();

	const uid = `cs-${Math.random().toString(36).slice(2, 8)}`;
	const formId = `${uid}-form`;
	const RETENTION_OPTIONS = retentionOptions();

	// ---------------------------------------------------------------- who may do what
	$: isStaff = canManageChannel($currentUser?.highestRole);
	$: canClearMessages = isStaff;
	$: canDeleteChannel = isStaff && channel.id !== 'general' && channel.id !== 'voice';

	$: channelKind = (channel.type || 'text') as string;
	$: isWikiChannel = channelKind === 'wiki';
	$: isForumChannel = channelKind === 'forum';
	$: isGalleryChannel = channelKind === 'gallery';
	$: isVoiceChannel = channelKind === 'voice';
	$: isFolder = channelKind === 'category';
	$: isChatLikeChannel = isChatLikeKind(channelKind);
	$: isConversation = channelKind === 'dm' || channelKind === 'group';
	$: settingsTitle = channelSettingsTitle(channelKind);
	$: placeName = channelSettingsNote(channelKind, channel.name);
	$: kindNoun = isFolder ? 'folder' : isVoiceChannel ? 'room' : 'channel';
	$: tabs = channelSettingsTabs(channelKind);

	// ---------------------------------------------------------------- tabs
	let activeTab: ChannelSettingsTab = 'general';
	$: if (!tabs.some((tab) => tab.id === activeTab)) activeTab = 'general';
	const tabButtons: Record<string, HTMLButtonElement | null> = {};

	function selectTab(id: ChannelSettingsTab): void {
		activeTab = id;
		if (id === 'permissions') void ensureGateLoaded();
	}

	async function handleTabKeydown(event: KeyboardEvent): Promise<void> {
		const next = nextTab(tabs.map((tab) => tab.id), activeTab, event.key);
		if (!next) return;
		event.preventDefault();
		selectTab(next);
		await tick();
		tabButtons[next]?.focus();
	}

	// ---------------------------------------------------------------- current message lifetime
	let currentRetention: string | null = null;
	let retentionReady = false;
	let retentionError: '' | 'signin' | 'invalid' | 'failed' = '';
	let retentionRequestKey = '';
	let retentionAbort: AbortController | null = null;
	$: {
		const key = `${$activeServerUrl}|${channel.id}|${$currentUser?.dbUserId ?? 'guest'}|${String(channel.autoDeleteAfter)}`;
		if (key !== retentionRequestKey) {
			retentionRequestKey = key;
			void loadCurrentRetention($activeServerUrl, channel.id, key);
		}
	}
	$: effectiveAutoDelete = retentionReady
		? currentRetention === 'forever' ? null : currentRetention
		: undefined;

	async function loadCurrentRetention(server: string, id: string, key: string): Promise<void> {
		retentionAbort?.abort();
		const abort = new AbortController();
		retentionAbort = abort;
		retentionReady = false;
		retentionError = '';
		const token = getAuthToken(server);
		if (!token) {
			retentionError = 'signin';
			return;
		}
		try {
			const response = await fetch(`${server}/api/privacy/channels/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${token}` }, credentials: 'include', signal: abort.signal
			});
			if (!response.ok) throw new Error(`lifetime check failed (${response.status})`);
			const label = currentRetentionFromPrivacy(await response.json(), id);
			if (abort.signal.aborted || retentionRequestKey !== key || getAuthToken(server) !== token || $activeServerUrl !== server) return;
			if (label === null) {
				retentionError = 'invalid';
				return;
			}
			currentRetention = label;
			retentionReady = true;
		} catch (error) {
			if (abort.signal.aborted || retentionRequestKey !== key) return;
			console.warn('[channel-settings] lifetime check failed', error);
			retentionError = 'failed';
		}
	}
	onDestroy(() => retentionAbort?.abort());

	$: retentionErrorText =
		retentionError === 'signin'
			? 'Sign in again to check it. Nothing changes until it is checked.'
			: retentionError === 'invalid'
				? 'The server sent a lifetime Wabi does not recognise. Nothing changes until it is checked.'
				: 'Nothing changes until the server confirms it.';

	/** Unsaved lifetime choice; undefined while the room keeps its current one. */
	let draftRetention: RetentionChoice | undefined = undefined;
	let retentionSelect = '';
	$: shownRetention = draftRetention !== undefined ? draftRetention : (effectiveAutoDelete as RetentionChoice | undefined);
	$: if (!retentionBusy) retentionSelect = retentionValue(shownRetention);
	let retentionBusy = false;

	async function chooseRetention(value: string): Promise<void> {
		if (!retentionReady) return;
		const next = retentionChoiceFor(value);
		const previous = shownRetention;
		if (next === previous) return;
		retentionBusy = true;
		let ok = true;
		if (isLiveRetention(next) && !isLiveRetention(previous)) {
			ok = await confirmAction({
				title: `Make #${channel.name} a live room?`,
				body: 'New messages are not saved and are lost when the server restarts, and earlier messages may be hidden while the room is live. Not saving messages does not hide them from the server operator.',
				confirm: 'Make it live'
			});
		} else if (next === null && previous !== null) {
			ok = await confirmAction({
				title: 'Keep new messages forever?',
				body: `New messages in #${channel.name} stay until someone deletes them. Earlier messages keep the lifetime they were sent with.`,
				confirm: 'Keep forever'
			});
		}
		retentionBusy = false;
		if (!ok) {
			retentionSelect = retentionValue(previous);
			return;
		}
		draftRetention = next === effectiveAutoDelete ? undefined : next;
	}

	// ---------------------------------------------------------------- who can open (channel gate)
	let gateStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
	let gateBase: string | null = null;
	let tempGate = '';
	let gateServer = '';
	$: gateApplies = hasChannelGate(channelKind);

	async function gateRequest(path: string, init: RequestInit, server: string): Promise<Record<string, unknown>> {
		const token = getAuthToken(server);
		if (!token) throw new Error('not signed in');
		const response = await fetch(`${server}/api/server-center${path}`, {
			...init,
			credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(`channel gate request failed (${response.status})`);
		return data as Record<string, unknown>;
	}

	async function loadGate(): Promise<void> {
		const server = $activeServerUrl;
		gateServer = server;
		gateStatus = 'loading';
		try {
			const data = await gateRequest('/channel-gates', {}, server);
			if (gateServer !== server) return;
			const roles = (data.minRoles ?? {}) as Record<string, string>;
			gateBase = roles[channel.id] ?? '';
			tempGate = gateBase;
			gateStatus = 'ready';
		} catch (error) {
			if (gateServer !== server) return;
			console.warn('[channel-settings] channel gate load failed', error);
			gateStatus = 'error';
		}
	}

	function ensureGateLoaded(): void {
		if (isStaff && gateApplies && (gateStatus === 'idle' || gateStatus === 'error')) void loadGate();
	}

	// ---------------------------------------------------------------- Lore binding (spec 2026-08-28 P1.4)
	let loreBindingAvailable = false;
	let loreBindingActive = false;
	let loreBindingStatus = '';
	let loreBindingBusy = false;
	let tempLoreRepoChannel = '';
	let tempLorePath = '/';
	let tempLoreBranch = 'main';
	let tempLoreMode = 'hybrid';
	let tempLoreAllowedTypes = '';
	$: loreChannels = $channels.filter((c) => (c.type || 'text') === 'lore');
	$: loreRepoOptions = loreChannels.map((c) => ({ value: c.id, label: c.name }));
	const LORE_MODE_OPTIONS = [
		{ value: 'none', label: 'None · promote by hand' },
		{ value: 'direct', label: 'Direct commit' },
		{ value: 'stage', label: 'Stage for review' },
		{ value: 'hybrid', label: 'Hybrid · by role' }
	];
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
		loreBindingBusy = true;
		loreBindingStatus = '';
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
			loreBindingStatus = 'saved';
		} catch (e) {
			console.warn('[channel-settings] lore binding save failed', e);
			loreBindingStatus = 'save-failed';
		} finally {
			loreBindingBusy = false;
		}
	}

	async function removeLoreBinding(): Promise<void> {
		const numeric = parseLoreChannelId(channel.id);
		const token = getAuthToken();
		if (!numeric || !token) return;
		loreBindingBusy = true;
		loreBindingStatus = '';
		try {
			await deleteLoreBinding(token, numeric);
			loreBindingActive = false;
			tempLoreRepoChannel = '';
			tempLorePath = '/';
			loreBindingStatus = 'removed';
		} catch (e) {
			console.warn('[channel-settings] lore binding remove failed', e);
			loreBindingStatus = 'remove-failed';
		} finally {
			loreBindingBusy = false;
		}
	}

	// ---------------------------------------------------------------- draft fields
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
	let baseRenderWindow = tempLiveRenderWindow;

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
		baseRenderWindow = tempLiveRenderWindow;
		draftRetention = undefined;
		gateStatus = 'idle';
		gateBase = null;
		saveError = '';
		clearState = 'idle';
	}

	$: liveActive = isLiveRetention(
		draftRetention !== undefined ? draftRetention : retentionReady ? effectiveAutoDelete : channel.autoDeleteAfter
	);

	$: baseline = {
		name: channel.name || '',
		description: channel.description || '',
		forceSpoiler: channel.forceSpoiler || false,
		watchQueueEnabled: channel.watchQueueEnabled || false,
		persistMessages: channel.persistMessages || false,
		voiceUserLimit: channel.voiceSettings?.userLimit ? String(channel.voiceSettings.userLimit) : '',
		voiceForceSolo: channel.voiceSettings?.forceSolo === true,
		renderWindow: baseRenderWindow,
		gate: gateBase
	} satisfies ChannelDraftBaseline;
	$: dirty = channelDraftDirty(
		{
			name: tempChannelName,
			description: tempDescription,
			forceSpoiler: tempForceSpoiler,
			watchQueueEnabled: tempWatchQueueEnabled,
			persistMessages: tempPersistMessages,
			voiceUserLimit: tempVoiceUserLimit,
			voiceForceSolo: tempVoiceForceSolo,
			renderWindow: tempLiveRenderWindow,
			gate: gateStatus === 'ready' ? tempGate : null,
			retention: draftRetention,
			liveFields: liveActive ? [tempLiveTtl, tempLiveCap, tempLiveGrace, tempLiveAttachMax] : []
		},
		baseline
	);

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

	function saveChannelSettings(autoDeleteAfter?: RetentionChoice): void {
		const liveUpdates: Record<string, unknown> = {};
		if (isLiveRetention(tempLiveTtl ? undefined : effectiveAutoDelete) || isLiveRetention(autoDeleteAfter)) {
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
				...explicitRetentionUpdate(autoDeleteAfter),
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

	// ---------------------------------------------------------------- save
	let saving = false;
	let saveError = '';

	async function handleSave(): Promise<void> {
		if (saving || !dirty) return;
		saveError = '';
		if (gateStatus === 'ready' && gateBase !== null && tempGate !== gateBase) {
			saving = true;
			try {
				await gateRequest(
					`/channel-gates/${encodeURIComponent(channel.id)}`,
					{ method: 'PUT', body: JSON.stringify({ minRole: tempGate || null }) },
					gateServer || $activeServerUrl
				);
				gateBase = tempGate;
			} catch (error) {
				console.warn('[channel-settings] channel gate save failed', error);
				saveError = 'gate';
				saving = false;
				activeTab = 'permissions';
				return;
			}
			saving = false;
		}
		saveChannelSettings(draftRetention);
	}

	// ---------------------------------------------------------------- history
	let clearState: 'idle' | 'busy' | 'done' | 'error' = 'idle';
	let clearProblem = '';

	async function clearAllMessages(): Promise<void> {
		if (!canClearMessages || isConversation || clearState === 'busy') return;
		const confirmed = await confirmAction({
			title: `Clear the history of #${channel.name}?`,
			body: 'Visible messages are removed for everyone once storage confirms it. Attachment files are not deleted, and backups or older storage may keep copies.',
			confirm: 'Clear history',
			danger: true
		});
		if (!confirmed) return;
		if (!get(connected)) {
			clearState = 'error';
			clearProblem = 'Reconnect to the server, then check the channel and try again.';
			return;
		}
		const sock = getSocket();
		if (!sock) {
			clearState = 'error';
			clearProblem = 'The server connection is unavailable. Check the channel before trying again.';
			return;
		}
		clearState = 'busy';
		const requestedChannelId = channel.id;
		const onSuccess = (payload: { channelId?: string }) => {
			if (payload?.channelId !== requestedChannelId) return;
			cleanup();
			clearState = 'done';
		};
		const onError = (payload: { channelId?: string; error?: string }) => {
			if (payload?.channelId !== requestedChannelId) return;
			cleanup();
			console.warn('[channel-settings] clear failed', payload?.error);
			clearState = 'error';
			clearProblem = 'Nothing was cleared that Wabi could confirm. Check the history before trying again.';
		};
		const cleanup = () => {
			clearTimeout(timer);
			sock.off('channel-messages-cleared', onSuccess);
			sock.off('clear-channel-error', onError);
		};
		const timer = setTimeout(() => {
			cleanup();
			clearState = 'error';
			clearProblem = 'No confirmation came back from the server. Check the history before trying again.';
		}, 15_000);
		sock.on('channel-messages-cleared', onSuccess);
		sock.on('clear-channel-error', onError);
		sock.emit('clear-channel-messages', { channelId: requestedChannelId });
	}

	let localClearState: 'idle' | 'done' | 'error' = 'idle';

	/** Clear this channel's in-memory view; unowned legacy archives are untouched. */
	async function clearLocalMessagesOnly(): Promise<void> {
		if (isConversation) return;
		const confirmed = await confirmAction({
			title: 'Clear the loaded messages on this device?',
			body: `Server history of #${channel.name} is unchanged and may load again when you reopen the channel. Archives and exported files are not deleted.`,
			confirm: 'Clear on this device'
		});
		if (!confirmed) return;
		try {
			const { channelMessages } = await import('$lib/socket');
			channelMessages.update((state) => ({ ...state, [channel.id]: [] }));
			localClearState = 'done';
		} catch (err) {
			console.warn('[channel-settings] local clear failed', err);
			localClearState = 'error';
		}
	}

	// ---------------------------------------------------------------- footer rule only when the body scrolls
	let bodyScrolls = false;
	function watchBodyScroll(node: HTMLElement) {
		const body = node.closest<HTMLElement>('.base-modal__body');
		if (!body || typeof ResizeObserver === 'undefined') return {};
		const measure = () => (bodyScrolls = body.scrollHeight > body.clientHeight + 1);
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		observer.observe(node);
		measure();
		return { destroy: () => observer.disconnect() };
	}

	const close = () => dispatch('close');
</script>

<BaseModal
	isOpen={true}
	onClose={close}
	size="lg"
	padded
	title={settingsTitle}
	note={placeName}
	panelClass="channel-settings"
>
	<form id={formId} class="cs-layout" use:watchBodyScroll on:submit|preventDefault={() => void handleSave()}>
		<div class="w-seg w-seg--vertical cs-tabs" role="tablist" aria-orientation="vertical" aria-label="{settingsTitle} sections">
			{#each tabs as tab (tab.id)}
				<button
					type="button"
					role="tab"
					id="{uid}-tab-{tab.id}"
					aria-selected={activeTab === tab.id}
					aria-controls="{uid}-panel"
					tabindex={activeTab === tab.id ? 0 : -1}
					bind:this={tabButtons[tab.id]}
					on:click={() => selectTab(tab.id)}
					on:keydown={handleTabKeydown}
				>{tab.label}</button>
			{/each}
		</div>

		<div class="cs-panel" role="tabpanel" id="{uid}-panel" aria-labelledby="{uid}-tab-{activeTab}">
			{#if activeTab === 'general'}
				<div class="cs-fields">
					<div class="cs-field">
						<label class="w-label" for="{uid}-name">Name</label>
						<div class="w-field cs-name">
							{#if isChatLikeChannel}<span class="cs-prefix" aria-hidden="true">#</span>{/if}
							<input id="{uid}-name" type="text" bind:value={tempChannelName} maxlength="64" autocomplete="off" disabled={!isStaff} />
						</div>
					</div>
					{#if !isFolder}
						<div class="cs-field">
							<label class="w-label" for="{uid}-description">Description</label>
							<input
								id="{uid}-description"
								class="w-field"
								type="text"
								bind:value={tempDescription}
								placeholder="What this {kindNoun} is for"
								maxlength="200"
								aria-describedby="{uid}-description-count"
								disabled={!isStaff}
							/>
							<div class="w-field-foot">
								<span class="w-field-count" id="{uid}-description-count">{tempDescription.length} / 200</span>
							</div>
						</div>
					{/if}
				</div>

				<div class="w-srows cs-rows">
					{#if isWikiChannel || isForumChannel || isGalleryChannel}
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label">{isWikiChannel ? 'Pages' : isForumChannel ? 'Threads' : 'Albums'}</p>
								<p class="w-srow__hint">
									{#if isWikiChannel}Pages live in this wiki. Message lifetime and spoilers do not apply.
									{:else if isForumChannel}Threads and replies live in this forum. Message lifetime and spoilers do not apply.
									{:else}Albums belong to this gallery. Message lifetime does not apply.{/if}
								</p>
							</div>
						</div>
					{/if}

					{#if isVoiceChannel}
						<div class="w-srow">
							<div class="w-srow__text">
								<label class="w-srow__label" for="{uid}-capacity">Capacity</label>
								<p class="w-srow__hint" id="{uid}-capacity-hint">
									Leave empty for no limit. With a limit the sidebar shows who is in as 3/8.{#if !canManageVoiceSettings} Only owners and admins can change it.{/if}
								</p>
							</div>
							<div class="w-srow__control">
								<input
									id="{uid}-capacity"
									class="w-field cs-number"
									type="number"
									min="1"
									max="99"
									step="1"
									inputmode="numeric"
									value={tempVoiceUserLimit}
									on:input={(event) => (tempVoiceUserLimit = event.currentTarget.value)}
									placeholder="No limit"
									aria-describedby="{uid}-capacity-hint"
									disabled={!canManageVoiceSettings}
								/>
							</div>
						</div>
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label" id="{uid}-solo-label">Focused audio</p>
								<p class="w-srow__hint" id="{uid}-solo-hint">
									Joining this room moves listening and talking to it alone. For a one-person room, set capacity to 1.{#if !canManageVoiceSettings} Only owners and admins can change it.{/if}
								</p>
							</div>
							<div class="w-srow__control">
								<Switch labelledby="{uid}-solo-label" describedby="{uid}-solo-hint" bind:checked={tempVoiceForceSolo} disabled={!canManageVoiceSettings} />
							</div>
						</div>
					{/if}

					{#if isChatLikeChannel && !isConversation}
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label" id="{uid}-spoiler-label">Spoiler channel</p>
								<p class="w-srow__hint" id="{uid}-spoiler-hint">Every message here stays hidden until someone reveals it, earlier messages included.</p>
							</div>
							<div class="w-srow__control">
								<Switch labelledby="{uid}-spoiler-label" describedby="{uid}-spoiler-hint" bind:checked={tempForceSpoiler} disabled={!isStaff} />
							</div>
						</div>
					{/if}

					{#if !isConversation && !isVoiceChannel && !isFolder}
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label" id="{uid}-queue-label">YouTube watch queue</p>
								<p class="w-srow__hint" id="{uid}-queue-hint">
									Adds a shared watch queue to this {kindNoun}. Ordinary YouTube link previews keep working.{#if !canManageWatchQueue} Only owners and admins can change it.{/if}
								</p>
							</div>
							<div class="w-srow__control">
								<Switch labelledby="{uid}-queue-label" describedby="{uid}-queue-hint" bind:checked={tempWatchQueueEnabled} disabled={!canManageWatchQueue} />
							</div>
						</div>
					{/if}
				</div>

				{#if isChatLikeChannel && loreBindingAvailable}
					<section class="cs-section" aria-labelledby="{uid}-lore-title">
						<h3 class="cs-section__title" id="{uid}-lore-title">Lore binding</h3>
						<p class="cs-section__hint">Bind this channel to a path in a Lore repository. Attachments can then be promoted there from their menu.</p>
						{#if loreChannels.length === 0}
							<p class="cs-section__hint">There are no Lore channels on this server yet. Create one first.</p>
						{:else}
							<div class="cs-lore">
								<div class="cs-field">
									<span class="w-label" id="{uid}-lore-repo">Repository</span>
									<Select ariaLabel="Repository" options={loreRepoOptions} bind:value={tempLoreRepoChannel} placeholder="Choose a Lore channel" />
								</div>
								<div class="cs-field">
									<span class="w-label">Mode</span>
									<Select ariaLabel="Mode" options={LORE_MODE_OPTIONS} bind:value={tempLoreMode} />
								</div>
								<div class="cs-field">
									<label class="w-label" for="{uid}-lore-path">Target path</label>
									<input id="{uid}-lore-path" class="w-field" type="text" bind:value={tempLorePath} placeholder="/art/concepts/" />
								</div>
								<div class="cs-field">
									<label class="w-label" for="{uid}-lore-branch">Branch</label>
									<input id="{uid}-lore-branch" class="w-field" type="text" bind:value={tempLoreBranch} placeholder="main" />
								</div>
								<div class="cs-field cs-field--wide">
									<label class="w-label" for="{uid}-lore-types">Allowed types</label>
									<input id="{uid}-lore-types" class="w-field" type="text" bind:value={tempLoreAllowedTypes} placeholder="image/*, .blend" />
								</div>
							</div>
							<div class="cs-actions">
								<button class="w-btn w-btn--sm" type="button" disabled={loreBindingBusy || !tempLoreRepoChannel || !tempLorePath.startsWith('/')} on:click={saveLoreBinding}>
									{loreBindingActive ? 'Update binding' : 'Save binding'}
								</button>
								{#if loreBindingActive}
									<button class="w-btn w-btn--sm w-btn--danger" type="button" disabled={loreBindingBusy} on:click={removeLoreBinding}>Remove binding</button>
								{/if}
								{#if loreBindingStatus === 'saved' || loreBindingStatus === 'removed'}
									<span class="cs-status" role="status">{loreBindingStatus === 'saved' ? 'Binding saved' : 'Binding removed'}</span>
								{/if}
							</div>
							{#if loreBindingStatus === 'save-failed' || loreBindingStatus === 'remove-failed'}
								<Notice
									class="cs-notice"
									title={loreBindingStatus === 'save-failed' ? "Couldn't save the binding" : "Couldn't remove the binding"}
									text="The channel's binding is unchanged."
								/>
							{/if}
						{/if}
					</section>
				{/if}

				{#if (isChatLikeChannel && !isConversation && canClearMessages) || canDeleteChannel}
					<section class="cs-section cs-danger" aria-labelledby="{uid}-danger-title">
						<h3 class="cs-section__title" id="{uid}-danger-title">Danger zone</h3>
						<div class="w-srows">
							{#if isChatLikeChannel && !isConversation && canClearMessages}
								<div class="w-srow">
									<div class="w-srow__text">
										<p class="w-srow__label">Clear history</p>
										<p class="w-srow__hint">Removes the visible messages for everyone once storage confirms it. Attachments and backup copies are not deleted.</p>
									</div>
									<div class="w-srow__control">
										<button class="w-btn w-btn--danger" type="button" aria-busy={clearState === 'busy'} disabled={clearState === 'busy'} on:click={clearAllMessages}>
											{clearState === 'busy' ? 'Clearing…' : 'Clear for everyone'}
										</button>
									</div>
								</div>
							{/if}
							{#if canDeleteChannel}
								<div class="w-srow">
									<div class="w-srow__text">
										<p class="w-srow__label">Delete this {kindNoun}</p>
										<p class="w-srow__hint">
											{isFolder ? 'Removes the folder from the server. You choose whether to keep its channels.' : `Removes ${placeName} and its messages for everyone.`}
										</p>
									</div>
									<div class="w-srow__control">
										<button class="w-btn w-btn--danger" type="button" on:click={() => dispatch('delete', { channel })}>Delete {kindNoun}</button>
									</div>
								</div>
							{/if}
						</div>
						{#if clearState === 'done'}
							<p class="cs-status" role="status">History cleared for everyone.</p>
						{:else if clearState === 'error'}
							<Notice class="cs-notice" title="Couldn't clear the history" text={clearProblem} ondismiss={() => (clearState = 'idle')} />
						{/if}
					</section>
				{/if}
			{:else if activeTab === 'permissions'}
				<div class="w-srows">
					{#if gateApplies}
						<div class="w-srow w-srow--seal">
							<div class="w-srow__text">
								<p class="w-srow__label" id="{uid}-gate-label"><Icon name="shield" size={14} />Who can open {placeName}</p>
								<p class="w-srow__hint">
									{isStaff
										? 'Members below this level do not see the channel or its messages.'
										: 'Only owners and admins can see or change who can open a channel.'}
								</p>
							</div>
							{#if isStaff}
								<div class="w-srow__control">
									{#if gateStatus === 'ready'}
										<Select ariaLabel="Who can open {placeName}" options={GATE_OPTIONS} bind:value={tempGate} align="end" />
									{:else if gateStatus === 'loading' || gateStatus === 'idle'}
										<span class="w-skel cs-skel" aria-hidden="true"></span>
										<span class="w-sr-only" role="status">Checking who can open this channel…</span>
									{/if}
								</div>
							{/if}
						</div>
						{#if isStaff && gateStatus === 'error'}
							<Notice class="cs-notice" title="Couldn't check who can open this channel" text="Its access is unchanged." onretry={() => void loadGate()} retryLabel="Check again" />
						{/if}
						{#if saveError === 'gate'}
							<Notice class="cs-notice" title="Couldn't change who can open this channel" text="Nothing was saved. Your other changes are still here." />
						{/if}
					{/if}
					<div class="w-srow w-srow--seal">
						<div class="w-srow__text">
							<p class="w-srow__label"><Icon name="key" size={14} />Who can change these settings</p>
							<p class="w-srow__hint">
								Name, description{isChatLikeChannel ? ', message lifetime, clearing history' : ''} and deleting this {kindNoun}.
								{isStaff ? 'You are one of them.' : 'Ask one of them to make a change.'}
							</p>
						</div>
						<div class="w-srow__control"><span class="cs-fact">Owners and admins</span></div>
					</div>
				</div>
			{:else if activeTab === 'retention'}
				<div class="w-srows">
					<div class="w-srow">
						<div class="w-srow__text">
							<p class="w-srow__label" id="{uid}-lifetime-label">Message lifetime</p>
							<p class="w-srow__hint" id="{uid}-lifetime-hint">
								Applies to new messages. Earlier messages keep the lifetime they were sent with.{#if !isStaff} Only owners and admins can change it.{/if}
							</p>
						</div>
						<div class="w-srow__control">
							{#if retentionReady}
								<Select
									ariaLabel="Message lifetime"
									options={RETENTION_OPTIONS}
									bind:value={retentionSelect}
									onchange={(value) => void chooseRetention(value)}
									disabled={!isStaff || retentionBusy}
									align="end"
								/>
							{:else if !retentionError}
								<span class="w-skel cs-skel" aria-hidden="true"></span>
								<span class="w-sr-only" role="status">Checking the current lifetime…</span>
							{/if}
						</div>
					</div>
					{#if retentionError}
						<Notice
							class="cs-notice"
							title="Couldn't check this room's message lifetime"
							text={retentionErrorText}
							onretry={() => void loadCurrentRetention($activeServerUrl, channel.id, retentionRequestKey)}
							retryLabel="Retry lifetime check"
						/>
					{/if}

					{#if canTogglePersistMessages && !isConversation}
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label" id="{uid}-persist-label">Offline copies and older history</p>
								<p class="w-srow__hint" id="{uid}-persist-hint">Browsers may keep this channel's messages across restarts, and members can load older history. Storage settings on each device can still clear them.</p>
							</div>
							<div class="w-srow__control">
								<Switch labelledby="{uid}-persist-label" describedby="{uid}-persist-hint" bind:checked={tempPersistMessages} />
							</div>
						</div>
					{/if}

					{#if !isConversation}
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label">Messages on this device</p>
								<p class="w-srow__hint">Clears what is loaded here. Server history is unchanged.</p>
							</div>
							<div class="w-srow__control">
								<button class="w-btn" type="button" on:click={clearLocalMessagesOnly}>Clear on this device</button>
							</div>
						</div>
						{#if localClearState === 'done'}
							<p class="cs-status" role="status">Cleared on this device.</p>
						{:else if localClearState === 'error'}
							<Notice class="cs-notice" title="Couldn't clear the messages on this device" text="Nothing else changed." ondismiss={() => (localClearState = 'idle')} />
						{/if}
					{/if}
				</div>

				{#if liveActive}
					<section class="cs-section" aria-labelledby="{uid}-live-title">
						<h3 class="cs-section__title" id="{uid}-live-title">Live room</h3>
						<p class="cs-section__hint">Live messages are not saved. Not saving them does not hide them from the server operator.</p>
						<div class="cs-lore">
							<div class="cs-field">
								<label class="w-label" for="{uid}-live-ttl">How long messages stay</label>
								<input id="{uid}-live-ttl" class="w-field" type="text" bind:value={tempLiveTtl} placeholder="10m" aria-describedby="{uid}-live-ttl-hint" />
								<p class="w-field-hint cs-hint" id="{uid}-live-ttl-hint">30s, 10m or 1h</p>
							</div>
							<div class="cs-field">
								<label class="w-label" for="{uid}-live-cap">Messages kept live</label>
								<input id="{uid}-live-cap" class="w-field" type="text" inputmode="numeric" bind:value={tempLiveCap} placeholder="1000" aria-describedby="{uid}-live-cap-hint" />
								<p class="w-field-hint cs-hint" id="{uid}-live-cap-hint">The most the server holds at once</p>
							</div>
							<div class="cs-field">
								<label class="w-label" for="{uid}-live-grace">Away after disconnecting</label>
								<input id="{uid}-live-grace" class="w-field" type="text" bind:value={tempLiveGrace} placeholder="60s" aria-describedby="{uid}-live-grace-hint" />
								<p class="w-field-hint cs-hint" id="{uid}-live-grace-hint">How long before someone shows as away</p>
							</div>
							<div class="cs-field">
								<label class="w-label" for="{uid}-live-attach">Largest attachment</label>
								<input id="{uid}-live-attach" class="w-field" type="text" bind:value={tempLiveAttachMax} placeholder="8 MB" />
							</div>
							<div class="cs-field">
								<label class="w-label" for="{uid}-live-window">Messages drawn on this device</label>
								<input id="{uid}-live-window" class="w-field" type="number" min="50" max="5000" step="50" bind:value={tempLiveRenderWindow} aria-describedby="{uid}-live-window-hint" />
								<p class="w-field-hint cs-hint" id="{uid}-live-window-hint">Fewer helps slower computers. The server is unaffected.</p>
							</div>
						</div>
						<div class="w-srows cs-rows">
							<div class="w-srow">
								<div class="w-srow__text">
									<p class="w-srow__label" id="{uid}-afk-label">Away announcements</p>
									<p class="w-srow__hint" id="{uid}-afk-hint">Post a line when someone goes away or comes back.</p>
								</div>
								<div class="w-srow__control">
									<Switch labelledby="{uid}-afk-label" describedby="{uid}-afk-hint" bind:checked={tempAfkAnnounce} />
								</div>
							</div>
						</div>
					</section>
				{/if}
			{/if}
		</div>
	</form>

	<div slot="footer" class="w-dialog__foot cs-foot" class:w-dialog__foot--rule={bodyScrolls}>
		{#if draftRetention !== undefined}
			<p class="w-dialog__foot-start cs-unsaved"><span class="w-dot w-dot--warn" aria-hidden="true"></span>Lifetime changes when you save</p>
		{/if}
		<button type="button" class="w-btn w-btn--quiet" on:click={close} disabled={saving}>Cancel</button>
		<button type="submit" form={formId} class="w-btn w-btn--primary" aria-busy={saving} disabled={!dirty || saving || !isStaff}>
			{saving ? 'Saving…' : 'Save changes'}
		</button>
	</div>
</BaseModal>

<style>
	/* Nav on the left, the panel scrolls beside it; the nav stays at the top while it does. */
	.cs-layout {
		display: grid;
		grid-template-columns: 148px minmax(0, 1fr);
		column-gap: 32px;
		align-items: start;
		padding-top: 4px;
	}
	.cs-tabs {
		position: sticky;
		top: 0;
		z-index: 1;
		align-self: start;
	}
	.cs-tabs > button {
		width: 100%;
	}
	.cs-panel {
		min-width: 0;
		/* Switching sections does not make the centred dialog jump. */
		min-height: calc(380px * var(--w-fs));
		outline: none;
	}

	.cs-fields {
		display: grid;
		gap: 20px;
		margin-bottom: 24px;
	}
	.cs-field {
		min-width: 0;
	}
	.cs-name > input {
		min-width: 0;
	}
	.cs-prefix {
		flex: none;
		color: var(--w-sig);
		font: 400 calc(16px * var(--w-fs)) / 1 var(--w-sans);
	}
	.cs-number {
		width: 120px;
	}

	/* A titled group inside a panel: serif subhead, one hint line, its rows below. */
	.cs-section {
		margin-top: 32px;
	}
	.cs-section__title {
		margin: 0;
		color: var(--w-text);
		font: var(--w-t-subhead);
	}
	.cs-section__hint {
		margin: 4px 0 14px;
		color: var(--w-mute);
		font: var(--w-t-small);
		text-wrap: pretty;
	}
	/* The danger zone is a hairline section (its rows' rules), never a box or a seal. */
	.cs-danger .cs-section__title {
		margin-bottom: 12px;
	}
	.cs-rows + .cs-section {
		margin-top: 32px;
	}

	.cs-lore {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px 20px;
	}
	.cs-field--wide {
		grid-column: 1 / -1;
	}
	.cs-lore :global(.w-select) {
		width: 100%;
	}
	.cs-hint {
		display: block;
		margin: 6px 0 0;
	}
	.cs-lore + .cs-rows {
		margin-top: 20px;
	}
	.cs-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
	}

	.cs-fact {
		color: var(--w-text);
		font: var(--w-t-ui);
		white-space: nowrap;
	}
	.cs-status {
		margin: 12px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.cs-actions .cs-status {
		margin: 0;
	}
	.cs-skel {
		width: 160px;
	}
	.w-srows :global(.cs-notice),
	.cs-section :global(.cs-notice) {
		margin: 12px 0;
	}

	.cs-unsaved {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	/* The scrolling body ends with a little room above the footer. */
	.cs-foot {
		padding-top: 16px;
	}

	.w-sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	@media (max-width: 640px) {
		.cs-layout {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 20px;
		}
		.cs-tabs {
			position: static;
			flex-direction: row;
			justify-self: start;
		}
		.cs-tabs > button {
			width: auto;
		}
		.cs-lore {
			grid-template-columns: minmax(0, 1fr);
		}
		.cs-panel {
			min-height: 0;
		}
	}
</style>
