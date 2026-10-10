<script lang="ts">
	import { pushFailureMessage } from '$lib/pwa/pushDiagnostics';
	import { onDestroy, onMount } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { isTauriRuntime } from '$lib/tauri-platform';
	import { areBackgroundFollowAlertsEnabled } from '$lib/notificationSettings';
	import {
		getDefaultCustomSynthRingtonePreset,
		playCallRingtone,
		playNotificationSound,
		requestNotificationPermission,
		sanitizeCustomSynthRingtonePreset,
		stopCallRingtone,
		type CustomSynthRingtonePreset,
		type CustomSynthWaveform
	} from '$lib/notifications';
	import {
		CALL_RINGTONE_OPTIONS,
		CUSTOM_SYNTH_WAVEFORM_OPTIONS,
		type CallRingtoneMode
	} from './notificationSettingsHelpers';
	import {
		getPushSubscriptionState,
		sendTestPush,
		subscribeWebPush,
		unsubscribeWebPush,
		getPushPreferences,
		setPushPreferences,
		getPushChannelPrefs,
		setPushChannelPrefs,
		setPushOptOut,
		type PushPreferences
	} from '$lib/pwa/pushClient';
	import { channels } from '$lib/channelStore';
	import { buildPushChannelRows } from '$lib/pwa/pushChannels';
	import { ensureChannelMembership } from '$lib/api/channelAccess';

	let notificationsEnabled = true;
	// True when the app is running as an installed PWA (standalone display mode).
	let isPwaStandalone = false;
	let pushPreferences: PushPreferences = { directMessages: true, calls: true };
	let suppressEveryoneHereMentions = false;
	let suppressRoleMentions = false;
	let notificationPreviewEnabled = false;
	let backgroundFollowAlertsEnabled = true;
	let notificationSound = '/sounds/ProjectSound.ogg';
	let notificationSoundLabel = 'ProjectSound.ogg';
	let notificationVolume = 0.5;
	let callRingtoneMode: CallRingtoneMode = 'classic-bell';
	let callRingtoneLabel = 'Classic Bell';
	let callRingtoneVolume = 0.65;
	let callRingtoneCustomSynth: CustomSynthRingtonePreset = getDefaultCustomSynthRingtonePreset();
	let notificationSoundInput: HTMLInputElement;
	let callRingtoneInput: HTMLInputElement;
	let callRingtoneSynthImportInput: HTMLInputElement;
	let callRingtonePreviewTimeout: number | null = null;
	let callRingtoneSynthEditorExpanded = false;
	let pushPermission: NotificationPermission | 'unsupported' = 'default';
	let pushSubscribed = false;
	let pushBusy = false;
	let pushStatus = '';
	// Per-channel message push: opt-in, so every channel row starts off until
	// the account switched it on server-side. DMs are not in this list; they
	// follow the account-level switch.
	let pushChannelsEnabled: string[] = [];
	// A failed read must not render as "all off" — that would let one save
	// silently drop choices the server still holds.
	let pushChannelsError = false;
	$: pushChannelRows = buildPushChannelRows($channels);

	onMount(() => {
		notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		isPwaStandalone =
			window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
			(navigator as unknown as { standalone?: boolean }).standalone === true;
		suppressEveryoneHereMentions = localStorage.getItem('suppressEveryoneHereMentions') === 'true';
		suppressRoleMentions = localStorage.getItem('suppressRoleMentions') === 'true';
		notificationPreviewEnabled = localStorage.getItem('notificationPreviewEnabled') === 'true';
		backgroundFollowAlertsEnabled = areBackgroundFollowAlertsEnabled();
		notificationSound = localStorage.getItem('notificationSound') || '/sounds/ProjectSound.ogg';
		notificationSoundLabel =
			notificationSound === '/sounds/ProjectSound.ogg'
				? 'ProjectSound.ogg'
				: localStorage.getItem('notificationSoundLabel') || 'Custom sound';
		notificationVolume = parseFloat(localStorage.getItem('notificationVolume') || '0.5');
		callRingtoneCustomSynth = loadStoredCallRingtoneCustomSynth();
		const storedCallRingtoneMode = localStorage.getItem('callRingtoneMode');
		callRingtoneMode = isCallRingtoneMode(storedCallRingtoneMode) ? storedCallRingtoneMode : 'classic-bell';
		callRingtoneLabel = getResolvedCallRingtoneLabel(callRingtoneMode);
		const storedCallRingtoneVolume = parseFloat(localStorage.getItem('callRingtoneVolume') || '0.65');
		callRingtoneVolume = Number.isFinite(storedCallRingtoneVolume)
			? Math.min(1, Math.max(0, storedCallRingtoneVolume))
			: 0.65;
		void refreshPushState();
	});

	async function refreshPushState(): Promise<void> {
		const state = await getPushSubscriptionState();
		pushPermission = state.permission;
		pushSubscribed = state.subscribed;
		pushPreferences = await getPushPreferences();
		const enabled = await getPushChannelPrefs();
		pushChannelsError = enabled === null;
		if (enabled) pushChannelsEnabled = enabled;
	}

	onDestroy(() => {
		if (callRingtonePreviewTimeout !== null) {
			window.clearTimeout(callRingtonePreviewTimeout);
			callRingtonePreviewTimeout = null;
		}
		stopCallRingtone();
	});

	function isCallRingtoneMode(value: string | null): value is CallRingtoneMode {
		return CALL_RINGTONE_OPTIONS.some((option) => option.value === value);
	}

	function getCallRingtonePresetLabel(mode: CallRingtoneMode): string {
		return CALL_RINGTONE_OPTIONS.find((option) => option.value === mode)?.label || 'Classic Bell';
	}

	function getResolvedCallRingtoneLabel(mode: CallRingtoneMode): string {
		if (mode === 'custom-audio') {
			return localStorage.getItem('callRingtoneLabel') || 'Custom audio';
		}
		if (mode === 'custom-synth') {
			return callRingtoneCustomSynth.name?.trim() || 'Custom Synth';
		}
		return getCallRingtonePresetLabel(mode);
	}

	function saveCallRingtoneCustomSynth(): void {
		const sanitized = sanitizeCustomSynthRingtonePreset(callRingtoneCustomSynth);
		callRingtoneCustomSynth = sanitized;
		localStorage.setItem('callRingtoneCustomSynth', JSON.stringify(sanitized));
		if (callRingtoneMode === 'custom-synth') {
			callRingtoneLabel = getResolvedCallRingtoneLabel('custom-synth');
		}
	}

	function loadStoredCallRingtoneCustomSynth(): CustomSynthRingtonePreset {
		const raw = localStorage.getItem('callRingtoneCustomSynth');
		if (!raw) return getDefaultCustomSynthRingtonePreset();
		try {
			return sanitizeCustomSynthRingtonePreset(JSON.parse(raw));
		} catch (error) {
			console.warn('[Settings] Failed to parse custom synth ringtone preset:', error);
			return getDefaultCustomSynthRingtonePreset();
		}
	}

	function getCallRingtoneCustomSynthSummary(): string {
		const secondaryTone =
			callRingtoneCustomSynth.secondaryToneHz > 0
				? ` + ${Math.round(callRingtoneCustomSynth.secondaryToneHz)}Hz`
				: '';
		return `${callRingtoneCustomSynth.name} | ${callRingtoneCustomSynth.waveform} | ${Math.round(callRingtoneCustomSynth.primaryToneHz)}Hz${secondaryTone}`;
	}

	function toggleSuppressEveryoneHereMentions() {
		suppressEveryoneHereMentions = !suppressEveryoneHereMentions;
		localStorage.setItem('suppressEveryoneHereMentions', suppressEveryoneHereMentions.toString());
	}

	function toggleSuppressRoleMentions() {
		suppressRoleMentions = !suppressRoleMentions;
		localStorage.setItem('suppressRoleMentions', suppressRoleMentions.toString());
	}

	function toggleNotificationPreview() {
		notificationPreviewEnabled = !notificationPreviewEnabled;
		localStorage.setItem('notificationPreviewEnabled', notificationPreviewEnabled.toString());
		window.dispatchEvent(new Event('wabi:notification-settings-changed'));
	}

	function toggleBackgroundFollowAlerts() {
		backgroundFollowAlertsEnabled = !backgroundFollowAlertsEnabled;
		localStorage.setItem('backgroundFollowAlertsEnabled', String(backgroundFollowAlertsEnabled));
	}

	function updateNotificationSound(sound: string) {
		notificationSound = sound;
		localStorage.setItem('notificationSound', sound);
		notificationSoundLabel =
			sound === '/sounds/ProjectSound.ogg'
				? 'ProjectSound.ogg'
				: localStorage.getItem('notificationSoundLabel') || 'Custom sound';
	}

	function updateNotificationVolume(volume: number) {
		notificationVolume = volume;
		localStorage.setItem('notificationVolume', volume.toString());
	}

	function updateCallRingtoneMode(mode: CallRingtoneMode) {
		callRingtoneMode = mode;
		localStorage.setItem('callRingtoneMode', mode);
		callRingtoneLabel = getResolvedCallRingtoneLabel(mode);
		if (mode !== 'custom-synth') {
			callRingtoneSynthEditorExpanded = false;
		}
		stopCallRingtone();
	}

	function updateCallRingtoneVolume(volume: number) {
		callRingtoneVolume = volume;
		localStorage.setItem('callRingtoneVolume', volume.toString());
	}

	function updateCallRingtoneCustomSynthField<K extends keyof CustomSynthRingtonePreset>(
		key: K,
		value: CustomSynthRingtonePreset[K]
	) {
		callRingtoneCustomSynth = sanitizeCustomSynthRingtonePreset({
			...callRingtoneCustomSynth,
			[key]: value
		});
		saveCallRingtoneCustomSynth();
	}

	function testNotificationSound() {
		try {
			playNotificationSound();
			pushStatus = 'Notification sound test started.';
		} catch (error) {
			pushStatus = error instanceof Error ? error.message : 'Notification sound is unavailable.';
		}
	}

	function testCallRingtone() {
		if (callRingtonePreviewTimeout !== null) {
			window.clearTimeout(callRingtonePreviewTimeout);
			callRingtonePreviewTimeout = null;
		}
		stopCallRingtone();
		playCallRingtone();
		callRingtonePreviewTimeout = window.setTimeout(() => {
			stopCallRingtone();
			callRingtonePreviewTimeout = null;
		}, 4800);
	}

	function triggerNotificationSoundFilePicker(): void {
		notificationSoundInput?.click();
	}

	function triggerCallRingtoneFilePicker(): void {
		callRingtoneInput?.click();
	}

	function triggerCallRingtoneSynthImportFilePicker(): void {
		callRingtoneSynthImportInput?.click();
	}

	function resetNotificationSoundToDefault(): void {
		notificationSoundLabel = 'ProjectSound.ogg';
		localStorage.removeItem('notificationSoundLabel');
		updateNotificationSound('/sounds/ProjectSound.ogg');
	}

	function resetCallRingtoneToDefault(): void {
		localStorage.removeItem('callRingtoneCustomAudio');
		localStorage.removeItem('callRingtoneLabel');
		callRingtoneCustomSynth = getDefaultCustomSynthRingtonePreset();
		localStorage.setItem('callRingtoneCustomSynth', JSON.stringify(callRingtoneCustomSynth));
		updateCallRingtoneMode('classic-bell');
		callRingtoneLabel = 'Classic Bell';
	}

	function resetCallRingtoneCustomSynth(): void {
		callRingtoneCustomSynth = getDefaultCustomSynthRingtonePreset();
		saveCallRingtoneCustomSynth();
		if (callRingtoneMode !== 'custom-synth') {
			updateCallRingtoneMode('custom-synth');
		}
		callRingtoneSynthEditorExpanded = true;
	}

	function exportCallRingtoneCustomSynth(): void {
		const preset = sanitizeCustomSynthRingtonePreset(callRingtoneCustomSynth);
		const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		const safeName =
			(preset.name || 'custom-synth')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '') || 'custom-synth';
		link.href = url;
		link.download = `${safeName}-ringtone.json`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	async function handleNotificationSoundFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isAudioFile = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name);
		if (!isAudioFile) {
			alert('Please choose an audio file.');
			input.value = '';
			return;
		}
		if (file.size > 1024 * 1024) {
			alert('Custom notification sounds must be 1MB or smaller.');
			input.value = '';
			return;
		}

		try {
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result || ''));
				reader.onerror = () => reject(new Error('Failed to read audio file.'));
				reader.readAsDataURL(file);
			});
			if (!dataUrl.startsWith('data:audio')) {
				throw new Error('Unsupported audio encoding.');
			}
			localStorage.setItem('notificationSoundLabel', file.name);
			notificationSoundLabel = file.name;
			updateNotificationSound(dataUrl);
			testNotificationSound();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to load custom sound.');
		} finally {
			input.value = '';
		}
	}

	async function handleCallRingtoneSynthImportFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isJsonFile = file.type === 'application/json' || /\.json$/i.test(file.name);
		if (!isJsonFile) {
			alert('Please choose a JSON preset file.');
			input.value = '';
			return;
		}

		try {
			const text = await file.text();
			const preset = sanitizeCustomSynthRingtonePreset(JSON.parse(text));
			callRingtoneCustomSynth = preset;
			saveCallRingtoneCustomSynth();
			updateCallRingtoneMode('custom-synth');
			callRingtoneSynthEditorExpanded = true;
			testCallRingtone();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to import synth preset.');
		} finally {
			input.value = '';
		}
	}

	async function handleCallRingtoneFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isAudioFile = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name);
		if (!isAudioFile) {
			alert('Please choose an audio file.');
			input.value = '';
			return;
		}
		if (file.size > 1024 * 1024) {
			alert('Custom call ringtones must be 1MB or smaller.');
			input.value = '';
			return;
		}

		try {
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result || ''));
				reader.onerror = () => reject(new Error('Failed to read audio file.'));
				reader.readAsDataURL(file);
			});
			if (!dataUrl.startsWith('data:audio')) {
				throw new Error('Unsupported audio encoding.');
			}
			localStorage.setItem('callRingtoneCustomAudio', dataUrl);
			localStorage.setItem('callRingtoneLabel', file.name);
			callRingtoneLabel = file.name;
			updateCallRingtoneMode('custom-audio');
			testCallRingtone();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to load custom ringtone.');
		} finally {
			input.value = '';
		}
	}

	function desktopNotificationsOn(): boolean {
		// Effective state = stored intent AND real permission. In Tauri the
		// native permission is requested through the plugin on toggle-on.
		return notificationsEnabled && (isTauriRuntime() || pushPermission === 'granted');
	}

	async function toggleDesktopNotifications(): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		pushStatus = '';
		try {
			if (desktopNotificationsOn()) {
				notificationsEnabled = false;
				localStorage.setItem('notificationsEnabled', 'false');
				// Master switch: opting out also drops background push so the
				// server stops delivering to this device.
				if (!isTauriRuntime()) {
					setPushOptOut(true);
					if (pushSubscribed) await unsubscribeWebPush();
				}
				await refreshPushState();
				pushStatus = 'Desktop notifications off.';
				return;
			}
			if (!isTauriRuntime() && !('Notification' in window)) {
				pushStatus = 'This browser does not support notifications.';
				return;
			}
			// Click = user gesture, so the one-time permission prompt is allowed.
			const permission = await requestNotificationPermission();
			if (permission !== 'granted') {
				// Leave the stored intent untouched: a blocked prompt must not
				// silently rewrite an earlier choice.
				pushStatus =
					permission === 'denied'
						? 'Notifications are blocked for this site. Allow them in your browser or device settings, then try again.'
						: 'Permission not granted.';
				return;
			}
			notificationsEnabled = true;
			localStorage.setItem('notificationsEnabled', 'true');
			if (isTauriRuntime()) {
				await refreshPushState();
				pushStatus = 'System notifications on.';
				return;
			}
			setPushOptOut(false);
			const sub = await subscribeWebPush();
			await refreshPushState();
			pushStatus = sub.ok
				? 'Desktop notifications on — push subscribed.'
				: `Desktop notifications on; push: ${pushFailureMessage('reason' in sub ? sub.reason : 'failed')}`;
		} finally {
			pushBusy = false;
		}
	}

	async function togglePushSubscription(): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		pushStatus = '';
		try {
			if (pushSubscribed) {
				setPushOptOut(true);
				await unsubscribeWebPush();
				await refreshPushState();
				pushStatus = 'Push unsubscribed.';
			} else {
				setPushOptOut(false);
				const result = await subscribeWebPush();
				await refreshPushState();
				pushStatus = result.ok
					? 'Push subscribed — background alerts enabled.'
					: pushFailureMessage('reason' in result ? result.reason : 'failed');
			}
		} finally {
			pushBusy = false;
		}
	}

	async function handleTestPush(): Promise<void> {
		pushBusy = true;
		pushStatus = '';
		try {
			const result = await sendTestPush();
			pushStatus = result.ok ? 'Test push sent — check the tray.' : `Test failed: ${result.reason}`;
		} finally {
			pushBusy = false;
		}
	}

	async function togglePushPreference(key: keyof PushPreferences): Promise<void> {
		pushBusy = true;
		try {
			const next = { ...pushPreferences, [key]: !pushPreferences[key] };
			if (await setPushPreferences(next)) {
				pushPreferences = next;
			}
		} finally {
			pushBusy = false;
		}
	}

	async function togglePushChannel(channelId: string): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		try {
			const enabling = !pushChannelsEnabled.includes(channelId);
			if (enabling) {
				// Delivery reaches channel members, and opening a channel joins
				// it — turning push on joins too, so a switched-on channel can
				// never be a silent dead toggle. A channel you cannot join
				// fails honestly here and nothing is saved.
				try {
					await ensureChannelMembership(channelId);
				} catch {
					pushStatus = "Couldn't join that channel — push wasn't turned on.";
					return;
				}
			}
			const next = enabling
				? [...pushChannelsEnabled, channelId]
				: pushChannelsEnabled.filter((id) => id !== channelId);
			if (await setPushChannelPrefs(next)) {
				pushChannelsEnabled = next;
				pushStatus = '';
			} else {
				pushStatus = 'Could not save that channel choice — try again.';
			}
		} finally {
			pushBusy = false;
		}
	}
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.notifications')}</h3>
	<p class="notification-status-note">Activity brings friend requests, unread conversations, loaded mentions and followed channels together. Friends are managed there, separately from Messages. Each saved server keeps its own account and permissions.</p>
	<div class="settings-group-card">
	<div class="notification-status-note" role="status">
		{#if pushPermission === 'denied'}
			Browser notifications are blocked. Allow them for this site in browser settings, then retry.
		{:else if pushPermission === 'unsupported'}
			This browser does not support background notifications.
		{:else if pushPermission === 'default'}
			Notifications have not been requested yet. Turn Desktop Notifications on to allow them.
		{:else}
			Browser notifications are allowed. Sound tests still require one user interaction.
		{/if}
		{#if pushStatus}
			<div class="setting-description" style="margin-top:0.35rem;">{pushStatus}</div>
		{/if}
	</div>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Desktop Notifications</span>
			<span class="setting-description">Allow supported alerts outside Wabi. Turning this off also stops background push on this device. Activity remains available when system alerts are off.</span>
		</div>
		<button class="toggle-btn" class:active={desktopNotificationsOn()} disabled={pushBusy} on:click={toggleDesktopNotifications} role="switch" aria-checked={desktopNotificationsOn()} aria-label="Desktop notifications"></button>
	</div>

	{#if !isTauriRuntime() && isPwaStandalone}
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Background push</span>
			<span class="setting-description">
				Delivery while Wabi is closed: direct messages, the channels you switch on below, and incoming calls. Permission: {pushPermission}.
				{pushSubscribed ? 'Subscribed.' : 'Not subscribed.'}
			</span>
		</div>
		<div style="display:flex;flex-direction:column;gap:0.35rem;min-width:7.5rem;align-items:center;">
			<button class="toggle-btn" class:active={pushSubscribed} disabled={pushBusy} on:click={togglePushSubscription} role="switch" aria-checked={pushSubscribed} aria-label="Background push"></button>
			<button class="action-btn" disabled={pushBusy || !pushSubscribed} on:click={handleTestPush}>
				Test push
			</button>
		</div>
	</div>
	{:else if isTauriRuntime()}
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">System notifications</span>
			<span class="setting-description">Native alerts from the desktop app.</span>
		</div>
		<button class="toggle-btn" class:active={notificationsEnabled} disabled={pushBusy} on:click={toggleDesktopNotifications} role="switch" aria-checked={notificationsEnabled} aria-label="System notifications"></button>
	</div>
	{/if}

	{#if !isTauriRuntime() && pushSubscribed}
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Push: Direct messages</span>
			<span class="setting-description">Notify me about new direct messages. Group chats and channels use the list below.</span>
		</div>
		<button class="toggle-btn" class:active={pushPreferences.directMessages} on:click={() => togglePushPreference('directMessages')} role="switch" aria-checked={pushPreferences.directMessages} aria-label="Push direct messages"></button>
	</div>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Push: Incoming calls</span>
			<span class="setting-description">Notify me when someone calls. Calls ring regardless of the channel list below.</span>
		</div>
		<button class="toggle-btn" class:active={pushPreferences.calls} on:click={() => togglePushPreference('calls')} role="switch" aria-checked={pushPreferences.calls} aria-label="Push incoming calls"></button>
	</div>
	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Push: Channels</span>
			<span class="setting-description">Pick exactly which channels push while Wabi is closed. Each channel starts off — turn on the ones you need. Direct messages and calls use their own switches above.</span>
			{#if !pushChannelsError}
				<span class="setting-description">{pushChannelsEnabled.length} of {pushChannelRows.length} channels pushing.</span>
			{/if}
		</div>
		{#if pushChannelsError}
			<span class="setting-description">Couldn't load your choices — close and reopen settings to retry.</span>
		{:else}
			<div class="push-channel-list">
				{#each pushChannelRows as row (row.id)}
					<div class="push-channel-row">
						<span class="push-channel-kind">{row.type}</span>
						<span class="push-channel-name">{row.label}</span>
						<button class="toggle-btn" class:active={pushChannelsEnabled.includes(row.id)} disabled={pushBusy} on:click={() => togglePushChannel(row.id)} role="switch" aria-checked={pushChannelsEnabled.includes(row.id)} aria-label={`Push notifications for ${row.label}`}></button>
					</div>
				{:else}
					<span class="setting-description">No channels yet.</span>
				{/each}
			</div>
		{/if}
	</div>
	{/if}

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Suppress @everyone, @here, and @all</span>
			<span class="setting-description">Skip @everyone / @here / @all.</span>
		</div>
		<button class="toggle-btn" class:active={suppressEveryoneHereMentions} on:click={toggleSuppressEveryoneHereMentions} role="switch" aria-checked={suppressEveryoneHereMentions} aria-label="Suppress everyone mentions"></button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Suppress All Role @mentions</span>
			<span class="setting-description">Skip role @mentions.</span>
		</div>
		<button class="toggle-btn" class:active={suppressRoleMentions} on:click={toggleSuppressRoleMentions} role="switch" aria-checked={suppressRoleMentions} aria-label="Suppress role mentions"></button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Show Message Preview</span>
			<span class="setting-description">Include available message text in system alerts and Activity. Live messages are never saved as previews.</span>
		</div>
		<button class="toggle-btn" class:active={notificationPreviewEnabled} on:click={toggleNotificationPreview} role="switch" aria-checked={notificationPreviewEnabled} aria-label="Show message preview"></button>
	</div>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Background follow alerts</span>
			<span class="setting-description">Allow system toasts for followed channels on inactive servers when their alert level permits them. Followed activity still appears in Activity when off.</span>
		</div>
		<button class="toggle-btn" class:active={backgroundFollowAlertsEnabled} on:click={toggleBackgroundFollowAlerts} role="switch" aria-checked={backgroundFollowAlertsEnabled} aria-label="Background follow alerts"></button>
	</div>
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">
				<svg class="setting-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
				Notification Sound
			</span>
			<span class="setting-description">Alert sound.</span>
		</div>
		<div class="sound-options">
			<button class="sound-option" class:active={notificationSound === '/sounds/ProjectSound.ogg'} on:click={() => updateNotificationSound('/sounds/ProjectSound.ogg')}>
				ProjectSound.ogg
			</button>
			<button class="sound-option" class:active={notificationSound.startsWith('data:audio')} on:click={triggerNotificationSoundFilePicker}>
				Upload Custom Sound
			</button>
		</div>
		<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" bind:this={notificationSoundInput} on:change={handleNotificationSoundFileSelect} class="hidden" />
		<div class="runtime-note">Active sound: {notificationSoundLabel}</div>
		<div class="settings-row-actions">
			<button class="action-btn secondary" on:click={testNotificationSound}>Test Sound</button>
			<button class="action-btn secondary" on:click={resetNotificationSoundToDefault}>Reset Default</button>
		</div>
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Call Ringtone</span>
			<span class="setting-description">Incoming call loop.</span>
		</div>
		<select class="theme-select" bind:value={callRingtoneMode} on:change={(e) => updateCallRingtoneMode(e.currentTarget.value as CallRingtoneMode)}>
			{#each CALL_RINGTONE_OPTIONS as option}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
		{#if callRingtoneMode === 'custom-synth'}
			<div class="runtime-note">Custom synth presets stay tiny in storage and can be imported or exported as JSON.</div>
			<div class="settings-row-actions">
				<button class="action-btn secondary" on:click={() => (callRingtoneSynthEditorExpanded = !callRingtoneSynthEditorExpanded)}>
					{callRingtoneSynthEditorExpanded ? 'Hide Advanced' : 'Edit Synth'}
				</button>
				<button class="action-btn secondary" on:click={exportCallRingtoneCustomSynth}>Export JSON</button>
				<button class="action-btn secondary" on:click={triggerCallRingtoneSynthImportFilePicker}>Import JSON</button>
			</div>
			<div class="runtime-note">Preset: {getCallRingtoneCustomSynthSummary()}</div>
			{#if callRingtoneSynthEditorExpanded}
				<div class="synth-editor-grid">
					<div class="quality-mode-row">
						<label for="call-ringtone-synth-name">Preset Name</label>
						<input id="call-ringtone-synth-name" class="theme-select" maxlength="48" value={callRingtoneCustomSynth.name} on:input={(e) => updateCallRingtoneCustomSynthField('name', e.currentTarget.value)} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-synth-waveform">Waveform</label>
						<select id="call-ringtone-synth-waveform" class="theme-select" value={callRingtoneCustomSynth.waveform} on:change={(e) => updateCallRingtoneCustomSynthField('waveform', e.currentTarget.value as CustomSynthWaveform)}>
							{#each CUSTOM_SYNTH_WAVEFORM_OPTIONS as option}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-primary-tone">Primary Tone (Hz)</label>
						<input id="call-ringtone-primary-tone" type="number" min="120" max="2200" step="5" class="theme-select" value={callRingtoneCustomSynth.primaryToneHz} on:input={(e) => updateCallRingtoneCustomSynthField('primaryToneHz', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-secondary-tone">Secondary Tone (Hz)</label>
						<input id="call-ringtone-secondary-tone" type="number" min="0" max="2600" step="5" class="theme-select" value={callRingtoneCustomSynth.secondaryToneHz} on:input={(e) => updateCallRingtoneCustomSynthField('secondaryToneHz', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-burst-count">Burst Count</label>
						<input id="call-ringtone-burst-count" type="number" min="1" max="6" step="1" class="theme-select" value={callRingtoneCustomSynth.burstCount} on:input={(e) => updateCallRingtoneCustomSynthField('burstCount', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-burst-duration">Burst Duration (ms)</label>
						<input id="call-ringtone-burst-duration" type="number" min="60" max="2500" step="10" class="theme-select" value={callRingtoneCustomSynth.burstDurationMs} on:input={(e) => updateCallRingtoneCustomSynthField('burstDurationMs', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-burst-spacing">Burst Gap (ms)</label>
						<input id="call-ringtone-burst-spacing" type="number" min="80" max="4000" step="10" class="theme-select" value={callRingtoneCustomSynth.burstSpacingMs} on:input={(e) => updateCallRingtoneCustomSynthField('burstSpacingMs', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-cycle">Loop Length (ms)</label>
						<input id="call-ringtone-cycle" type="number" min="300" max="8000" step="10" class="theme-select" value={callRingtoneCustomSynth.cycleMs} on:input={(e) => updateCallRingtoneCustomSynthField('cycleMs', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-level">Synth Level</label>
						<input id="call-ringtone-level" type="range" min="0.02" max="0.25" step="0.01" value={callRingtoneCustomSynth.level} on:input={(e) => updateCallRingtoneCustomSynthField('level', Number(e.currentTarget.value))} class="volume-slider" />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-fadeout">Fade Out (ms)</label>
						<input id="call-ringtone-fadeout" type="number" min="10" max="800" step="5" class="theme-select" value={callRingtoneCustomSynth.fadeOutMs} on:input={(e) => updateCallRingtoneCustomSynthField('fadeOutMs', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-harmonic-multiplier">Harmonic Multiplier</label>
						<input id="call-ringtone-harmonic-multiplier" type="number" min="1" max="8" step="0.1" class="theme-select" value={callRingtoneCustomSynth.harmonicMultiplier} on:input={(e) => updateCallRingtoneCustomSynthField('harmonicMultiplier', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-harmonic-gain">Harmonic Gain</label>
						<input id="call-ringtone-harmonic-gain" type="range" min="0" max="0.4" step="0.01" value={callRingtoneCustomSynth.harmonicGain} on:input={(e) => updateCallRingtoneCustomSynthField('harmonicGain', Number(e.currentTarget.value))} class="volume-slider" />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-tremolo-hz">Tremolo Speed (Hz)</label>
						<input id="call-ringtone-tremolo-hz" type="number" min="0" max="30" step="0.5" class="theme-select" value={callRingtoneCustomSynth.tremoloHz} on:input={(e) => updateCallRingtoneCustomSynthField('tremoloHz', Number(e.currentTarget.value))} />
					</div>
					<div class="quality-mode-row">
						<label for="call-ringtone-tremolo-depth">Tremolo Depth</label>
						<input id="call-ringtone-tremolo-depth" type="range" min="0" max="0.95" step="0.01" value={callRingtoneCustomSynth.tremoloDepth} on:input={(e) => updateCallRingtoneCustomSynthField('tremoloDepth', Number(e.currentTarget.value))} class="volume-slider" />
					</div>
				</div>
				<div class="settings-row-actions">
					<button class="action-btn secondary" on:click={resetCallRingtoneCustomSynth}>Reset Synth</button>
				</div>
			{/if}
			<input type="file" accept="application/json,.json" bind:this={callRingtoneSynthImportInput} on:change={handleCallRingtoneSynthImportFileSelect} class="hidden" />
		{:else if callRingtoneMode === 'custom-audio'}
			<div class="sound-options">
				<button class="action-btn secondary" on:click={triggerCallRingtoneFilePicker}>
					{callRingtoneLabel === 'Custom audio' ? 'Upload Custom Audio' : 'Replace Custom Audio'}
				</button>
				<button class="action-btn secondary" on:click={resetCallRingtoneToDefault}>Back To Preset</button>
			</div>
			<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" bind:this={callRingtoneInput} on:change={handleCallRingtoneFileSelect} class="hidden" />
		{/if}
		<div class="runtime-note">Active ringtone: {callRingtoneLabel}</div>
		<div class="settings-row-actions">
			<button class="action-btn secondary" on:click={testCallRingtone}>Test Ringtone</button>
			{#if callRingtoneMode !== 'custom-audio'}
				<button class="action-btn secondary" on:click={resetCallRingtoneToDefault}>Reset Default</button>
			{/if}
		</div>
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Notification Volume</span>
			<span class="setting-description">Adjust the volume of notification sounds ({Math.round(notificationVolume * 100)}%)</span>
		</div>
		<input type="range" min="0" max="1" step="0.05" bind:value={notificationVolume} on:input={(e) => updateNotificationVolume(parseFloat(e.currentTarget.value))} class="volume-slider" />
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Call Ringtone Volume</span>
			<span class="setting-description">Adjust the volume of the incoming call ringtone ({Math.round(callRingtoneVolume * 100)}%)</span>
		</div>
		<input type="range" min="0" max="1" step="0.05" bind:value={callRingtoneVolume} on:input={(e) => updateCallRingtoneVolume(parseFloat(e.currentTarget.value))} class="volume-slider" />
	</div>
</div>

<style>
	.push-channel-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-height: 18rem;
		overflow-y: auto;
		padding: 0.2rem;
	}
	.push-channel-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.5rem 0.75rem;
		background: color-mix(in srgb, var(--surface-sunken) 55%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary-color) 10%, transparent);
		border-radius: var(--radius-md);
	}
	.push-channel-row:hover {
		border-color: color-mix(in srgb, var(--accent-primary-color) 24%, transparent);
	}
	.push-channel-kind {
		font-size: var(--font-size-xs);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		min-width: 4.5rem;
		white-space: nowrap;
	}
	.push-channel-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--font-size-sm);
		color: var(--text-heading);
	}
</style>
