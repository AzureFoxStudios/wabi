<script lang="ts">
	import { _ } from '$lib/i18n';
	/**
	 * Settings › Audio & video (§8.9): devices first, then disclosures for spatial audio, sharing
	 * quality and recording, and a Troubleshooting disclosure that holds the one per-device
	 * "Show connection details during calls" switch (off by default) and the connection facts.
	 */
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { brandName } from '$lib/branding';
	import { callConnectionDetailsOpen } from '$lib/callSurfaces';
	import Icon from '../ui/Icon.svelte';
	import Select from '../ui/Select.svelte';
	import Switch from '../ui/Switch.svelte';
	import ConnectionDiagnostics from './ConnectionDiagnostics.svelte';
	import { readConnectionDetailsPreference, shouldMirrorConnectionDetails, writeConnectionDetailsPreference } from './connectionDetailsSetting';
	import { callSessions } from '$lib/callSessionManager';
	import { isInCall, audioProcessingRuntimeStatus, clearAudioPerformanceFallbackOverride, applyCurrentAudioProcessingToLocalTrack, refreshLocalAudioMuteState, refreshSpatialAudioRuntime, spatialAudioRuntimeStatus } from '$lib/calling';
	import { refreshCallRecordingMix } from '$lib/callRecording';
	import { DESKTOP_HELPER_PROFILE_KEY, desktopHelperState, syncDesktopHelperService, type DesktopHelperProfileMode } from '$lib/desktopHelper';
	import { getTauriPlatform } from '$lib/tauri-platform';
	import { AudioCaptureOwner } from '$lib/audioCaptureOwner';
	import { createAudioCaptureSession, disposeAudioCaptureSession } from '$lib/audioCapture';
	import { isTauriRuntime, loadEffectiveMediaSettingsSnapshot, setAudioProcessingMode, setCallMuteBehavior, setCallRecordingStemMode, setCallTransportMode, setMediaQualityMode, setScreenShareQualityPreset, setScreenShareBitrateKbps, setSpatialAudioDistanceScale, setSpatialAudioEnabled, setSpatialAudioMasterStrength, setSpatialAudioMode, setSpatialAudioQuickToggleVisible, setSpatialAudioWarningMuted, setSrtGatewayEnabled, getPreferredMicDeviceId, setPreferredMicDeviceId, getPreferredCameraDeviceId, setPreferredCameraDeviceId, type AudioProcessingMode, type CallMuteBehavior, type CallRecordingStemMode, type CallTransportMode, type MediaQualityMode, type ServerMediaRuntimeResponse, type ScreenShareQualityPreset, type SpatialAudioMode } from '$lib/mediaRuntime';

	let audioInputDevices = $state<MediaDeviceInfo[]>([]);
	let videoInputDevices = $state<MediaDeviceInfo[]>([]);
	let selectedMicDeviceId = $state('');
	let selectedCameraDeviceId = $state('');
	let mediaQualityMode = $state<MediaQualityMode>('web-baseline');
	let audioProcessingMode = $state<AudioProcessingMode>('auto');
	let spatialAudioEnabled = $state(false);
	let spatialAudioMode = $state<SpatialAudioMode>('auto');
	let spatialAudioStrength = $state(0.85);
	let spatialAudioDistanceScale = $state(1);
	let spatialAudioWarningsMuted = $state(false);
	let spatialAudioQuickToggleVisible = $state(true);
	let screenShareQualityPreset = $state<ScreenShareQualityPreset>('auto');
	let screenShareBitrateKbps = $state(0);
	let callTransportMode = $state<CallTransportMode>('auto');
	let callMuteBehavior = $state<CallMuteBehavior>('mute-local-input');
	let callRecordingStemMode = $state<CallRecordingStemMode>('mixed-only');
	let srtGatewayEnabled = $state(false);
	let localAppRuntime = $state(false);
	let desktopLocalAppRuntime = $state(false);
	let mediaRuntimeSnapshot = $state<ServerMediaRuntimeResponse | null>(null);
	let micTestStream = $state<MediaStream | null>(null);
	let micTestRecorder = $state<MediaRecorder | null>(null);
	let micTestAudioContext = $state<AudioContext | null>(null);
	let micTestAnalyser = $state<AnalyserNode | null>(null);
	let micTestLevelInterval = $state<number | null>(null);
	let micTestAudioUrl = $state<string | null>(null);
	let micTestLevel = $state(0);
	let micTestState = $state<'idle' | 'recording' | 'ready'>('idle');
	// A test owns its capture independently of an active call, but uses the
	// same selected device/DSP factory and cancellation rules.
	const micTestCapture = new AudioCaptureOwner(createAudioCaptureSession, disposeAudioCaptureSession);
	let micTestGeneration = $state(0);
	let micTestStopTimer = $state<ReturnType<typeof setTimeout> | null>(null);
	let desktopHelperProfileName = $state('');
	let desktopHelperProfileMode = $state<DesktopHelperProfileMode>('off');
	let desktopHelperProfileStatus = $state('');
	let micTestError = $state('');
	let connectionDetailsDuringCalls = $state(readConnectionDetailsPreference());
	let open = $state<Record<'spatial' | 'sharing' | 'recording' | 'troubleshooting', boolean>>({
		spatial: false,
		sharing: false,
		recording: false,
		troubleshooting: false
	});

	function setConnectionDetailsDuringCalls(on: boolean): void {
		connectionDetailsDuringCalls = on;
		writeConnectionDetailsPreference(on);
		// Settings never moves a live call: opening the details uncovers the Calls page, which docks a
		// full-window call and changes center stage. Outside a call, the next call follows the switch.
		if (shouldMirrorConnectionDetails(get(isInCall), get(callSessions).size)) callConnectionDetailsOpen.set(on);
	}

	const micOptions = $derived([
		{ value: '', label: $_('audio_settings.system_default') },
		...audioInputDevices.map((device, index) => ({ value: device.deviceId, label: device.label || $_('audio_settings.microphone_n', { values: { n: index + 1 } }) }))
	]);
	const cameraOptions = $derived([
		{ value: '', label: $_('audio_settings.system_default') },
		...videoInputDevices.map((device, index) => ({ value: device.deviceId, label: device.label || $_('audio_settings.camera_n', { values: { n: index + 1 } }) }))
	]);
	const PROCESSING_OPTIONS = [
		{ value: 'auto', label: $_('audio_settings.automatic') },
		{ value: 'dsp', label: $_('audio_settings.light'), hint: $_('audio_settings.uses_less_power') },
		{ value: 'rnn', label: $_('audio_settings.strong_noise') },
		{ value: 'studio', label: $_('audio_settings.off'), hint: $_('audio_settings.raw_microphone') }
	];
	const SPATIAL_MODE_OPTIONS = [
		{ value: 'auto', label: $_('audio_settings.automatic') },
		{ value: 'pan_distance', label: $_('audio_settings.stereo_distance') },
		{ value: 'full_3d', label: $_('audio_settings.full_3d') },
		{ value: 'off', label: $_('audio_settings.off') }
	];
	const SHARE_QUALITY_OPTIONS = [
		{ value: 'auto', label: $_('audio_settings.automatic') },
		{ value: '1080p', label: '1080p' },
		{ value: '720p', label: '720p' },
		{ value: '480p', label: '480p' },
		{ value: '144p-mobile', label: '144p', hint: $_('audio_settings.saves_data') },
		{ value: 'source-unbounded', label: $_('audio_settings.source'), hint: $_('audio_settings.no_bitrate_cap') }
	];
	const MUTE_OPTIONS = [
		{ value: 'mute-local-input', label: $_('audio_settings.calls_recordings') },
		{ value: 'outbound-only', label: $_('audio_settings.calls_only') }
	];
	const STEM_OPTIONS = [
		{ value: 'mixed-only', label: $_('audio_settings.one_mixed') },
		{ value: 'mixed-plus-mic', label: $_('audio_settings.mixed_mic') },
		{ value: 'mixed-plus-all-audio', label: $_('audio_settings.mixed_all') }
	];
	const TRANSPORT_OPTIONS = [
		{ value: 'auto', label: $_('audio_settings.automatic'), hint: $_('audio_settings.this_server_first') },
		{ value: 'p2p-only', label: $_('audio_settings.direct_only') },
		{ value: 'sfu-preferred', label: $_('audio_settings.media_server_first') },
		{ value: 'wabidb', label: $_('audio_settings.through_server') }
	];
	const processingFallbackWord = $derived(
		$audioProcessingRuntimeStatus.reason === 'performance_guard'
			? $_('audio_settings.light_processing_now')
			: $audioProcessingRuntimeStatus.reason === 'native_not_supported'
				? $_('audio_settings.strong_unavailable')
				: ''
	);
	const rangeFill = (value: number, min: number, max: number) => `--w-range-fill: ${Math.round(((value - min) / (max - min)) * 100)}%`;

	$effect(() => { if ($desktopHelperState?.message && desktopLocalAppRuntime) desktopHelperProfileStatus = $desktopHelperState.message; });


	async function loadMediaDevices() { if (!browser || !navigator.mediaDevices?.enumerateDevices) return; try { const devices = await navigator.mediaDevices.enumerateDevices(); audioInputDevices = devices.filter((d) => d.kind === 'audioinput'); videoInputDevices = devices.filter((d) => d.kind === 'videoinput'); } catch {} }
	function handleMicDeviceChange(deviceId: string) {
		selectedMicDeviceId = deviceId;
		setPreferredMicDeviceId(deviceId || null);
		cleanupMicTest(); micTestState = 'idle';
		void applyCurrentAudioProcessingToLocalTrack();
	}
	function handleCameraDeviceChange(deviceId: string) { selectedCameraDeviceId = deviceId; setPreferredCameraDeviceId(deviceId || null); }
	async function saveDesktopHelperProfile(): Promise<void> {
		if (!browser) return;
		const normalizedName = desktopHelperProfileName.trim();
		if (desktopHelperProfileMode !== 'off' && !normalizedName) { desktopHelperProfileStatus = $_('audio_settings.helper_name_required'); return; }
		try {
			localStorage.setItem(DESKTOP_HELPER_PROFILE_KEY, JSON.stringify({ name: normalizedName, mode: desktopHelperProfileMode }));
			desktopHelperProfileStatus = desktopHelperProfileMode === 'off' ? $_('audio_settings.helper_saved_off') : $_('audio_settings.helper_saved_on');
			await syncDesktopHelperService();
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		} catch { desktopHelperProfileStatus = $_('audio_settings.helper_save_failed'); }
	}
	function updateMediaQualityMode(mode: MediaQualityMode) { mediaQualityMode = mode; setMediaQualityMode(mode); }
	function updateAudioProcessingMode(mode: AudioProcessingMode) { audioProcessingMode = mode; setAudioProcessingMode(mode); clearAudioPerformanceFallbackOverride(); void applyCurrentAudioProcessingToLocalTrack(); }
	function updateCallTransportMode(mode: CallTransportMode) { callTransportMode = mode; setCallTransportMode(mode); }
	function updateCallMuteBehavior(mode: CallMuteBehavior) { callMuteBehavior = mode; setCallMuteBehavior(mode); refreshLocalAudioMuteState(); refreshCallRecordingMix(); }
	function updateCallRecordingStemMode(mode: CallRecordingStemMode) { callRecordingStemMode = mode; setCallRecordingStemMode(mode); }
	function toggleSrtGateway() { if (!localAppRuntime) return; srtGatewayEnabled = !srtGatewayEnabled; setSrtGatewayEnabled(srtGatewayEnabled); }
	function updateScreenShareQualityPreset(preset: ScreenShareQualityPreset) { screenShareQualityPreset = preset; setScreenShareQualityPreset(preset); }
	function updateScreenShareBitrateKbps(value: number) { screenShareBitrateKbps = value; setScreenShareBitrateKbps(value > 0 ? value : null); }
	function toggleSpatialAudio() { spatialAudioEnabled = !spatialAudioEnabled; setSpatialAudioEnabled(spatialAudioEnabled); refreshSpatialAudioRuntime(); }
	function updateSpatialAudioMode(mode: SpatialAudioMode) { spatialAudioMode = mode; setSpatialAudioMode(mode); refreshSpatialAudioRuntime(); }
	function updateSpatialAudioStrength(value: number) { spatialAudioStrength = value; setSpatialAudioMasterStrength(value); refreshSpatialAudioRuntime(); }
	function updateSpatialAudioDistanceScale(value: number) { spatialAudioDistanceScale = value; setSpatialAudioDistanceScale(value); refreshSpatialAudioRuntime(); }
	function toggleSpatialWarningsMuted() { spatialAudioWarningsMuted = !spatialAudioWarningsMuted; setSpatialAudioWarningMuted(spatialAudioWarningsMuted); refreshSpatialAudioRuntime(); }
	function toggleSpatialQuickToggleVisible() { spatialAudioQuickToggleVisible = !spatialAudioQuickToggleVisible; setSpatialAudioQuickToggleVisible(spatialAudioQuickToggleVisible); refreshSpatialAudioRuntime(); }
	function cleanupMicTest() {
		micTestGeneration++;
		micTestCapture.clear();
		if (micTestStopTimer !== null) { clearTimeout(micTestStopTimer); micTestStopTimer = null; }
		if (micTestLevelInterval !== null) { clearInterval(micTestLevelInterval); micTestLevelInterval = null; }
		if (micTestRecorder) {
			micTestRecorder.onstop = null;
			micTestRecorder.ondataavailable = null;
			if (micTestRecorder.state !== 'inactive') micTestRecorder.stop();
		}
		micTestRecorder = null;
		if (micTestStream) { micTestStream.getTracks().forEach((track) => track.stop()); micTestStream = null; }
		if (micTestAudioContext) { void micTestAudioContext.close().catch(() => undefined); micTestAudioContext = null; }
		micTestAnalyser = null; micTestLevel = 0;
	}
	async function runMicTest() {
		cleanupMicTest();
		const generation = micTestGeneration;
		if (micTestAudioUrl) { URL.revokeObjectURL(micTestAudioUrl); micTestAudioUrl = null; }
		const chunks: Blob[] = [];
		micTestState = 'recording';
		micTestError = '';
		try {
			const capture = await micTestCapture.replace(() => {});
			if (generation !== micTestGeneration) return;
			micTestStream = new MediaStream([capture.outputTrack]);
			micTestAudioContext = new AudioContext();
			void micTestAudioContext.resume().catch(() => undefined);
			const source = micTestAudioContext.createMediaStreamSource(micTestStream);
			micTestAnalyser = micTestAudioContext.createAnalyser();
			micTestAnalyser.fftSize = 1024;
			source.connect(micTestAnalyser);
			const data = new Uint8Array(micTestAnalyser.frequencyBinCount);
			micTestLevelInterval = window.setInterval(() => { if (!micTestAnalyser) return; micTestAnalyser.getByteTimeDomainData(data); let sum = 0; for (let i = 0; i < data.length; i += 1) { const n = (data[i] - 128) / 128; sum += n * n; } micTestLevel = Math.min(1, Math.sqrt(sum / data.length) * 8); }, 80);
			const recorder = new MediaRecorder(micTestStream);
			micTestRecorder = recorder;
			recorder.ondataavailable = (event) => { if (generation === micTestGeneration && event.data.size > 0) chunks.push(event.data); };
			recorder.onstop = () => {
				if (generation !== micTestGeneration) return;
				const blob = new Blob(chunks, { type: recorder.mimeType });
				micTestAudioUrl = URL.createObjectURL(blob); micTestState = 'ready'; cleanupMicTest();
			};
			recorder.start();
			micTestStopTimer = setTimeout(() => { if (generation === micTestGeneration && recorder.state === 'recording') recorder.stop(); }, 4000);
		} catch (error) {
			if (generation !== micTestGeneration) return;
			console.error('Mic test failed:', error); micTestState = 'idle'; cleanupMicTest();
			micTestError = $_('audio_settings.mic_failed', { values: { brand: brandName } });
		}
	}

	onMount(async () => {
		localAppRuntime = isTauriRuntime();
		desktopLocalAppRuntime = getTauriPlatform() === 'desktop';
		if (browser) {
			selectedMicDeviceId = getPreferredMicDeviceId() || '';
			selectedCameraDeviceId = getPreferredCameraDeviceId() || '';
			void loadMediaDevices();
		}
		const mediaSettings = await loadEffectiveMediaSettingsSnapshot();
		mediaQualityMode = mediaSettings.qualityMode;
		audioProcessingMode = mediaSettings.audioProcessingMode;
		callTransportMode = mediaSettings.callTransportMode;
		callMuteBehavior = mediaSettings.callMuteBehavior;
		callRecordingStemMode = mediaSettings.callRecordingStemMode;
		mediaRuntimeSnapshot = mediaSettings.runtime;
		srtGatewayEnabled = mediaSettings.srtGatewayEnabled;
		screenShareQualityPreset = mediaSettings.screenShareQualityPreset;
		screenShareBitrateKbps = mediaSettings.screenShareBitrateKbps;
		spatialAudioEnabled = mediaSettings.spatialAudio.enabled;
		spatialAudioMode = mediaSettings.spatialAudio.mode;
		spatialAudioStrength = mediaSettings.spatialAudio.masterStrength;
		spatialAudioDistanceScale = mediaSettings.spatialAudio.distanceScale;
		spatialAudioWarningsMuted = mediaSettings.spatialAudio.warningMuted;
		spatialAudioQuickToggleVisible = mediaSettings.spatialAudio.quickToggleVisible;
		if (browser) {
			try {
				const raw = localStorage.getItem(DESKTOP_HELPER_PROFILE_KEY);
				if (raw) { const parsed = JSON.parse(raw) as { name?: string; mode?: DesktopHelperProfileMode }; desktopHelperProfileName = typeof parsed.name === 'string' ? parsed.name : ''; desktopHelperProfileMode = parsed.mode === 'files-only' || parsed.mode === 'desktop-assist' ? parsed.mode : 'off'; }
			} catch { desktopHelperProfileName = ''; desktopHelperProfileMode = 'off'; }
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		}
	});
	onDestroy(() => {
		cleanupMicTest();
		if (micTestAudioUrl) URL.revokeObjectURL(micTestAudioUrl);
	});
