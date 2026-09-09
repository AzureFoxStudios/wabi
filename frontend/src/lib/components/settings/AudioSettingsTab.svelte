<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { _ as t } from '$lib/i18n';
	import { audioProcessingRuntimeStatus, callTransportState, clearAudioPerformanceFallbackOverride, applyCurrentAudioProcessingToLocalTrack, refreshLocalAudioMuteState, refreshSpatialAudioRuntime, spatialAudioDiagnostics, spatialAudioRuntimeStatus } from '$lib/calling';
	import { refreshCallRecordingMix } from '$lib/callRecording';
	import { DESKTOP_HELPER_PROFILE_KEY, desktopHelperState, syncDesktopHelperService, type DesktopHelperProfileMode } from '$lib/desktopHelper';
	import { getTauriPlatform } from '$lib/tauri-platform';
	import { AudioCaptureOwner } from '$lib/audioCaptureOwner';
	import { createAudioCaptureSession, disposeAudioCaptureSession } from '$lib/audioCapture';
	import { getBoosterRelayEffectiveMode, getBoosterRelayRequestedMode, isTauriRuntime, loadEffectiveMediaSettingsSnapshot, setAudioProcessingMode, setCallMuteBehavior, setCallRecordingStemMode, setCallTransportMode, setMediaQualityMode, setScreenShareQualityPreset, setScreenShareBitrateKbps, setSpatialAudioDistanceScale, setSpatialAudioEnabled, setSpatialAudioMasterStrength, setSpatialAudioMode, setSpatialAudioQuickToggleVisible, setSpatialAudioWarningMuted, setSrtGatewayEnabled, getPreferredMicDeviceId, setPreferredMicDeviceId, getPreferredCameraDeviceId, setPreferredCameraDeviceId, type AudioProcessingMode, type BoosterRelayMode, type CallMuteBehavior, type CallRecordingStemMode, type CallTransportMode, type MediaQualityMode, type ServerMediaRuntimeResponse, type ScreenShareQualityPreset, type SpatialAudioMode } from '$lib/mediaRuntime';

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

	const boosterRelayRequestedMode = $derived(getBoosterRelayRequestedMode(mediaRuntimeSnapshot));
	const boosterRelayEffectiveMode = $derived(getBoosterRelayEffectiveMode(mediaRuntimeSnapshot));
	$effect(() => { if ($desktopHelperState?.message && desktopLocalAppRuntime) desktopHelperProfileStatus = $desktopHelperState.message; });

	function getBoosterRelayModeLabel(mode: BoosterRelayMode): string { switch (mode) { case 'turn-only': return 'TURN only'; case 'turn-sfu': return 'TURN + SFU'; case 'turn-sfu-gateway': return 'TURN + SFU + Gateway'; default: return 'Off'; } }
	function getBoosterRelayComponentsSummary(runtime: ServerMediaRuntimeResponse | null): string { const components = runtime?.media?.boosterRelay?.components; if (!components) return 'No booster relay components advertised.'; return [`TURN ${components.turnConfigured ? 'ready' : 'off'}`, `SFU ${components.sfuConfigured ? 'ready' : 'off'}`, `Gateway ${components.gatewayConfigured ? components.gatewayHealthy && components.gatewayMediaPlaneReady ? 'ready' : 'starting' : 'off'}`].join(' | '); }
	function getBoosterRelaySelfAdvertisementSummary(runtime: ServerMediaRuntimeResponse | null): string { const advertisement = runtime?.media?.boosterRelay?.selfAdvertisement; if (!advertisement) return 'Self-advertised relay node: unknown.'; if (!advertisement.advertised) return 'Self-advertised relay node: not registered.'; const location = advertisement.url || '(missing URL)'; const relayId = advertisement.relayId ? `, ID ${advertisement.relayId}` : ''; return `Self-advertised relay node: ${advertisement.status || 'unknown'} at ${location}${relayId}.`; }
	function formatRuntimeTime(timestamp: number | null): string { if (!timestamp) return 'never'; return new Date(timestamp).toLocaleTimeString(); }
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
			console.error('Mic test failed:', error); micTestState = 'idle'; cleanupMicTest(); alert('Mic test failed. Please check microphone permissions.');
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

