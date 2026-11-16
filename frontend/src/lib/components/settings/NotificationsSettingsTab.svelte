<script lang="ts">
	import { _ } from '$lib/i18n';
	import { pushFailureMessage } from '$lib/pwa/pushDiagnostics';
	import { onDestroy, onMount } from 'svelte';
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
	import Switch from '../ui/Switch.svelte';
	import Select from '../ui/Select.svelte';
	import Icon from '../ui/Icon.svelte';
	import { brandName } from '$lib/branding';

	/** "Classic Bell" → "Classic bell": option words in sentence case (§9.6). */
	const sentence = (label: string) => label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
	const RINGTONE_SELECT_OPTIONS = CALL_RINGTONE_OPTIONS.map((option) => ({ value: option.value, label: sentence(option.label) }));
	const WAVEFORM_SELECT_OPTIONS = CUSTOM_SYNTH_WAVEFORM_OPTIONS.map((option) => ({ value: option.value, label: sentence(option.label) }));
	const DEFAULT_SOUND = '/sounds/ProjectSound.ogg';

	/** Feedback under the sound and ringtone rows, where the action happened. */
	let soundNote = { text: '', error: false };
	let ringtoneNote = { text: '', error: false };
	let channelsOpen = false;
	const synthNumberFields: Array<{ key: keyof CustomSynthRingtonePreset; label: string; min: number; max: number; step: number }> = [
		{ key: 'primaryToneHz', label: $_('notif.synth_main_tone'), min: 120, max: 2200, step: 5 },
		{ key: 'secondaryToneHz', label: $_('notif.synth_second_tone'), min: 0, max: 2600, step: 5 },
		{ key: 'burstCount', label: $_('notif.synth_rings'), min: 1, max: 6, step: 1 },
		{ key: 'burstDurationMs', label: $_('notif.synth_ring_length'), min: 60, max: 2500, step: 10 },
		{ key: 'burstSpacingMs', label: $_('notif.synth_gap'), min: 80, max: 4000, step: 10 },
		{ key: 'cycleMs', label: $_('notif.synth_loop_length'), min: 300, max: 8000, step: 10 },
		{ key: 'fadeOutMs', label: $_('notif.synth_fade_out'), min: 10, max: 800, step: 5 },
		{ key: 'harmonicMultiplier', label: $_('notif.synth_harmonic_mult'), min: 1, max: 8, step: 0.1 },
		{ key: 'tremoloHz', label: $_('notif.synth_tremolo_speed'), min: 0, max: 30, step: 0.5 }
	];
	const synthRangeFields: Array<{ key: keyof CustomSynthRingtonePreset; label: string; min: number; max: number; step: number }> = [
		{ key: 'level', label: $_('notif.synth_loudness'), min: 0.02, max: 0.25, step: 0.01 },
		{ key: 'harmonicGain', label: $_('notif.synth_harmonic_level'), min: 0, max: 0.4, step: 0.01 },
		{ key: 'tremoloDepth', label: $_('notif.synth_tremolo_depth'), min: 0, max: 0.95, step: 0.01 }
	];
	const rangeFill = (value: number, min: number, max: number) => `--w-range-fill: ${Math.round(((value - min) / (max - min)) * 100)}%`;

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
				: localStorage.getItem('notificationSoundLabel') || $_('notif.custom_sound');
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
		return sentence(CALL_RINGTONE_OPTIONS.find((option) => option.value === mode)?.label || $_('notif.classic_bell'));
	}

	function getResolvedCallRingtoneLabel(mode: CallRingtoneMode): string {
		if (mode === 'custom-audio') {
			return localStorage.getItem('callRingtoneLabel') || $_('notif.custom_audio');
		}
		if (mode === 'custom-synth') {
			return callRingtoneCustomSynth.name?.trim() || $_('notif.custom_synth');
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
				? ` + ${Math.round(callRingtoneCustomSynth.secondaryToneHz)} Hz`
				: '';
		return `${callRingtoneCustomSynth.name} · ${callRingtoneCustomSynth.waveform} · ${Math.round(callRingtoneCustomSynth.primaryToneHz)} Hz${secondaryTone}`;
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
				: localStorage.getItem('notificationSoundLabel') || $_('notif.custom_sound');
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
		} catch (error) {
			console.warn('[Settings] notification sound test failed:', error);
			soundNote = { text: $_('notif.sound_cant_play'), error: true };
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
		callRingtoneLabel = $_('notif.classic_bell');
		ringtoneNote = { text: '', error: false };
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
		soundNote = { text: '', error: false };
		if (!isAudioFile) {
			soundNote = { text: $_('notif.audio_type'), error: true };
			input.value = '';
			return;
		}
		if (file.size > 1024 * 1024) {
			soundNote = { text: $_('notif.sound_too_big'), error: true };
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
			console.warn('[Settings] custom notification sound failed:', error);
			soundNote = { text: $_('notif.sound_unreadable'), error: true };
		} finally {
			input.value = '';
		}
	}

	async function handleCallRingtoneSynthImportFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isJsonFile = file.type === 'application/json' || /\.json$/i.test(file.name);
		ringtoneNote = { text: '', error: false };
		if (!isJsonFile) {
			ringtoneNote = { text: $_('notif.preset_type'), error: true };
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
			console.warn('[Settings] synth preset import failed:', error);
			ringtoneNote = { text: $_('notif.preset_invalid'), error: true };
		} finally {
			input.value = '';
		}
	}

	async function handleCallRingtoneFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isAudioFile = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name);
		ringtoneNote = { text: '', error: false };
		if (!isAudioFile) {
			ringtoneNote = { text: $_('notif.audio_type'), error: true };
			input.value = '';
			return;
		}
		if (file.size > 1024 * 1024) {
			ringtoneNote = { text: $_('notif.ringtone_too_big'), error: true };
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
			console.warn('[Settings] custom ringtone failed:', error);
			ringtoneNote = { text: $_('notif.ringtone_unreadable'), error: true };
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
				pushStatus = $_('notif.off_device');
				return;
			}
			if (!isTauriRuntime() && !('Notification' in window)) {
				pushStatus = $_('notif.no_browser_support');
				return;
			}
			// Click = user gesture, so the one-time permission prompt is allowed.
			const permission = await requestNotificationPermission();
			if (permission !== 'granted') {
				// Leave the stored intent untouched: a blocked prompt must not
				// silently rewrite an earlier choice.
				pushStatus =
					permission === 'denied'
						? $_('notif.blocked')
						: $_('notif.not_allowed');
				return;
			}
			notificationsEnabled = true;
			localStorage.setItem('notificationsEnabled', 'true');
			if (isTauriRuntime()) {
				await refreshPushState();
				pushStatus = $_('notif.on_device');
				return;
			}
			setPushOptOut(false);
			const sub = await subscribeWebPush();
			await refreshPushState();
			pushStatus = sub.ok
				? $_('notif.on_device')
				: $_('notif.on_while_open', { values: { brand: brandName, reason: pushFailureMessage('reason' in sub ? sub.reason : 'failed') } });
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
				pushStatus = $_('notif.closed_nothing', { values: { brand: brandName } });
			} else {
				setPushOptOut(false);
				const result = await subscribeWebPush();
				await refreshPushState();
				pushStatus = result.ok
					? $_('notif.closed_alerts', { values: { brand: brandName } })
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
			if (!result.ok) console.warn('[Settings] test push failed:', result.reason);
			pushStatus = result.ok ? $_('notif.test_sent') : $_('notif.test_failed');
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
					pushStatus = $_('notif.join_failed');
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
				pushStatus = $_('notif.channel_not_saved');
			}
		} finally {
			pushBusy = false;
		}
	}