</script>

<section class="settings-block audio-tab" aria-labelledby="audio-devices-title">
	<h3 class="settings-block__title" id="audio-devices-title">{$_('audio_settings.devices_title')}</h3>
	<p class="settings-block__hint">{$_('audio_settings.devices_hint')}</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-mic-label">{$_('audio_settings.microphone')}</p>
				<p class="w-srow__hint">{$_('audio_settings.mic_used')}</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel={$_('audio_settings.microphone')} options={micOptions} value={selectedMicDeviceId} align="end" onchange={handleMicDeviceChange} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-camera-label">{$_('calls.camera')}</p>
				<p class="w-srow__hint">{$_('audio_settings.camera_used')}</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel={$_('calls.camera')} options={cameraOptions} value={selectedCameraDeviceId} align="end" onchange={handleCameraDeviceChange} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-processing-label">{$_('audio_settings.noise_suppression')}</p>
				<p class="w-srow__hint">{processingFallbackWord || $_('audio_settings.noise_help')}</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel={$_('audio_settings.noise_suppression')} options={PROCESSING_OPTIONS} value={audioProcessingMode} align="end" onchange={(value) => updateAudioProcessingMode(value as AudioProcessingMode)} />
			</div>
		</div>
		<div class="w-srow audio-test">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-test-label">{$_('audio_settings.test_mic_label')}</p>
				<p class="w-srow__hint">{$_('audio_settings.test_mic_hint')}</p>
			</div>
			<div class="w-srow__control">
				<button type="button" class="w-btn w-btn--sm" onclick={runMicTest} disabled={micTestState === 'recording'} aria-busy={micTestState === 'recording'}>
					<Icon name="mic" size={16} />{micTestState === 'recording' ? $_('audio_settings.recording') : $_('audio_settings.test_microphone')}
				</button>
			</div>
			{#if micTestState === 'recording' || micTestAudioUrl || micTestError}
				<div class="audio-test__result">
					{#if micTestState === 'recording'}
						<div class="audio-meter" role="meter" aria-label={$_('audio_settings.mic_level')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(micTestLevel * 100)}><span style:width={`${Math.round(micTestLevel * 100)}%`}></span></div>
					{/if}
					{#if micTestAudioUrl && micTestState !== 'recording'}<audio src={micTestAudioUrl} controls aria-label={$_('audio_settings.mic_test_aria')}></audio>{/if}
					{#if micTestError}<p class="audio-note is-error" role="alert"><Icon name="alert" size={14} />{micTestError}</p>{/if}
				</div>
			{/if}
		</div>
	</div>
	{#if audioInputDevices.length === 0 || videoInputDevices.length === 0}
		<p class="audio-note">{$_('audio_settings.some_hidden')}</p>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.spatial} aria-controls="audio-spatial" onclick={() => (open.spatial = !open.spatial)}>
		<Icon name="chevRight" />{$_('audio_settings.spatial_audio')}<span class="w-count audio-count">{spatialAudioEnabled ? $_('audio_settings.on') : $_('audio_settings.off')}</span>
	</button>
	{#if open.spatial}
		<div class="w-disclosure__body" id="audio-spatial">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="audio-spatial-label">{$_('audio_settings.place_voices')}</p>
						<p class="w-srow__hint">{$_('audio_settings.place_voices_hint')}</p>
					</div>
					<div class="w-srow__control"><Switch labelledby="audio-spatial-label" checked={spatialAudioEnabled} onchange={toggleSpatialAudio} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">{$_('audio_settings.rendering')}</p><p class="w-srow__hint">{$_('audio_settings.full3d_hint')}</p></div>
					<div class="w-srow__control"><Select ariaLabel={$_('audio_settings.spatial_rendering')} options={SPATIAL_MODE_OPTIONS} value={spatialAudioMode} align="end" disabled={!spatialAudioEnabled} onchange={(value) => updateSpatialAudioMode(value as SpatialAudioMode)} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><label class="w-srow__label" for="audio-spatial-strength">{$_('audio_settings.strength')}</label><p class="w-srow__hint">{Math.round(spatialAudioStrength * 100)}%</p></div>
					<div class="w-srow__control"><input id="audio-spatial-strength" type="range" class="w-range audio-range" min="0" max="1" step="0.05" value={spatialAudioStrength} style={rangeFill(spatialAudioStrength, 0, 1)} aria-valuetext={`${Math.round(spatialAudioStrength * 100)}%`} disabled={!spatialAudioEnabled} oninput={(event) => updateSpatialAudioStrength(parseFloat(event.currentTarget.value))} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><label class="w-srow__label" for="audio-spatial-distance">{$_('audio_settings.distance')}</label><p class="w-srow__hint">{$_('audio_settings.distance_hint', { values: { scale: spatialAudioDistanceScale.toFixed(1) } })}</p></div>
					<div class="w-srow__control"><input id="audio-spatial-distance" type="range" class="w-range audio-range" min="0.4" max="4" step="0.1" value={spatialAudioDistanceScale} style={rangeFill(spatialAudioDistanceScale, 0.4, 4)} aria-valuetext={$_('audio_settings.times', { values: { n: spatialAudioDistanceScale.toFixed(1) } })} disabled={!spatialAudioEnabled} oninput={(event) => updateSpatialAudioDistanceScale(parseFloat(event.currentTarget.value))} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label" id="audio-spatial-warn-label">{$_('audio_settings.quiet_fallback')}</p><p class="w-srow__hint">{$_('audio_settings.quiet_hint')}</p></div>
					<div class="w-srow__control"><Switch labelledby="audio-spatial-warn-label" checked={spatialAudioWarningsMuted} onchange={toggleSpatialWarningsMuted} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label" id="audio-spatial-quick-label">{$_('audio_settings.spatial_button')}</p><p class="w-srow__hint">{$_('audio_settings.spatial_button_hint')}</p></div>
					<div class="w-srow__control"><Switch labelledby="audio-spatial-quick-label" checked={spatialAudioQuickToggleVisible} onchange={toggleSpatialQuickToggleVisible} /></div>
				</div>
			</div>
		</div>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.sharing} aria-controls="audio-sharing" onclick={() => (open.sharing = !open.sharing)}>
		<Icon name="chevRight" />{$_('audio_settings.screen_sharing')}
	</button>
	{#if open.sharing}
		<div class="w-disclosure__body" id="audio-sharing">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('audio_settings.media_quality')}</p>
						<p class="w-srow__hint">{localAppRuntime ? $_('audio_settings.enhanced_on') : $_('audio_settings.enhanced_needs')}</p>
					</div>
					<div class="w-srow__control">
						<Select ariaLabel={$_('audio_settings.media_quality')} align="end" value={mediaQualityMode} onchange={(value) => updateMediaQualityMode(value as MediaQualityMode)} options={[{ value: 'web-baseline', label: $_('audio_settings.standard') }, { value: 'local-enhanced', label: $_('audio_settings.enhanced'), hint: $_('audio_settings.desktop_app'), disabled: !localAppRuntime }]} />
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">{$_('audio_settings.screen_res')}</p><p class="w-srow__hint">{$_('audio_settings.lower_res_hint')}</p></div>
					<div class="w-srow__control"><Select ariaLabel={$_('audio_settings.screen_res')} options={SHARE_QUALITY_OPTIONS} value={screenShareQualityPreset} align="end" onchange={(value) => updateScreenShareQualityPreset(value as ScreenShareQualityPreset)} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><label class="w-srow__label" for="audio-share-bitrate">{$_('audio_settings.bitrate_limit')}</label><p class="w-srow__hint">{$_('audio_settings.bitrate_hint')}</p></div>
					<div class="w-srow__control"><input id="audio-share-bitrate" class="w-field audio-number" type="number" min="0" max="200000" step="250" value={screenShareBitrateKbps} onchange={(event) => updateScreenShareBitrateKbps(parseInt(event.currentTarget.value || '0', 10) || 0)} /></div>
				</div>
			</div>
		</div>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.recording} aria-controls="audio-recording" onclick={() => (open.recording = !open.recording)}>
		<Icon name="chevRight" />{$_('audio_settings.recording_mute')}
	</button>
	{#if open.recording}
		<div class="w-disclosure__body" id="audio-recording">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">{$_('audio_settings.muting_in')}</p><p class="w-srow__hint">{$_('audio_settings.mute_hint')}</p></div>
					<div class="w-srow__control"><Select ariaLabel={$_('audio_settings.muting_in')} options={MUTE_OPTIONS} value={callMuteBehavior} align="end" onchange={(value) => updateCallMuteBehavior(value as CallMuteBehavior)} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">{$_('audio_settings.recording_files')}</p><p class="w-srow__hint">{$_('audio_settings.stems_hint')}</p></div>
					<div class="w-srow__control"><Select ariaLabel={$_('audio_settings.recording_files')} options={STEM_OPTIONS} value={callRecordingStemMode} align="end" onchange={(value) => updateCallRecordingStemMode(value as CallRecordingStemMode)} /></div>
				</div>
			</div>
		</div>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.troubleshooting} aria-controls="audio-troubleshooting" onclick={() => (open.troubleshooting = !open.troubleshooting)}>
		<Icon name="chevRight" />{$_('calls.troubleshooting')}
	</button>
	{#if open.troubleshooting}
		<div class="w-disclosure__body" id="audio-troubleshooting">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="audio-conn-label">{$_('calls.show_connection_details')}</p>
						<p class="w-srow__hint" id="audio-conn-hint">{$_('audio_settings.conn_hint')}</p>
					</div>
					<div class="w-srow__control"><Switch labelledby="audio-conn-label" describedby="audio-conn-hint" checked={connectionDetailsDuringCalls} onchange={setConnectionDetailsDuringCalls} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('audio_settings.call_route')}</p>
						<p class="w-srow__hint">
							{$_('audio_settings.route_hint')}
							{#if mediaRuntimeSnapshot && !mediaRuntimeSnapshot.media?.turn?.configured} {$_('audio_settings.no_turn')}{/if}
						</p>
					</div>
					<div class="w-srow__control"><Select ariaLabel={$_('audio_settings.call_route')} options={TRANSPORT_OPTIONS} value={callTransportMode} align="end" onchange={(value) => updateCallTransportMode(value as CallTransportMode)} /></div>
				</div>
				{#if localAppRuntime && mediaRuntimeSnapshot?.media?.boosterRelay?.components?.gatewayConfigured}
					<div class="w-srow">
						<div class="w-srow__text"><p class="w-srow__label" id="audio-srt-label">{$_('audio_settings.srt_gateway')}</p><p class="w-srow__hint">{$_('audio_settings.srt_hint')}</p></div>
						<div class="w-srow__control"><Switch labelledby="audio-srt-label" checked={srtGatewayEnabled} onchange={toggleSrtGateway} /></div>
					</div>
				{/if}
			</div>
			<ConnectionDiagnostics />
		</div>
	{/if}
</section>

<style>
	.audio-tab :global(.w-disclosure) {
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.audio-tab > .w-srows + :global(.w-disclosure),
	.audio-tab > .audio-note + :global(.w-disclosure) {
		margin-top: 16px;
		border-top: var(--w-bw) solid var(--w-line);
	}
	/* §7.25: a disclosure's content is not indented. The header's rule is its top rule; the body
	   closes with its own, so the next header is separated from the last row. */
	.audio-tab :global(.w-disclosure__body) {
		padding: 0 0 8px;
		border-top: 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.audio-subrows {
		border-top: 0;
	}
	.audio-subrows > .w-srow:last-child {
		border-bottom: 0;
	}
	.audio-count {
		margin-left: auto;
	}
	.audio-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.audio-note.is-error {
		margin: 0;
		color: var(--w-danger);
	}
	.audio-note :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.audio-test__result {
		display: grid;
		grid-column: 1 / -1;
		gap: 8px;
		padding-top: 10px;
	}
	.audio-meter {
		height: 6px;
		overflow: hidden;
		border-radius: var(--w-pill);
		background: var(--w-sink);
		box-shadow: inset 0 0 0 var(--w-bw) var(--w-line);
	}
	.audio-meter > span {
		display: block;
		height: 100%;
		background: var(--w-accent);
		transition: width 80ms linear;
	}
	.audio-test__result audio {
		width: 100%;
		max-width: 420px;
	}
	.audio-range {
		width: 180px;
	}
	.audio-number {
		width: 120px;
	}
	@media (max-width: 600px) {
		.audio-range {
			width: 140px;
		}
	}
</style>
