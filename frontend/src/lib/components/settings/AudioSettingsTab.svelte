<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { _ as t } from '$lib/i18n';
	import { audioProcessingRuntimeStatus, callTransportState, clearAudioPerformanceFallbackOverride, applyCurrentAudioProcessingToLocalTrack, refreshLocalAudioMuteState, refreshSpatialAudioRuntime, spatialAudioDiagnostics, spatialAudioRuntimeStatus } from '$lib/calling';
	import { refreshCallRecordingMix } from '$lib/callRecording';
	import { DESKTOP_HELPER_PROFILE_KEY, desktopHelperState, syncDesktopHelperService, type DesktopHelperProfileMode } from '$lib/desktopHelper';
	import { isExperimentalWabidbCallEnabled, setExperimentalWabidbCallEnabled } from '$lib/experimentalWabidbCalls';
	import { getTauriPlatform } from '$lib/tauri-platform';
	import { AudioCaptureOwner } from '$lib/audioCaptureOwner';
	import { createAudioCaptureSession, disposeAudioCaptureSession } from '$lib/audioCapture';
	import { getBoosterRelayEffectiveMode, getBoosterRelayRequestedMode, isTauriRuntime, loadEffectiveMediaSettingsSnapshot, setAudioProcessingMode, setCallMuteBehavior, setCallRecordingStemMode, setCallTransportMode, setMediaQualityMode, setScreenShareQualityPreset, setScreenShareBitrateKbps, setSpatialAudioDistanceScale, setSpatialAudioEnabled, setSpatialAudioMasterStrength, setSpatialAudioMode, setSpatialAudioQuickToggleVisible, setSpatialAudioWarningMuted, setSrtGatewayEnabled, getPreferredMicDeviceId, setPreferredMicDeviceId, getPreferredCameraDeviceId, setPreferredCameraDeviceId, type AudioProcessingMode, type BoosterRelayMode, type CallMuteBehavior, type CallRecordingStemMode, type CallTransportMode, type MediaQualityMode, type ServerMediaRuntimeResponse, type ScreenShareQualityPreset, type SpatialAudioMode } from '$lib/mediaRuntime';

	let soundEnabled = $state(true);
	let micEnabled = $state(true);
	let cameraEnabled = $state(true);
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
	let experimentalWabidbCallsEnabled = $state(false);
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
	function toggleSound() { soundEnabled = !soundEnabled; localStorage.setItem('soundEnabled', soundEnabled.toString()); }
	function toggleMic() { micEnabled = !micEnabled; localStorage.setItem('micEnabled', micEnabled.toString()); }
	function toggleCamera() { cameraEnabled = !cameraEnabled; localStorage.setItem('cameraEnabled', cameraEnabled.toString()); }
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
	async function toggleExperimentalWabidbCalls() { const next = !experimentalWabidbCallsEnabled; experimentalWabidbCallsEnabled = next; await setExperimentalWabidbCallEnabled(next); }
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
		experimentalWabidbCallsEnabled = isExperimentalWabidbCallEnabled();
		if (browser) {
			soundEnabled = localStorage.getItem('soundEnabled') !== 'false';
			micEnabled = localStorage.getItem('micEnabled') !== 'false';
			cameraEnabled = localStorage.getItem('cameraEnabled') !== 'false';
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

<div class="settings-section">
	<h3>{$t('settings.sections.audio')}</h3>
	<div class="setting-item">
		<div class="setting-info"><span class="setting-label">Sound Effects</span><span class="setting-description">Message & call sounds.</span></div>
		<button class="toggle-btn" class:active={soundEnabled} onclick={toggleSound}>{#if soundEnabled}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>{:else}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>{/if}</button>
	</div>
	<div class="setting-item">
		<div class="setting-info"><span class="setting-label">Microphone</span><span class="setting-description">Allow mic in calls.</span></div>
		<button class="toggle-btn" class:active={micEnabled} onclick={toggleMic}>{#if micEnabled}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>{:else}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12m14 0a7 7 0 0 1-13.46 3.4"/></svg>{/if}</button>
	</div>
	<div class="setting-item">
		<div class="setting-info"><span class="setting-label">Camera</span><span class="setting-description">Allow camera in calls.</span></div>
		<button class="toggle-btn" class:active={cameraEnabled} onclick={toggleCamera}></button>
	</div>
	{#if audioInputDevices.length > 0}
		<div class="quality-mode-row"><label for="mic-device-select">Microphone Device</label><select id="mic-device-select" class="theme-select" value={selectedMicDeviceId} onchange={(e) => handleMicDeviceChange(e.currentTarget.value)}><option value="">System Default</option>{#each audioInputDevices as device}<option value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 8)}`}</option>{/each}</select></div>
	{/if}
	{#if videoInputDevices.length > 0}
		<div class="quality-mode-row"><label for="camera-device-select">Camera Device</label><select id="camera-device-select" class="theme-select" value={selectedCameraDeviceId} onchange={(e) => handleCameraDeviceChange(e.currentTarget.value)}><option value="">System Default</option>{#each videoInputDevices as device}<option value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 8)}`}</option>{/each}</select></div>
	{/if}

	<div class="media-quality-notice" role="note">
		<div class="notice-title">Call quality</div>
		<div class="notice-body">{#if localAppRuntime}Local App — enhanced A/V + optional SRT.{:else}Web runtime — use Local App for best call quality.{/if}</div>
		<div class="quality-mode-row"><label for="audio-processing-mode">Audio Processing</label><select id="audio-processing-mode" class="theme-select" value={audioProcessingMode} onchange={(e) => updateAudioProcessingMode(e.currentTarget.value as AudioProcessingMode)}><option value="auto">Automatic (Recommended)</option><option value="dsp">DSP (Low CPU)</option><option value="rnn">RNN / Native Suppression</option><option value="studio">Studio / Raw</option></select></div>
		{#if $audioProcessingRuntimeStatus.fallbackActive || $audioProcessingRuntimeStatus.reason}<div class="runtime-note">Effective mode: <strong>{$audioProcessingRuntimeStatus.effective.toUpperCase()}</strong>{#if $audioProcessingRuntimeStatus.reason === 'performance_guard'}(performance fallback){:else if $audioProcessingRuntimeStatus.reason === 'native_not_supported'}(native suppression not supported on this runtime){/if}</div>{/if}
		<div class="setting-item"><div class="setting-info"><span class="setting-label">Spatial Audio</span><span class="setting-description">Stereo / 3D seating in calls.</span></div><button class="toggle-btn" class:active={spatialAudioEnabled} onclick={toggleSpatialAudio}></button></div>
		<div class="quality-mode-row"><label for="spatial-audio-mode">Spatial Rendering</label><select id="spatial-audio-mode" class="theme-select" value={spatialAudioMode} onchange={(e) => updateSpatialAudioMode(e.currentTarget.value as SpatialAudioMode)} disabled={!spatialAudioEnabled}><option value="auto">Auto (Recommended)</option><option value="pan_distance">Stereo Pan + Distance</option><option value="full_3d">Full 3D (HRTF)</option><option value="off">Off</option></select></div>
		<div class="setting-item-full"><div class="setting-info"><span class="setting-label">Spatial Strength</span><span class="setting-description">{Math.round(spatialAudioStrength * 100)}%</span></div><input type="range" min="0" max="1" step="0.05" bind:value={spatialAudioStrength} oninput={(e) => updateSpatialAudioStrength(parseFloat(e.currentTarget.value))} class="volume-slider" disabled={!spatialAudioEnabled} /></div>
		<div class="setting-item-full"><div class="setting-info"><span class="setting-label">Spatial Distance Scale</span><span class="setting-description">{spatialAudioDistanceScale.toFixed(2)}x</span></div><input type="range" min="0.4" max="4" step="0.1" bind:value={spatialAudioDistanceScale} oninput={(e) => updateSpatialAudioDistanceScale(parseFloat(e.currentTarget.value))} class="volume-slider" disabled={!spatialAudioEnabled} /></div>
		<div class="setting-item"><div class="setting-info"><span class="setting-label">Mute Spatial Warnings</span><span class="setting-description">Hide spatial fallback toasts.</span></div><button class="toggle-btn" class:active={spatialAudioWarningsMuted} onclick={toggleSpatialWarningsMuted}></button></div>
		<div class="setting-item"><div class="setting-info"><span class="setting-label">Show In-Call Spatial Toggle</span><span class="setting-description">Button on the call bar.</span></div><button class="toggle-btn" class:active={spatialAudioQuickToggleVisible} onclick={toggleSpatialQuickToggleVisible}></button></div>
		{#if $spatialAudioRuntimeStatus.active || $spatialAudioRuntimeStatus.fallbackReason}<div class="runtime-note">Spatial runtime: <strong>{$spatialAudioRuntimeStatus.effectiveMode.toUpperCase()}</strong>{#if $spatialAudioRuntimeStatus.fallbackReason}({$spatialAudioRuntimeStatus.fallbackReason.replace('_', ' ')}){/if}</div>{/if}
		<div class="runtime-note">Spatial sources: <strong>{$spatialAudioDiagnostics.totalSources}</strong>(call {$spatialAudioDiagnostics.callSources}, share {$spatialAudioDiagnostics.shareSources})</div>
		<div class="runtime-note">Spatial seats: call {$spatialAudioDiagnostics.callSeatSlots}, share {$spatialAudioDiagnostics.shareSeatSlots}. Last sync {formatRuntimeTime($spatialAudioDiagnostics.lastUpdatedAt)}.</div>
		<div class="runtime-note">Transport runtime: <strong>{$callTransportState.activeTransport.toUpperCase()}</strong></div>
		<div class="setting-item-full"><div class="setting-info"><span class="setting-label">Mic Test</span><span class="setting-description">Record 4 seconds with the selected audio mode, then play it back.</span></div><button class="action-btn" onclick={runMicTest} disabled={micTestState === 'recording'}>{micTestState === 'recording' ? 'Recording...' : 'Record 4s Sample'}</button><div class="volume-slider" aria-label="Mic input level"><div style="height: 8px; border-radius: 6px; background: var(--surface-base); overflow: hidden;"><div style="height: 100%; width: {Math.round(micTestLevel * 100)}%; background: var(--accent-primary-color); transition: width 80ms linear;"></div></div></div>{#if micTestAudioUrl}<audio src={micTestAudioUrl} controls></audio>{/if}</div>
		<div class="quality-mode-row"><label for="media-quality-mode">Media Quality Mode</label><select id="media-quality-mode" class="theme-select" value={mediaQualityMode} onchange={(e) => updateMediaQualityMode(e.currentTarget.value as MediaQualityMode)}><option value="web-baseline">Web Baseline</option><option value="local-enhanced" disabled={!localAppRuntime}>Local App Enhanced</option></select></div>
		<div class="quality-mode-row"><label for="screen-share-quality">Screen Share Resolution</label><select id="screen-share-quality" class="theme-select" value={screenShareQualityPreset} onchange={(e) => updateScreenShareQualityPreset(e.currentTarget.value as ScreenShareQualityPreset)}><option value="auto">Auto (Recommended)</option><option value="1080p">1080p</option><option value="source-unbounded">Source (Unbounded Bitrate)</option><option value="720p">720p</option><option value="480p">480p</option><option value="144p-mobile">144p (Mobile / Low data)</option></select></div>
		<div class="quality-mode-row"><label for="screen-share-bitrate-kbps">Screen Share Bitrate (kbps)</label><input id="screen-share-bitrate-kbps" class="theme-select" type="number" min="0" max="200000" step="250" value={screenShareBitrateKbps} onchange={(e) => updateScreenShareBitrateKbps(parseInt(e.currentTarget.value || '0', 10) || 0)} /><div class="runtime-note">Set `0` to use preset bitrate behavior. Any value above `0` is applied directly.</div></div>
		<div class="quality-mode-row"><label for="call-transport-mode">Call Mode</label><select id="call-transport-mode" class="theme-select" value={callTransportMode} onchange={(e) => updateCallTransportMode(e.currentTarget.value as CallTransportMode)}><option value="auto">Auto (Default — local relay, falls back to P2P)</option><option value="p2p-only">P2P only (direct, no fallback)</option><option value="sfu-preferred">SFU preferred (falls back to relay, then P2P)</option><option value="wabidb">Local relay only (no fallback)</option></select><div class="runtime-note">Auto: server relay first, P2P if it fails. P2P-only: direct browser-to-browser (needs TURN across NAT). SFU: LiveKit media server when the host provides one. Local relay: never leaves your server.</div>{#if mediaRuntimeSnapshot && !mediaRuntimeSnapshot.media?.turn?.configured}<div class="runtime-note">TURN relay is not configured on this server right now. DM calls can fail across NAT, mobile, and home-network boundaries.</div>{/if}{#if mediaRuntimeSnapshot?.media?.boosterRelay}<div class="runtime-note">Server booster relay: requested {getBoosterRelayModeLabel(boosterRelayRequestedMode)}, effective {getBoosterRelayModeLabel(boosterRelayEffectiveMode)}.</div><div class="runtime-note">{getBoosterRelayComponentsSummary(mediaRuntimeSnapshot)}</div><div class="runtime-note">{getBoosterRelaySelfAdvertisementSummary(mediaRuntimeSnapshot)}</div>{#if mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement?.reason}<div class="runtime-note">{mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement.reason}</div>{/if}{#if boosterRelayRequestedMode !== 'off' && boosterRelayRequestedMode !== boosterRelayEffectiveMode}<div class="runtime-note">The deployment is asking for a heavier server-side relay mode than this runtime currently exposes. Start the matching compose profiles on the server machine.</div>{/if}{/if}</div>
		<div class="quality-mode-row"><label for="call-mute-behavior">Call Mute Behavior</label><select id="call-mute-behavior" class="theme-select" value={callMuteBehavior} onchange={(e) => updateCallMuteBehavior(e.currentTarget.value as CallMuteBehavior)}><option value="mute-local-input">Mute outbound + local recording (Default)</option><option value="outbound-only">Mute outbound only</option></select><div class="runtime-note">Outbound-only mute keeps mic in local recordings.</div></div>
		<div class="quality-mode-row"><label for="call-recording-stem-mode">Recording Outputs</label><select id="call-recording-stem-mode" class="theme-select" value={callRecordingStemMode} onchange={(e) => updateCallRecordingStemMode(e.currentTarget.value as CallRecordingStemMode)}><option value="mixed-only">Mixed recording only (Default)</option><option value="mixed-plus-mic">Mixed + mic stem</option><option value="mixed-plus-all-audio">Mixed + all live audio stems</option></select><div class="runtime-note">Extra stems = more CPU/disk. All-stems splits every live source.</div></div>
		<div class="setting-item"><div class="setting-info"><span class="setting-label">wabiDB Call Relay</span><span class="setting-description">Uses database relay for all calls (default). P2P/TURN used only as fallback.</span></div><button class="toggle-btn" class:active={experimentalWabidbCallsEnabled} onclick={toggleExperimentalWabidbCalls} disabled={!desktopLocalAppRuntime} title="Database relay for DM/group calls; P2P/TURN as fallback."></button></div>
		<div class="setting-item"><div class="setting-info"><span class="setting-label">SRT Gateway</span><span class="setting-description">Local App + gateway workers only.</span></div><button class="toggle-btn" class:active={srtGatewayEnabled} onclick={toggleSrtGateway} disabled={!localAppRuntime}></button></div>
		{#if desktopLocalAppRuntime}
			<div class="upload-limits-panel">
				<h4>Desktop Helper Profile</h4>
				<p class="admin-help">Friendly name before helper activation (no raw hostname).</p>
				<div class="quality-mode-row"><label for="desktop-helper-name">Helper Name</label><input id="desktop-helper-name" class="emoji-name-input" maxlength="120" placeholder="Will Laptop" bind:value={desktopHelperProfileName} /></div>
				<div class="quality-mode-row"><label for="desktop-helper-mode">Helper Mode</label><select id="desktop-helper-mode" class="theme-select" bind:value={desktopHelperProfileMode}><option value="off">Off</option><option value="files-only">Files Only</option><option value="desktop-assist">Desktop Assist</option></select></div>
				<button class="action-btn" onclick={saveDesktopHelperProfile}>Save Helper Profile</button>
				{#if desktopHelperProfileStatus}<p class="admin-help">{desktopHelperProfileStatus}</p>{/if}
			</div>
		{/if}
		{#if !localAppRuntime && browser}<p class="runtime-note">Tip: install the Local App (Tauri) to unlock enhanced call quality mode.</p>{/if}
	</div>
</div>
