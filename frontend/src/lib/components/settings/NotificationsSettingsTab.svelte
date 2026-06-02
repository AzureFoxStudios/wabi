<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import {
		getDefaultCustomSynthRingtonePreset,
		playCallRingtone,
		playNotificationSound,
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

	let notificationsEnabled = true;
	let suppressEveryoneHereMentions = false;
	let suppressRoleMentions = false;
	let notificationPreviewEnabled = false;
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

	onMount(() => {
		notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		suppressEveryoneHereMentions = localStorage.getItem('suppressEveryoneHereMentions') === 'true';
		suppressRoleMentions = localStorage.getItem('suppressRoleMentions') === 'true';
		notificationPreviewEnabled = localStorage.getItem('notificationPreviewEnabled') === 'true';
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
	});

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
		playNotificationSound();
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
				body: "Notifications enabled! You'll be notified of new messages.",
				icon: '/icon-192.png'
			});
		} else {
			notificationsEnabled = false;
			localStorage.setItem('notificationsEnabled', 'false');
		}
	}
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.notifications')}</h3>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Desktop Notifications</span>
			<span class="setting-description">Get notified when you receive new messages</span>
		</div>
		<button class="action-btn" class:active={notificationsEnabled} on:click={requestNotificationPermission}>
			{notificationsEnabled ? 'Enabled' : 'Enable'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Suppress @everyone, @here, and @all</span>
			<span class="setting-description">Do not notify when broad mentions are used</span>
		</div>
		<button class="toggle-btn" class:active={suppressEveryoneHereMentions} on:click={toggleSuppressEveryoneHereMentions}>
			{suppressEveryoneHereMentions ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Suppress All Role @mentions</span>
			<span class="setting-description">Do not notify when role mentions are used</span>
		</div>
		<button class="toggle-btn" class:active={suppressRoleMentions} on:click={toggleSuppressRoleMentions}>
			{suppressRoleMentions ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Show Message Preview</span>
			<span class="setting-description">If off, desktop notifications use a generic "New message" body.</span>
		</div>
		<button class="toggle-btn" class:active={notificationPreviewEnabled} on:click={toggleNotificationPreview}>
			{notificationPreviewEnabled ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">
				<svg class="setting-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
				Notification Sound
			</span>
			<span class="setting-description">Choose which sound to play for notifications</span>
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
			<button class="test-sound-btn" on:click={testNotificationSound}>Test Sound</button>
			<button class="action-btn secondary" on:click={resetNotificationSoundToDefault}>Reset Default</button>
		</div>
	</div>

	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Call Ringtone</span>
			<span class="setting-description">Choose what repeats while an incoming call is ringing.</span>
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
				<button class="sound-option" on:click={exportCallRingtoneCustomSynth}>Export JSON</button>
				<button class="sound-option" on:click={triggerCallRingtoneSynthImportFilePicker}>Import JSON</button>
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
					<button class="sound-option" on:click={resetCallRingtoneCustomSynth}>Reset Synth</button>
				</div>
			{/if}
			<input type="file" accept="application/json,.json" bind:this={callRingtoneSynthImportInput} on:change={handleCallRingtoneSynthImportFileSelect} class="hidden" />
		{:else if callRingtoneMode === 'custom-audio'}
			<div class="sound-options">
				<button class="sound-option" on:click={triggerCallRingtoneFilePicker}>
					{callRingtoneLabel === 'Custom audio' ? 'Upload Custom Audio' : 'Replace Custom Audio'}
				</button>
				<button class="sound-option" on:click={resetCallRingtoneToDefault}>Back To Preset</button>
			</div>
			<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" bind:this={callRingtoneInput} on:change={handleCallRingtoneFileSelect} class="hidden" />
		{/if}
		<div class="runtime-note">Active ringtone: {callRingtoneLabel}</div>
		<div class="settings-row-actions">
			<button class="test-sound-btn" on:click={testCallRingtone}>Test Ringtone</button>
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