</script>

<!--
	Settings › Notifications (§8.9): what reaches you outside the open app, which mentions count,
	and the sounds. Switch rows on the kit; every state is said in words under its row.
-->
<section class="settings-block" aria-labelledby="notif-alerts-title">
	<h3 class="settings-block__title" id="notif-alerts-title">{$_('notif.alerts_title')}</h3>
	<p class="settings-block__hint">{$_('notif.alerts_hint')}</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-desktop-label">{isTauriRuntime() ? $_('notif.desktop_system') : $_('notif.desktop_label')}</p>
				<p class="w-srow__hint" id="notif-desktop-hint">
					{#if isTauriRuntime()}
						{$_('notif.desktop_app_hint', { values: { brand: brandName } })}
					{:else if pushPermission === 'denied'}
						{$_('notif.browser_blocked', { values: { brand: brandName } })}
					{:else if pushPermission === 'unsupported'}
						{$_('notif.browser_unsupported')}
					{:else}
						{$_('notif.outside_hint', { values: { brand: brandName } })}
					{/if}
				</p>
			</div>
			<div class="w-srow__control">
				<button type="button" class="w-switch" role="switch" aria-labelledby="notif-desktop-label" aria-describedby="notif-desktop-hint" aria-checked={desktopNotificationsOn()} disabled={pushBusy || (!isTauriRuntime() && pushPermission === 'unsupported')} on:click={toggleDesktopNotifications}></button>
			</div>
		</div>

		{#if !isTauriRuntime() && isPwaStandalone}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="notif-background-label">{$_('notif.background_label', { values: { brand: brandName } })}</p>
					<p class="w-srow__hint">{$_('notif.background_hint')}</p>
				</div>
				<div class="w-srow__control">
					<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={pushBusy || !pushSubscribed} on:click={handleTestPush}>{$_('notif.send_test')}</button>
					<button type="button" class="w-switch" role="switch" aria-labelledby="notif-background-label" aria-checked={pushSubscribed} disabled={pushBusy} on:click={togglePushSubscription}></button>
				</div>
			</div>
		{/if}

		{#if !isTauriRuntime() && pushSubscribed}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="notif-push-dm-label">{$_('notif.dm_label')}</p>
					<p class="w-srow__hint">{$_('notif.dm_hint')}</p>
				</div>
				<div class="w-srow__control">
					<button type="button" class="w-switch" role="switch" aria-labelledby="notif-push-dm-label" aria-checked={pushPreferences.directMessages} disabled={pushBusy} on:click={() => togglePushPreference('directMessages')}></button>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="notif-push-calls-label">{$_('notif.calls_label')}</p>
					<p class="w-srow__hint">{$_('notif.calls_hint')}</p>
				</div>
				<div class="w-srow__control">
					<button type="button" class="w-switch" role="switch" aria-labelledby="notif-push-calls-label" aria-checked={pushPreferences.calls} disabled={pushBusy} on:click={() => togglePushPreference('calls')}></button>
				</div>
			</div>
		{/if}
	</div>

	{#if !isTauriRuntime() && pushSubscribed}
		<button type="button" class="w-disclosure" aria-expanded={channelsOpen} aria-controls="notif-push-channels" on:click={() => (channelsOpen = !channelsOpen)}>
			<Icon name="chevRight" />{$_('notif.channels_alert')}
			{#if !pushChannelsError}<span class="w-count notif-count">{$_('notif.channels_count', { values: { on: pushChannelsEnabled.length, total: pushChannelRows.length } })}</span>{/if}
		</button>
		{#if channelsOpen}
			<div class="w-disclosure__body" id="notif-push-channels">
				{#if pushChannelsError}
					<p class="notif-note is-error" role="alert"><Icon name="alert" size={14} />{$_('notif.channels_error')}</p>
				{:else}
					<p class="notif-note">{$_('notif.channels_intro')}</p>
					<ul class="notif-channels" aria-label={$_('notif.channels_alert')}>
						{#each pushChannelRows as row (row.id)}
							<li class="notif-channel">
								<Icon name={row.type === 'voice' ? 'voice' : row.type === 'forum' ? 'forum' : row.type === 'wiki' ? 'book' : 'hash'} size={16} />
								<span class="notif-channel__name" id={`notif-push-${row.id}`}>{row.label}</span>
								<button type="button" class="w-switch" role="switch" aria-labelledby={`notif-push-${row.id}`} aria-checked={pushChannelsEnabled.includes(row.id)} disabled={pushBusy} on:click={() => togglePushChannel(row.id)}></button>
							</li>
						{:else}
							<li class="notif-note">{$_('notif.no_channels')}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/if}
	{#if pushStatus}<p class="notif-note notif-status" role="status">{pushStatus}</p>{/if}
</section>

<section class="settings-block" aria-labelledby="notif-mentions-title">
	<h3 class="settings-block__title" id="notif-mentions-title">{$_('notif.mentions_title')}</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-everyone-label">{$_('notif.mute_everyone')}</p>
				<p class="w-srow__hint">{$_('notif.mute_everyone_hint')}</p>
			</div>
			<div class="w-srow__control"><Switch labelledby="notif-everyone-label" checked={suppressEveryoneHereMentions} onchange={toggleSuppressEveryoneHereMentions} /></div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-roles-label">{$_('notif.mute_roles')}</p>
				<p class="w-srow__hint">{$_('notif.mute_roles_hint')}</p>
			</div>
			<div class="w-srow__control"><Switch labelledby="notif-roles-label" checked={suppressRoleMentions} onchange={toggleSuppressRoleMentions} /></div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-preview-label">{$_('notif.preview_label')}</p>
				<p class="w-srow__hint">{$_('notif.preview_hint')}</p>
			</div>
			<div class="w-srow__control"><Switch labelledby="notif-preview-label" checked={notificationPreviewEnabled} onchange={toggleNotificationPreview} /></div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-follow-label">{$_('notif.follow_label')}</p>
				<p class="w-srow__hint">{$_('notif.follow_hint')}</p>
			</div>
			<div class="w-srow__control"><Switch labelledby="notif-follow-label" checked={backgroundFollowAlertsEnabled} onchange={toggleBackgroundFollowAlerts} /></div>
		</div>
	</div>
</section>

<section class="settings-block" aria-labelledby="notif-sounds-title">
	<h3 class="settings-block__title" id="notif-sounds-title">{$_('notif.sounds_title')}</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-sound-label">{$_('notif.sound_label')}</p>
				<p class="w-srow__hint">{notificationSound === DEFAULT_SOUND ? $_('notif.builtin_chime') : $_('notif.your_file', { values: { name: notificationSoundLabel } })} {$_('notif.sounds_after_click', { values: { brand: brandName } })}</p>
			</div>
			<div class="w-srow__control">
				<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={testNotificationSound}>{$_('notif.play')}</button>
				{#if notificationSound !== DEFAULT_SOUND}
					<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={resetNotificationSoundToDefault}>{$_('notif.use_chime')}</button>
				{/if}
				<button type="button" class="w-btn w-btn--sm" on:click={triggerNotificationSoundFilePicker}>{$_('notif.choose_file')}</button>
			</div>
		</div>
		{#if soundNote.text}<p class="notif-note" class:is-error={soundNote.error} role={soundNote.error ? 'alert' : 'status'}>{#if soundNote.error}<Icon name="alert" size={14} />{/if}{soundNote.text}</p>{/if}
		<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" bind:this={notificationSoundInput} on:change={handleNotificationSoundFileSelect} class="hidden-file-input" tabindex="-1" aria-hidden="true" />

		<div class="w-srow">
			<div class="w-srow__text">
				<label class="w-srow__label" for="notif-volume">{$_('notif.volume')}</label>
				<p class="w-srow__hint">{Math.round(notificationVolume * 100)}%</p>
			</div>
			<div class="w-srow__control">
				<input id="notif-volume" type="range" class="w-range notif-range" min="0" max="1" step="0.05" value={notificationVolume} style={rangeFill(notificationVolume, 0, 1)} aria-valuetext={`${Math.round(notificationVolume * 100)}%`} on:input={(e) => updateNotificationVolume(parseFloat(e.currentTarget.value))} />
			</div>
		</div>

		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="notif-ringtone-label">{$_('notif.ringtone_label')}</p>
				<p class="w-srow__hint">{$_('notif.ringtone_hint')}{#if callRingtoneMode === 'custom-audio'} {$_('notif.your_file', { values: { name: callRingtoneLabel } })}{/if}</p>
			</div>
			<div class="w-srow__control">
				<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={testCallRingtone}>{$_('notif.play')}</button>
				{#if callRingtoneMode === 'custom-audio'}
					<button type="button" class="w-btn w-btn--sm" on:click={triggerCallRingtoneFilePicker}>{callRingtoneLabel === 'Custom audio' ? $_('notif.choose_file') : $_('notif.replace_file')}</button>
				{/if}
				<Select ariaLabel={$_('notif.ringtone_label')} options={RINGTONE_SELECT_OPTIONS} value={callRingtoneMode} align="end" onchange={(value) => updateCallRingtoneMode(value as CallRingtoneMode)} />
			</div>
		</div>
		<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" bind:this={callRingtoneInput} on:change={handleCallRingtoneFileSelect} class="hidden-file-input" tabindex="-1" aria-hidden="true" />

		{#if callRingtoneMode === 'custom-synth'}
			<div class="notif-synth">
				<button type="button" class="w-disclosure" aria-expanded={callRingtoneSynthEditorExpanded} aria-controls="notif-synth-editor" on:click={() => (callRingtoneSynthEditorExpanded = !callRingtoneSynthEditorExpanded)}>
					<Icon name="chevRight" />{$_('notif.shape_ringtone')}
					<span class="w-count notif-count">{getCallRingtoneCustomSynthSummary()}</span>
				</button>
				{#if callRingtoneSynthEditorExpanded}
					<div class="w-disclosure__body notif-synth__body" id="notif-synth-editor">
						<div class="notif-synth__grid">
							<div class="notif-synth__field">
								<label class="w-label" for="notif-synth-name">{$_('notif.name_label')}</label>
								<input id="notif-synth-name" class="w-field" maxlength="48" value={callRingtoneCustomSynth.name} on:input={(e) => updateCallRingtoneCustomSynthField('name', e.currentTarget.value)} />
							</div>
							<div class="notif-synth__field">
								<span class="w-label" id="notif-synth-wave">{$_('notif.waveform')}</span>
								<Select ariaLabel={$_('notif.waveform')} options={WAVEFORM_SELECT_OPTIONS} value={callRingtoneCustomSynth.waveform} onchange={(value) => updateCallRingtoneCustomSynthField('waveform', value as CustomSynthWaveform)} />
							</div>
							{#each synthNumberFields as field (field.key)}
								<div class="notif-synth__field">
									<label class="w-label" for={`notif-synth-${field.key}`}>{field.label}</label>
									<input id={`notif-synth-${field.key}`} class="w-field" type="number" min={field.min} max={field.max} step={field.step} value={callRingtoneCustomSynth[field.key]} on:input={(e) => updateCallRingtoneCustomSynthField(field.key, Number(e.currentTarget.value))} />
								</div>
							{/each}
							{#each synthRangeFields as field (field.key)}
								{@const value = Number(callRingtoneCustomSynth[field.key])}
								<div class="notif-synth__field">
									<label class="w-label" for={`notif-synth-${field.key}`}>{field.label}</label>
									<input id={`notif-synth-${field.key}`} class="w-range" type="range" min={field.min} max={field.max} step={field.step} {value} style={rangeFill(value, field.min, field.max)} on:input={(e) => updateCallRingtoneCustomSynthField(field.key, Number(e.currentTarget.value))} />
								</div>
							{/each}
						</div>
						<div class="notif-synth__actions">
							<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={resetCallRingtoneCustomSynth}>{$_('notif.reset_shape')}</button>
							<button type="button" class="w-btn w-btn--sm" on:click={triggerCallRingtoneSynthImportFilePicker}>{$_('notif.import_preset')}</button>
							<button type="button" class="w-btn w-btn--sm" on:click={exportCallRingtoneCustomSynth}>{$_('notif.export_preset')}</button>
						</div>
					</div>
				{/if}
				<input type="file" accept="application/json,.json" bind:this={callRingtoneSynthImportInput} on:change={handleCallRingtoneSynthImportFileSelect} class="hidden-file-input" tabindex="-1" aria-hidden="true" />
			</div>
		{/if}
		{#if ringtoneNote.text}<p class="notif-note" class:is-error={ringtoneNote.error} role={ringtoneNote.error ? 'alert' : 'status'}>{#if ringtoneNote.error}<Icon name="alert" size={14} />{/if}{ringtoneNote.text}</p>{/if}

		<div class="w-srow">
			<div class="w-srow__text">
				<label class="w-srow__label" for="notif-ring-volume">{$_('notif.ringtone_volume')}</label>
				<p class="w-srow__hint">{Math.round(callRingtoneVolume * 100)}%</p>
			</div>
			<div class="w-srow__control">
				<input id="notif-ring-volume" type="range" class="w-range notif-range" min="0" max="1" step="0.05" value={callRingtoneVolume} style={rangeFill(callRingtoneVolume, 0, 1)} aria-valuetext={`${Math.round(callRingtoneVolume * 100)}%`} on:input={(e) => updateCallRingtoneVolume(parseFloat(e.currentTarget.value))} />
			</div>
		</div>
	</div>
</section>

<style>
	.notif-count {
		margin-left: auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.notif-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.notif-note.is-error {
		color: var(--w-danger);
	}
	.notif-note :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.w-srows > .notif-note {
		margin: 0;
		padding: 8px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.notif-range {
		width: 180px;
	}
	.notif-channels {
		display: grid;
		max-height: 18rem;
		margin: 8px 0 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}
	.notif-channel {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 0 4px 0 2px;
		border-bottom: var(--w-bw) solid var(--w-line);
		color: var(--w-faint);
	}
	.notif-channel__name {
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-ui);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.notif-synth {
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.notif-synth__body {
		display: grid;
		gap: 16px;
		padding: 12px 0 16px;
	}
	.notif-synth__grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 12px 16px;
	}
	.notif-synth__field {
		display: grid;
		align-content: start;
		min-width: 0;
	}
	.notif-synth__field > .w-field {
		width: 100%;
		box-sizing: border-box;
	}
	.notif-synth__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}
	@media (max-width: 600px) {
		.notif-range {
			width: 140px;
		}
	}
</style>