<div class="settings-section audio-settings">
	<h3>{$t('settings.sections.audio')}</h3>
	<p class="audio-intro">These preferences apply on this device. Use the controls in a call to mute your microphone or turn your camera on. Notification sounds are configured in Notifications.</p>

	<section class="audio-settings-group" aria-label="Microphone and camera">
		<h4>Microphone and camera</h4>
		<p class="runtime-note">Device access is controlled by your browser or operating system. Selecting a device does not turn it on.</p>
		<div class="quality-mode-row">
			<label for="mic-device-select">Microphone</label>
			<select id="mic-device-select" class="theme-select" value={selectedMicDeviceId} onchange={(event) => handleMicDeviceChange(event.currentTarget.value)}>
				<option value="">System Default</option>
				{#each audioInputDevices as device, index}<option value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>{/each}
			</select>
		</div>
		<div class="quality-mode-row">
			<label for="camera-device-select">Camera</label>
			<select id="camera-device-select" class="theme-select" value={selectedCameraDeviceId} onchange={(event) => handleCameraDeviceChange(event.currentTarget.value)}>
				<option value="">System Default</option>
				{#each videoInputDevices as device, index}<option value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>{/each}
			</select>
		</div>
		{#if audioInputDevices.length === 0 || videoInputDevices.length === 0}
			<p class="runtime-note">Some devices may remain hidden until you allow access. System Default uses your operating system's choice.</p>
		{/if}
		<div class="quality-mode-row">
			<label for="audio-processing-mode">Audio processing</label>
			<select id="audio-processing-mode" class="theme-select" value={audioProcessingMode} onchange={(event) => updateAudioProcessingMode(event.currentTarget.value as AudioProcessingMode)}>
				<option value="auto">Automatic (Recommended)</option><option value="dsp">DSP (Low CPU)</option><option value="rnn">RNN / Native Suppression</option><option value="studio">Studio / Raw</option>
			</select>
		</div>
		{#if $audioProcessingRuntimeStatus.fallbackActive || $audioProcessingRuntimeStatus.reason}
			<p class="runtime-note">Effective mode: <strong>{$audioProcessingRuntimeStatus.effective.toUpperCase()}</strong> {#if $audioProcessingRuntimeStatus.reason === 'performance_guard'}(performance fallback){:else if $audioProcessingRuntimeStatus.reason === 'native_not_supported'}(native suppression is not supported here){/if}</p>
		{/if}
		<div class="setting-item-full">
			<div class="setting-info"><span class="setting-label">Test your microphone</span><span class="setting-description">Record a short sample with the selected device and audio processing, then play it back. This test is separate from any active call.</span></div>
			<div class="mic-test-row">
				<button
					type="button"
					class="mic-test-btn"
					class:recording={micTestState === 'recording'}
					onclick={runMicTest}
					disabled={micTestState === 'recording'}
					aria-label={micTestState === 'recording' ? 'Recording microphone sample' : 'Record microphone sample'}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
					<span>{micTestState === 'recording' ? 'Recording…' : 'Test mic'}</span>
				</button>
				<div class="mic-level" role="meter" aria-label="Microphone input level" aria-valuemin="0" aria-valuemax="1" aria-valuenow={micTestLevel}><span style:width={`${Math.round(micTestLevel * 100)}%`}></span></div>
				{#if micTestState === 'recording'}<span class="mic-test-state">Recording 4s sample…</span>{/if}
				{#if micTestAudioUrl}<audio src={micTestAudioUrl} controls aria-label="Microphone test recording"></audio>{/if}
			</div>
		</div>
	</section>

	<details class="audio-settings-group">
		<summary>Spatial audio <span>{spatialAudioEnabled ? 'On' : 'Off'}</span></summary>
		<div class="audio-details-body">
			<div class="setting-item"><div class="setting-info"><span class="setting-label">Spatial audio</span><span class="setting-description">Position voices in stereo or a 3D seating layout.</span></div><button type="button" class="toggle-btn" role="switch" aria-label="Spatial audio" aria-checked={spatialAudioEnabled} class:active={spatialAudioEnabled} onclick={toggleSpatialAudio}></button></div>
			<div class="quality-mode-row"><label for="spatial-audio-mode">Rendering</label><select id="spatial-audio-mode" class="theme-select" value={spatialAudioMode} onchange={(event) => updateSpatialAudioMode(event.currentTarget.value as SpatialAudioMode)} disabled={!spatialAudioEnabled}><option value="auto">Auto (Recommended)</option><option value="pan_distance">Stereo Pan + Distance</option><option value="full_3d">Full 3D (HRTF)</option><option value="off">Off</option></select></div>
			<div class="setting-item-full"><div class="setting-info"><label class="setting-label" for="spatial-strength">Strength</label><span class="setting-description">{Math.round(spatialAudioStrength * 100)}%</span></div><input id="spatial-strength" type="range" min="0" max="1" step="0.05" bind:value={spatialAudioStrength} oninput={(event) => updateSpatialAudioStrength(parseFloat(event.currentTarget.value))} class="volume-slider" disabled={!spatialAudioEnabled} /></div>
			<div class="setting-item-full"><div class="setting-info"><label class="setting-label" for="spatial-distance">Distance scale</label><span class="setting-description">{spatialAudioDistanceScale.toFixed(2)}×</span></div><input id="spatial-distance" type="range" min="0.4" max="4" step="0.1" bind:value={spatialAudioDistanceScale} oninput={(event) => updateSpatialAudioDistanceScale(parseFloat(event.currentTarget.value))} class="volume-slider" disabled={!spatialAudioEnabled} /></div>
			<div class="setting-item"><div class="setting-info"><span class="setting-label">Mute spatial warnings</span><span class="setting-description">Hide notifications when spatial audio falls back.</span></div><button type="button" class="toggle-btn" role="switch" aria-label="Mute spatial warnings" aria-checked={spatialAudioWarningsMuted} class:active={spatialAudioWarningsMuted} onclick={toggleSpatialWarningsMuted}></button></div>
			<div class="setting-item"><div class="setting-info"><span class="setting-label">Show in-call spatial toggle</span><span class="setting-description">Show the spatial-audio button on the call bar.</span></div><button type="button" class="toggle-btn" role="switch" aria-label="Show in-call spatial toggle" aria-checked={spatialAudioQuickToggleVisible} class:active={spatialAudioQuickToggleVisible} onclick={toggleSpatialQuickToggleVisible}></button></div>
		</div>
	</details>

	<details class="audio-settings-group">
		<summary>Screen sharing and quality</summary>
		<div class="audio-details-body">
			<div class="quality-mode-row"><label for="media-quality-mode">Media quality</label><select id="media-quality-mode" class="theme-select" value={mediaQualityMode} onchange={(event) => updateMediaQualityMode(event.currentTarget.value as MediaQualityMode)}><option value="web-baseline">Web Baseline</option><option value="local-enhanced" disabled={!localAppRuntime}>Desktop App Enhanced</option></select></div>
			<p class="runtime-note">{#if localAppRuntime}The desktop app supports enhanced media and optional local gateway tools.{:else}Enhanced quality is available in the desktop app. Web calling remains available here.{/if}</p>
			<div class="quality-mode-row"><label for="screen-share-quality">Resolution</label><select id="screen-share-quality" class="theme-select" value={screenShareQualityPreset} onchange={(event) => updateScreenShareQualityPreset(event.currentTarget.value as ScreenShareQualityPreset)}><option value="auto">Auto (Recommended)</option><option value="1080p">1080p</option><option value="source-unbounded">Source (Unbounded Bitrate)</option><option value="720p">720p</option><option value="480p">480p</option><option value="144p-mobile">144p (Mobile / Low data)</option></select></div>
			<div class="quality-mode-row"><label for="screen-share-bitrate-kbps">Bitrate (kbps)</label><input id="screen-share-bitrate-kbps" class="theme-select" type="number" min="0" max="200000" step="250" value={screenShareBitrateKbps} onchange={(event) => updateScreenShareBitrateKbps(parseInt(event.currentTarget.value || '0', 10) || 0)} /></div>
			<p class="runtime-note">Leave bitrate at 0 to use the selected preset. A value above 0 overrides it.</p>
		</div>
	</details>

	<details class="audio-settings-group">
		<summary>Recording and mute behavior</summary>
		<div class="audio-details-body">
			<div class="quality-mode-row"><label for="call-mute-behavior">When you mute</label><select id="call-mute-behavior" class="theme-select" value={callMuteBehavior} onchange={(event) => updateCallMuteBehavior(event.currentTarget.value as CallMuteBehavior)}><option value="mute-local-input">Mute outbound + local recording (Default)</option><option value="outbound-only">Mute outbound only</option></select></div>
			<p class="runtime-note">Outbound-only mute keeps your microphone in local recordings even while others cannot hear it.</p>
			<div class="quality-mode-row"><label for="call-recording-stem-mode">Recording outputs</label><select id="call-recording-stem-mode" class="theme-select" value={callRecordingStemMode} onchange={(event) => updateCallRecordingStemMode(event.currentTarget.value as CallRecordingStemMode)}><option value="mixed-only">Mixed recording only (Default)</option><option value="mixed-plus-mic">Mixed + mic stem</option><option value="mixed-plus-all-audio">Mixed + all live audio stems</option></select></div>
			<p class="runtime-note">Separate audio tracks use more CPU and disk space. All-stems creates a track for every live source.</p>
		</div>
	</details>

	<details class="audio-settings-group">
		<summary>Advanced: routing and desktop tools</summary>
		<div class="audio-details-body">
			<div class="quality-mode-row"><label for="call-transport-mode">Call mode</label><select id="call-transport-mode" class="theme-select" value={callTransportMode} onchange={(event) => updateCallTransportMode(event.currentTarget.value as CallTransportMode)}><option value="auto">Auto (Server relay, then P2P)</option><option value="p2p-only">P2P only (No fallback)</option><option value="sfu-preferred">SFU preferred (Relay, then P2P fallback)</option><option value="wabidb">Server relay only (No fallback)</option></select></div>
			<p class="runtime-note">Auto tries the server's audio relay first. P2P connects participants directly or through TURN. SFU uses LiveKit when the host provides it. Server relay mode routes audio through this Wabi server.</p>
			{#if mediaRuntimeSnapshot && !mediaRuntimeSnapshot.media?.turn?.configured}<p class="runtime-note">This server has no TURN relay configured. Direct P2P connections can fail across mobile or home-network boundaries; Auto can also use the server relay.</p>{/if}
			<div class="setting-item"><div class="setting-info"><span class="setting-label">SRT gateway</span><span class="setting-description">{localAppRuntime ? 'Requires gateway workers provided by your host.' : 'Requires the desktop app and host-provided gateway workers.'}</span></div><button type="button" class="toggle-btn" role="switch" aria-label="SRT gateway" aria-checked={srtGatewayEnabled} class:active={srtGatewayEnabled} onclick={toggleSrtGateway} disabled={!localAppRuntime}></button></div>
			{#if desktopLocalAppRuntime}
				<div class="audio-helper">
					<h4>Desktop helper profile</h4>
					<p class="runtime-note">Give this device a friendly name before activating its helper.</p>
					<div class="quality-mode-row"><label for="desktop-helper-name">Helper name</label><input id="desktop-helper-name" class="emoji-name-input" maxlength="120" placeholder="My laptop" bind:value={desktopHelperProfileName} /></div>
					<div class="quality-mode-row"><label for="desktop-helper-mode">Helper mode</label><select id="desktop-helper-mode" class="theme-select" bind:value={desktopHelperProfileMode}><option value="off">Off</option><option value="files-only">Files Only</option><option value="desktop-assist">Desktop Assist</option></select></div>
					<button type="button" class="action-btn" onclick={saveDesktopHelperProfile}>Save Helper Profile</button>
					{#if desktopHelperProfileStatus}<p class="runtime-note" role="status">{desktopHelperProfileStatus}</p>{/if}
				</div>
			{/if}
		</div>
	</details>

	<details class="audio-settings-group">
		<summary>Connection diagnostics</summary>
		<div class="audio-details-body">
			<p class="runtime-note">Transport runtime: <strong>{$callTransportState.activeTransport.toUpperCase()}</strong></p>
			{#if $spatialAudioRuntimeStatus.active || $spatialAudioRuntimeStatus.fallbackReason}<p class="runtime-note">Spatial runtime: <strong>{$spatialAudioRuntimeStatus.effectiveMode.toUpperCase()}</strong> {#if $spatialAudioRuntimeStatus.fallbackReason}({$spatialAudioRuntimeStatus.fallbackReason.replaceAll('_', ' ')}){/if}</p>{/if}
			<p class="runtime-note">Spatial sources: <strong>{$spatialAudioDiagnostics.totalSources}</strong> (call {$spatialAudioDiagnostics.callSources}, share {$spatialAudioDiagnostics.shareSources})</p>
			<p class="runtime-note">Spatial seats: call {$spatialAudioDiagnostics.callSeatSlots}, share {$spatialAudioDiagnostics.shareSeatSlots}. Last sync {formatRuntimeTime($spatialAudioDiagnostics.lastUpdatedAt)}.</p>
			{#if mediaRuntimeSnapshot?.media?.boosterRelay}
				<p class="runtime-note">Server booster relay: requested {getBoosterRelayModeLabel(boosterRelayRequestedMode)}, effective {getBoosterRelayModeLabel(boosterRelayEffectiveMode)}.</p>
				<p class="runtime-note">{getBoosterRelayComponentsSummary(mediaRuntimeSnapshot)}</p>
				<p class="runtime-note">{getBoosterRelaySelfAdvertisementSummary(mediaRuntimeSnapshot)}</p>
				{#if mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement?.reason}<p class="runtime-note">{mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement.reason}</p>{/if}
				{#if boosterRelayRequestedMode !== 'off' && boosterRelayRequestedMode !== boosterRelayEffectiveMode}<p class="runtime-note">The host requested relay components that this runtime does not expose. The server operator may need to start the matching deployment services.</p>{/if}
			{/if}
		</div>
	</details>
</div>

<style>
	.audio-settings { min-width: 0; }
	.audio-intro { color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.55; text-wrap: pretty; }
	.audio-settings-group { border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); margin-top: 1rem; background: var(--surface-base); min-width: 0; }
	section.audio-settings-group { padding: 1rem; display: grid; gap: 0.85rem; }
	.audio-settings h4 { margin: 0; color: var(--text-heading); font-size: var(--font-size-base); }
	.audio-settings summary { min-height: 44px; padding: 0.75rem 1rem; box-sizing: border-box; color: var(--text-heading); cursor: pointer; font-weight: 600; line-height: 1.5; }
	.audio-settings summary span { margin-inline-start: 0.5rem; font-weight: 400; color: var(--text-secondary); font-size: var(--font-size-sm); }
	.audio-settings summary:hover { background: var(--surface-raised); border-radius: var(--radius-lg); }
	.audio-details-body { display: grid; gap: 0.85rem; padding: 0 1rem 1rem; min-width: 0; }
	.audio-settings .quality-mode-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.4rem; min-width: 0; }
	.audio-settings input:not([type="range"]), .audio-settings select { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; min-height: 40px; }
	.audio-settings .setting-item { gap: 0.75rem; min-width: 0; }
	.audio-settings .setting-info { min-width: 0; flex: 1; }
	.audio-settings .runtime-note { line-height: 1.5; overflow-wrap: anywhere; text-wrap: pretty; }
	.audio-settings audio { width: 100%; min-width: 0; }
	.audio-settings .action-btn { min-height: 40px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.audio-settings .toggle-btn { box-sizing: content-box; border-block: 6px solid transparent !important; background-clip: padding-box !important; }
	.audio-settings :is(button, select, input, summary):focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
	.audio-helper { display: grid; gap: 0.85rem; border-top: 1px solid var(--border-subtle); padding-top: 1rem; }
	.mic-level { height: 8px; border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-sunken); }
	.mic-level span { display: block; height: 100%; background: var(--accent-primary); transition: width 80ms linear; }
	.mic-test-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; min-width: 0; }
	.mic-test-btn { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 40px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0.6rem 1rem; border-radius: var(--radius-md); border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent); background: var(--surface-raised); color: var(--text-heading); font-weight: 600; cursor: pointer; transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast); }
	.mic-test-btn svg { width: 16px; height: 16px; }
	.mic-test-btn:hover { background: color-mix(in srgb, var(--accent-primary-color) 14%, var(--surface-raised)); border-color: color-mix(in srgb, var(--accent-primary-color) 40%, transparent); }
	.mic-test-btn.recording { color: var(--color-danger); border-color: color-mix(in srgb, var(--color-danger) 45%, transparent); animation: mic-test-pulse 1.2s ease-in-out infinite; }
	.mic-test-btn:disabled { opacity: 0.6; cursor: default; }
	.mic-test-state { font-size: var(--font-size-xs); color: var(--text-secondary); }
	@keyframes mic-test-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
	.mic-test-row .mic-level { flex: 1 1 140px; min-width: 140px; }
	.mic-test-row audio { flex: 1 1 200px; min-width: 200px; }
	@media (pointer: coarse) {
		.audio-settings select, .audio-settings .action-btn { min-height: 44px; }
		.audio-settings .toggle-btn { border-block-width: 8px !important; }
	}
</style>
