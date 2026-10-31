<script lang="ts">
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
	import { readConnectionDetailsPreference, writeConnectionDetailsPreference } from './connectionDetailsSetting';
	import { audioProcessingRuntimeStatus, clearAudioPerformanceFallbackOverride, applyCurrentAudioProcessingToLocalTrack, refreshLocalAudioMuteState, refreshSpatialAudioRuntime, spatialAudioRuntimeStatus } from '$lib/calling';
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
		callConnectionDetailsOpen.set(on);
	}

	const micOptions = $derived([
		{ value: '', label: 'System default' },
		...audioInputDevices.map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` }))
	]);
	const cameraOptions = $derived([
		{ value: '', label: 'System default' },
		...videoInputDevices.map((device, index) => ({ value: device.deviceId, label: device.label || `Camera ${index + 1}` }))
	]);
	const PROCESSING_OPTIONS = [
		{ value: 'auto', label: 'Automatic' },
		{ value: 'dsp', label: 'Light', hint: 'uses less power' },
		{ value: 'rnn', label: 'Strong noise suppression' },
		{ value: 'studio', label: 'Off', hint: 'raw microphone' }
	];
	const SPATIAL_MODE_OPTIONS = [
		{ value: 'auto', label: 'Automatic' },
		{ value: 'pan_distance', label: 'Stereo with distance' },
		{ value: 'full_3d', label: 'Full 3D (headphones)' },
		{ value: 'off', label: 'Off' }
	];
	const SHARE_QUALITY_OPTIONS = [
		{ value: 'auto', label: 'Automatic' },
		{ value: '1080p', label: '1080p' },
		{ value: '720p', label: '720p' },
		{ value: '480p', label: '480p' },
		{ value: '144p-mobile', label: '144p', hint: 'saves data' },
		{ value: 'source-unbounded', label: 'Source', hint: 'no bitrate cap' }
	];
	const MUTE_OPTIONS = [
		{ value: 'mute-local-input', label: 'Calls and my recordings' },
		{ value: 'outbound-only', label: 'Calls only' }
	];
	const STEM_OPTIONS = [
		{ value: 'mixed-only', label: 'One mixed file' },
		{ value: 'mixed-plus-mic', label: 'Mixed file + my microphone' },
		{ value: 'mixed-plus-all-audio', label: 'Mixed file + every voice' }
	];
	const TRANSPORT_OPTIONS = [
		{ value: 'auto', label: 'Automatic', hint: 'this server first' },
		{ value: 'p2p-only', label: 'Direct (peer-to-peer) only' },
		{ value: 'sfu-preferred', label: 'Media server first' },
		{ value: 'wabidb', label: 'Through this server only' }
	];
	const processingFallbackWord = $derived(
		$audioProcessingRuntimeStatus.reason === 'performance_guard'
			? 'Using light processing for now, to keep calls smooth on this device.'
			: $audioProcessingRuntimeStatus.reason === 'native_not_supported'
				? 'Strong noise suppression is not available here, so light processing is used.'
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
		if (desktopHelperProfileMode !== 'off' && !normalizedName) { desktopHelperProfileStatus = 'Pick a helper name before using helper mode.'; return; }
		try {
			localStorage.setItem(DESKTOP_HELPER_PROFILE_KEY, JSON.stringify({ name: normalizedName, mode: desktopHelperProfileMode }));
			desktopHelperProfileStatus = desktopHelperProfileMode === 'off' ? 'Desktop helper profile saved. Helper mode stays off.' : 'Desktop helper profile saved. Activating desktop helper...';
			await syncDesktopHelperService();
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		} catch { desktopHelperProfileStatus = 'Failed to save desktop helper profile locally.'; }
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
			micTestError = `Your microphone didn't start. Allow microphone access for ${brandName}, then try again.`;
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
	<h3 class="settings-block__title" id="audio-devices-title">Devices</h3>
	<p class="settings-block__hint">Choosing a device does not turn it on. Mute and camera live in the call controls.</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-mic-label">Microphone</p>
				<p class="w-srow__hint">Used for calls and the test below.</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel="Microphone" options={micOptions} value={selectedMicDeviceId} align="end" onchange={handleMicDeviceChange} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-camera-label">Camera</p>
				<p class="w-srow__hint">Used when you turn video on in a call.</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel="Camera" options={cameraOptions} value={selectedCameraDeviceId} align="end" onchange={handleCameraDeviceChange} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-processing-label">Noise suppression</p>
				<p class="w-srow__hint">{processingFallbackWord || 'How much background sound is removed before others hear you.'}</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel="Noise suppression" options={PROCESSING_OPTIONS} value={audioProcessingMode} align="end" onchange={(value) => updateAudioProcessingMode(value as AudioProcessingMode)} />
			</div>
		</div>
		<div class="w-srow audio-test">
			<div class="w-srow__text">
				<p class="w-srow__label" id="audio-test-label">Test your microphone</p>
				<p class="w-srow__hint">Records four seconds with the device and processing above, then plays it back. Separate from any call.</p>
			</div>
			<div class="w-srow__control">
				<button type="button" class="w-btn w-btn--sm" onclick={runMicTest} disabled={micTestState === 'recording'} aria-busy={micTestState === 'recording'}>
					<Icon name="mic" size={16} />{micTestState === 'recording' ? 'Recording…' : 'Test microphone'}
				</button>
			</div>
			{#if micTestState === 'recording' || micTestAudioUrl || micTestError}
				<div class="audio-test__result">
					{#if micTestState === 'recording'}
						<div class="audio-meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(micTestLevel * 100)}><span style:width={`${Math.round(micTestLevel * 100)}%`}></span></div>
					{/if}
					{#if micTestAudioUrl && micTestState !== 'recording'}<audio src={micTestAudioUrl} controls aria-label="Your microphone test"></audio>{/if}
					{#if micTestError}<p class="audio-note is-error" role="alert"><Icon name="alert" size={14} />{micTestError}</p>{/if}
				</div>
			{/if}
		</div>
	</div>
	{#if audioInputDevices.length === 0 || videoInputDevices.length === 0}
		<p class="audio-note">Some devices stay hidden until you allow access. System default uses your device's own choice.</p>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.spatial} aria-controls="audio-spatial" onclick={() => (open.spatial = !open.spatial)}>
		<Icon name="chevRight" />Spatial audio<span class="w-count audio-count">{spatialAudioEnabled ? 'On' : 'Off'}</span>
	</button>
	{#if open.spatial}
		<div class="w-disclosure__body" id="audio-spatial">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="audio-spatial-label">Place voices around you</p>
						<p class="w-srow__hint">Voices come from where people sit in the room, in stereo or 3D.</p>
					</div>
					<div class="w-srow__control"><Switch labelledby="audio-spatial-label" checked={spatialAudioEnabled} onchange={toggleSpatialAudio} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">Rendering</p><p class="w-srow__hint">Full 3D sounds best with headphones.</p></div>
					<div class="w-srow__control"><Select ariaLabel="Spatial rendering" options={SPATIAL_MODE_OPTIONS} value={spatialAudioMode} align="end" disabled={!spatialAudioEnabled} onchange={(value) => updateSpatialAudioMode(value as SpatialAudioMode)} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><label class="w-srow__label" for="audio-spatial-strength">Strength</label><p class="w-srow__hint">{Math.round(spatialAudioStrength * 100)}%</p></div>
					<div class="w-srow__control"><input id="audio-spatial-strength" type="range" class="w-range audio-range" min="0" max="1" step="0.05" value={spatialAudioStrength} style={rangeFill(spatialAudioStrength, 0, 1)} aria-valuetext={`${Math.round(spatialAudioStrength * 100)}%`} disabled={!spatialAudioEnabled} oninput={(event) => updateSpatialAudioStrength(parseFloat(event.currentTarget.value))} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><label class="w-srow__label" for="audio-spatial-distance">Distance</label><p class="w-srow__hint">How quickly voices fade with distance: {spatialAudioDistanceScale.toFixed(1)}×</p></div>
					<div class="w-srow__control"><input id="audio-spatial-distance" type="range" class="w-range audio-range" min="0.4" max="4" step="0.1" value={spatialAudioDistanceScale} style={rangeFill(spatialAudioDistanceScale, 0.4, 4)} aria-valuetext={`${spatialAudioDistanceScale.toFixed(1)} times`} disabled={!spatialAudioEnabled} oninput={(event) => updateSpatialAudioDistanceScale(parseFloat(event.currentTarget.value))} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label" id="audio-spatial-warn-label">Quiet fallback notices</p><p class="w-srow__hint">Don't tell me when spatial audio falls back to normal sound.</p></div>
					<div class="w-srow__control"><Switch labelledby="audio-spatial-warn-label" checked={spatialAudioWarningsMuted} onchange={toggleSpatialWarningsMuted} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label" id="audio-spatial-quick-label">Spatial button in calls</p><p class="w-srow__hint">Show a spatial audio button in the call controls.</p></div>
					<div class="w-srow__control"><Switch labelledby="audio-spatial-quick-label" checked={spatialAudioQuickToggleVisible} onchange={toggleSpatialQuickToggleVisible} /></div>
				</div>
			</div>
		</div>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.sharing} aria-controls="audio-sharing" onclick={() => (open.sharing = !open.sharing)}>
		<Icon name="chevRight" />Screen sharing and quality
	</button>
	{#if open.sharing}
		<div class="w-disclosure__body" id="audio-sharing">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">Media quality</p>
						<p class="w-srow__hint">{localAppRuntime ? 'The desktop app can use enhanced media.' : 'Enhanced media needs the desktop app. Calls work here as they are.'}</p>
					</div>
					<div class="w-srow__control">
						<Select ariaLabel="Media quality" align="end" value={mediaQualityMode} onchange={(value) => updateMediaQualityMode(value as MediaQualityMode)} options={[{ value: 'web-baseline', label: 'Standard' }, { value: 'local-enhanced', label: 'Enhanced', hint: 'desktop app', disabled: !localAppRuntime }]} />
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">Screen share resolution</p><p class="w-srow__hint">Lower resolutions use less data.</p></div>
					<div class="w-srow__control"><Select ariaLabel="Screen share resolution" options={SHARE_QUALITY_OPTIONS} value={screenShareQualityPreset} align="end" onchange={(value) => updateScreenShareQualityPreset(value as ScreenShareQualityPreset)} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><label class="w-srow__label" for="audio-share-bitrate">Bitrate limit (kbps)</label><p class="w-srow__hint">0 follows the resolution above; any other number overrides it.</p></div>
					<div class="w-srow__control"><input id="audio-share-bitrate" class="w-field audio-number" type="number" min="0" max="200000" step="250" value={screenShareBitrateKbps} onchange={(event) => updateScreenShareBitrateKbps(parseInt(event.currentTarget.value || '0', 10) || 0)} /></div>
				</div>
			</div>
		</div>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.recording} aria-controls="audio-recording" onclick={() => (open.recording = !open.recording)}>
		<Icon name="chevRight" />Recording and mute
	</button>
	{#if open.recording}
		<div class="w-disclosure__body" id="audio-recording">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">Muting silences you in</p><p class="w-srow__hint">"Calls only" keeps your microphone in your own recordings while others can't hear you.</p></div>
					<div class="w-srow__control"><Select ariaLabel="Muting silences you in" options={MUTE_OPTIONS} value={callMuteBehavior} align="end" onchange={(value) => updateCallMuteBehavior(value as CallMuteBehavior)} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text"><p class="w-srow__label">Recording files</p><p class="w-srow__hint">Separate voice tracks use more processing power and disk space.</p></div>
					<div class="w-srow__control"><Select ariaLabel="Recording files" options={STEM_OPTIONS} value={callRecordingStemMode} align="end" onchange={(value) => updateCallRecordingStemMode(value as CallRecordingStemMode)} /></div>
				</div>
			</div>
		</div>
	{/if}

	<button type="button" class="w-disclosure" aria-expanded={open.troubleshooting} aria-controls="audio-troubleshooting" onclick={() => (open.troubleshooting = !open.troubleshooting)}>
		<Icon name="chevRight" />Troubleshooting
	</button>
	{#if open.troubleshooting}
		<div class="w-disclosure__body" id="audio-troubleshooting">
			<div class="w-srows audio-subrows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="audio-conn-label">Show connection details during calls</p>
						<p class="w-srow__hint" id="audio-conn-hint">Latency, packet loss and the route on the Calls page while you are in a call. Off by default.</p>
					</div>
					<div class="w-srow__control"><Switch labelledby="audio-conn-label" describedby="audio-conn-hint" checked={connectionDetailsDuringCalls} onchange={setConnectionDetailsDuringCalls} /></div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">Call route</p>
						<p class="w-srow__hint">
							Automatic tries this server's relay first, then a direct connection.
							{#if mediaRuntimeSnapshot && !mediaRuntimeSnapshot.media?.turn?.configured} This server has no TURN relay, so direct calls can fail between some networks.{/if}
						</p>
					</div>
					<div class="w-srow__control"><Select ariaLabel="Call route" options={TRANSPORT_OPTIONS} value={callTransportMode} align="end" onchange={(value) => updateCallTransportMode(value as CallTransportMode)} /></div>
				</div>
				{#if localAppRuntime && mediaRuntimeSnapshot?.media?.boosterRelay?.components?.gatewayConfigured}
					<div class="w-srow">
						<div class="w-srow__text"><p class="w-srow__label" id="audio-srt-label">SRT gateway</p><p class="w-srow__hint">Streams through gateway workers your host provides.</p></div>
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
	.audio-tab :global(.w-disclosure__body) {
		border-top: 0;
		padding: 0 0 8px 24px;
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
		.audio-tab :global(.w-disclosure__body) {
			padding-left: 0;
		}
	}
</style>
