<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { _ as t } from '$lib/i18n';
	import {
		audioProcessingRuntimeStatus,
		callTransportState,
		clearAudioPerformanceFallbackOverride,
		applyCurrentAudioProcessingToLocalTrack,
		refreshLocalAudioMuteState,
		refreshSpatialAudioRuntime,
		spatialAudioDiagnostics,
		spatialAudioRuntimeStatus
	} from '$lib/calling';
	import { refreshCallRecordingMix } from '$lib/callRecording';
	import {
		DESKTOP_HELPER_PROFILE_KEY,
		desktopHelperState,
		syncDesktopHelperService,
		type DesktopHelperProfileMode
	} from '$lib/desktopHelper';
	import {
		isExperimentalStdbCallEnabled,
		setExperimentalStdbCallEnabled
	} from '$lib/experimentalStdbCalls';
	import { getTauriPlatform } from '$lib/tauri-platform';
	import {
		getAudioCaptureConstraints,
		getBoosterRelayEffectiveMode,
		getBoosterRelayRequestedMode,
		isTauriRuntime,
		loadEffectiveMediaSettingsSnapshot,
		setAudioProcessingMode,
		setCallMuteBehavior,
		setCallRecordingStemMode,
		setCallTransportMode,
		setMediaQualityMode,
		setScreenShareQualityPreset,
		setScreenShareBitrateKbps,
		setSpatialAudioDistanceScale,
		setSpatialAudioEnabled,
		setSpatialAudioMasterStrength,
		setSpatialAudioMode,
		setSpatialAudioQuickToggleVisible,
		setSpatialAudioWarningMuted,
		setSrtGatewayEnabled,
		getPreferredMicDeviceId,
		setPreferredMicDeviceId,
		getPreferredCameraDeviceId,
		setPreferredCameraDeviceId,
		type AudioProcessingMode,
		type BoosterRelayMode,
		type CallMuteBehavior,
		type CallRecordingStemMode,
		type CallTransportMode,
		type MediaQualityMode,
		type ServerMediaRuntimeResponse,
		type ScreenShareQualityPreset,
		type SpatialAudioMode
	} from '$lib/mediaRuntime';

	// ── State ───────────────────────────────────────────────────────────
	let soundEnabled = true;
	let micEnabled = true;
	let cameraEnabled = true;
	let audioInputDevices: MediaDeviceInfo[] = [];
	let videoInputDevices: MediaDeviceInfo[] = [];
	let selectedMicDeviceId = '';
	let selectedCameraDeviceId = '';
	let mediaQualityMode: MediaQualityMode = 'web-baseline';
	let audioProcessingMode: AudioProcessingMode = 'auto';
	let spatialAudioEnabled = false;
	let spatialAudioMode: SpatialAudioMode = 'auto';
	let spatialAudioStrength = 0.85;
	let spatialAudioDistanceScale = 1;
	let spatialAudioWarningsMuted = false;
	let spatialAudioQuickToggleVisible = true;
	let screenShareQualityPreset: ScreenShareQualityPreset = 'auto';
	let screenShareBitrateKbps = 0;
	let callTransportMode: CallTransportMode = 'auto';
	let callMuteBehavior: CallMuteBehavior = 'mute-local-input';
	let callRecordingStemMode: CallRecordingStemMode = 'mixed-only';
	let srtGatewayEnabled = false;
	let localAppRuntime = false;
	let desktopLocalAppRuntime = false;
	let experimentalStdbCallsEnabled = false;
	let mediaRuntimeSnapshot: ServerMediaRuntimeResponse | null = null;
	let boosterRelayRequestedMode: BoosterRelayMode = 'off';
	let boosterRelayEffectiveMode: BoosterRelayMode = 'off';
	// mic test
	let micTestStream: MediaStream | null = null;
	let micTestRecorder: MediaRecorder | null = null;
	let micTestAudioContext: AudioContext | null = null;
	let micTestAnalyser: AnalyserNode | null = null;
	let micTestLevelInterval: number | null = null;
	let micTestAudioUrl: string | null = null;
	let micTestLevel = 0;
	let micTestState: 'idle' | 'recording' | 'ready' = 'idle';
	// desktop helper profile
	let desktopHelperProfileName = '';
	let desktopHelperProfileMode: DesktopHelperProfileMode = 'off';
	let desktopHelperProfileStatus = '';

	// ── Reactive ──────────────────────────────────────────────────────
	$: boosterRelayRequestedMode = getBoosterRelayRequestedMode(mediaRuntimeSnapshot);
	$: boosterRelayEffectiveMode = getBoosterRelayEffectiveMode(mediaRuntimeSnapshot);
	$: if ($desktopHelperState?.message && desktopLocalAppRuntime) {
		desktopHelperProfileStatus = $desktopHelperState.message;
	}

	// ── Helpers ───────────────────────────────────────────────────────
	function getBoosterRelayModeLabel(mode: BoosterRelayMode): string {
		switch (mode) {
			case 'turn-only':
				return 'TURN only';
			case 'turn-sfu':
				return 'TURN + SFU';
			case 'turn-sfu-gateway':
				return 'TURN + SFU + Gateway';
			default:
				return 'Off';
		}
	}

	function getBoosterRelayComponentsSummary(runtime: ServerMediaRuntimeResponse | null): string {
		const components = runtime?.media?.boosterRelay?.components;
		if (!components) return 'No booster relay components advertised.';
		return [
			`TURN ${components.turnConfigured ? 'ready' : 'off'}`,
			`SFU ${components.sfuConfigured ? 'ready' : 'off'}`,
			`Gateway ${
				components.gatewayConfigured
					? components.gatewayHealthy && components.gatewayMediaPlaneReady
						? 'ready'
						: 'starting'
					: 'off'
			}`
		].join(' | ');
	}

	function getBoosterRelaySelfAdvertisementSummary(
		runtime: ServerMediaRuntimeResponse | null
	): string {
		const advertisement = runtime?.media?.boosterRelay?.selfAdvertisement;
		if (!advertisement) return 'Self-advertised relay node: unknown.';
		if (!advertisement.advertised) {
			return 'Self-advertised relay node: not registered.';
		}
		const location = advertisement.url || '(missing URL)';
		const relayId = advertisement.relayId ? `, ID ${advertisement.relayId}` : '';
		return `Self-advertised relay node: ${advertisement.status || 'unknown'} at ${location}${relayId}.`;
	}

	function formatRuntimeTime(timestamp: number | null): string {
		if (!timestamp) return 'never';
		return new Date(timestamp).toLocaleTimeString();
	}

	function toggleSound() {
		soundEnabled = !soundEnabled;
		localStorage.setItem('soundEnabled', soundEnabled.toString());
	}

	function toggleMic() {
		micEnabled = !micEnabled;
		localStorage.setItem('micEnabled', micEnabled.toString());
	}

	function toggleCamera() {
		cameraEnabled = !cameraEnabled;
		localStorage.setItem('cameraEnabled', cameraEnabled.toString());
	}

	async function loadMediaDevices() {
		if (!browser || !navigator.mediaDevices?.enumerateDevices) return;
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			audioInputDevices = devices.filter((d) => d.kind === 'audioinput');
			videoInputDevices = devices.filter((d) => d.kind === 'videoinput');
		} catch {
			// permissions denied – lists stay empty
		}
	}

	function handleMicDeviceChange(deviceId: string) {
		selectedMicDeviceId = deviceId;
		setPreferredMicDeviceId(deviceId || null);
	}

	function handleCameraDeviceChange(deviceId: string) {
		selectedCameraDeviceId = deviceId;
		setPreferredCameraDeviceId(deviceId || null);
	}

	async function saveDesktopHelperProfile(): Promise<void> {
		if (!browser) return;
		const normalizedName = desktopHelperProfileName.trim();
		if (desktopHelperProfileMode !== 'off' && !normalizedName) {
			desktopHelperProfileStatus = 'Pick a helper name before using helper mode.';
			return;
		}
		try {
			localStorage.setItem(
				DESKTOP_HELPER_PROFILE_KEY,
				JSON.stringify({ name: normalizedName, mode: desktopHelperProfileMode })
			);
			desktopHelperProfileStatus =
				desktopHelperProfileMode === 'off'
					? 'Desktop helper profile saved. Helper mode stays off.'
					: 'Desktop helper profile saved. Activating desktop helper...';
			await syncDesktopHelperService();
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		} catch {
			desktopHelperProfileStatus = 'Failed to save desktop helper profile locally.';
		}
	}

	// ── update callbacks ──────────────────────────────────────────────
	function updateMediaQualityMode(mode: MediaQualityMode) {
		mediaQualityMode = mode;
		setMediaQualityMode(mode);
	}

	function updateAudioProcessingMode(mode: AudioProcessingMode) {
		audioProcessingMode = mode;
		setAudioProcessingMode(mode);
		clearAudioPerformanceFallbackOverride();
		void applyCurrentAudioProcessingToLocalTrack();
	}

	function updateCallTransportMode(mode: CallTransportMode) {
		callTransportMode = mode;
		setCallTransportMode(mode);
	}

	function updateCallMuteBehavior(mode: CallMuteBehavior) {
		callMuteBehavior = mode;
		setCallMuteBehavior(mode);
		refreshLocalAudioMuteState();
		refreshCallRecordingMix();
	}

	function updateCallRecordingStemMode(mode: CallRecordingStemMode) {
		callRecordingStemMode = mode;
		setCallRecordingStemMode(mode);
	}

	function toggleSrtGateway() {
		if (!localAppRuntime) return;
		srtGatewayEnabled = !srtGatewayEnabled;
		setSrtGatewayEnabled(srtGatewayEnabled);
	}

	function updateScreenShareQualityPreset(preset: ScreenShareQualityPreset) {
		screenShareQualityPreset = preset;
		setScreenShareQualityPreset(preset);
	}

	function updateScreenShareBitrateKbps(value: number) {
		screenShareBitrateKbps = value;
		setScreenShareBitrateKbps(value > 0 ? value : null);
	}

	// ── spatial audio ─────────────────────────────────────────────────
	function toggleSpatialAudio() {
		spatialAudioEnabled = !spatialAudioEnabled;
		setSpatialAudioEnabled(spatialAudioEnabled);
		refreshSpatialAudioRuntime();
	}

	function updateSpatialAudioMode(mode: SpatialAudioMode) {
		spatialAudioMode = mode;
		setSpatialAudioMode(mode);
		refreshSpatialAudioRuntime();
	}

	function updateSpatialAudioStrength(value: number) {
		spatialAudioStrength = value;
		setSpatialAudioMasterStrength(value);
		refreshSpatialAudioRuntime();
	}

	function updateSpatialAudioDistanceScale(value: number) {
		spatialAudioDistanceScale = value;
		setSpatialAudioDistanceScale(value);
		refreshSpatialAudioRuntime();
	}

	async function toggleExperimentalStdbCalls() {
		const next = !experimentalStdbCallsEnabled;
		experimentalStdbCallsEnabled = next;
		await setExperimentalStdbCallEnabled(next);
	}

	function toggleSpatialWarningsMuted() {
		spatialAudioWarningsMuted = !spatialAudioWarningsMuted;
		setSpatialAudioWarningMuted(spatialAudioWarningsMuted);
		refreshSpatialAudioRuntime();
	}

	function toggleSpatialQuickToggleVisible() {
		spatialAudioQuickToggleVisible = !spatialAudioQuickToggleVisible;
		setSpatialAudioQuickToggleVisible(spatialAudioQuickToggleVisible);
		refreshSpatialAudioRuntime();
	}

	// ── mic test ──────────────────────────────────────────────────────
	function cleanupMicTest() {
		if (micTestLevelInterval !== null) {
			clearInterval(micTestLevelInterval);
			micTestLevelInterval = null;
		}
		if (micTestRecorder && micTestRecorder.state !== 'inactive') {
			micTestRecorder.stop();
		}
		micTestRecorder = null;
		if (micTestStream) {
			micTestStream.getTracks().forEach((track) => track.stop());
			micTestStream = null;
		}
		if (micTestAudioContext) {
			void micTestAudioContext.close().catch(() => undefined);
			micTestAudioContext = null;
		}
		micTestAnalyser = null;
		micTestLevel = 0;
	}

	async function runMicTest() {
		cleanupMicTest();
		if (micTestAudioUrl) {
			URL.revokeObjectURL(micTestAudioUrl);
			micTestAudioUrl = null;
		}

		const chunks: Blob[] = [];
		micTestState = 'recording';

		try {
			micTestStream = await navigator.mediaDevices.getUserMedia({
				audio: getAudioCaptureConstraints(audioProcessingMode),
				video: false
			});

			micTestAudioContext = new AudioContext();
			const source = micTestAudioContext.createMediaStreamSource(micTestStream);
			micTestAnalyser = micTestAudioContext.createAnalyser();
			micTestAnalyser.fftSize = 1024;
			source.connect(micTestAnalyser);
			const data = new Uint8Array(micTestAnalyser.frequencyBinCount);
			micTestLevelInterval = window.setInterval(() => {
				if (!micTestAnalyser) return;
				micTestAnalyser.getByteTimeDomainData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i += 1) {
					const n = (data[i] - 128) / 128;
					sum += n * n;
				}
				const rms = Math.sqrt(sum / data.length);
				micTestLevel = Math.min(1, rms * 8);
			}, 80);

			micTestRecorder = new MediaRecorder(micTestStream);
			micTestRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			micTestRecorder.onstop = () => {
				const blob = new Blob(chunks, { type: micTestRecorder?.mimeType || 'audio/webm' });
				micTestAudioUrl = URL.createObjectURL(blob);
				micTestState = 'ready';
				cleanupMicTest();
			};
			micTestRecorder.start();
			setTimeout(() => {
				if (micTestRecorder && micTestRecorder.state === 'recording') {
					micTestRecorder.stop();
				}
			}, 4000);
		} catch (error) {
			console.error('Mic test failed:', error);
			micTestState = 'idle';
			cleanupMicTest();
			alert('Mic test failed. Please check microphone permissions.');
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────
	onMount(async () => {
		localAppRuntime = isTauriRuntime();
		desktopLocalAppRuntime = getTauriPlatform() === 'desktop';
		experimentalStdbCallsEnabled = isExperimentalStdbCallEnabled();

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

		// Desktop helper profile
		if (browser) {
			try {
				const raw = localStorage.getItem(DESKTOP_HELPER_PROFILE_KEY);
				if (raw) {
					const parsed = JSON.parse(raw) as { name?: string; mode?: DesktopHelperProfileMode };
					desktopHelperProfileName = typeof parsed.name === 'string' ? parsed.name : '';
					desktopHelperProfileMode =
						parsed.mode === 'files-only' || parsed.mode === 'desktop-assist' ? parsed.mode : 'off';
				}
			} catch {
				desktopHelperProfileName = '';
				desktopHelperProfileMode = 'off';
			}
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		}
	});

	onDestroy(() => {
		cleanupMicTest();
	});
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.audio')}</h3>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Sound Effects</span>
			<span class="setting-description">Play sounds for messages and notifications</span>
		</div>
		<button class="toggle-btn" class:active={soundEnabled} on:click={toggleSound}>
			{#if soundEnabled}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
			{/if}
		</button>
	</div>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Microphone</span>
			<span class="setting-description">Enable microphone for voice calls</span>
		</div>
		<button class="toggle-btn" class:active={micEnabled} on:click={toggleMic}>
			{#if micEnabled}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12m14 0a7 7 0 0 1-13.46 3.4"/></svg>
			{/if}
		</button>
	</div>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Camera</span>
			<span class="setting-description">Enable camera for video calls</span>
		</div>
		<button class="toggle-btn" class:active={cameraEnabled} on:click={toggleCamera}>
			{cameraEnabled ? $t('common.on') : $t('common.off')}
		</button>
	</div>
	{#if audioInputDevices.length > 0}
		<div class="quality-mode-row">
			<label for="mic-device-select">Microphone Device</label>
			<select
				id="mic-device-select"
				class="theme-select"
				value={selectedMicDeviceId}
				on:change={(e) => handleMicDeviceChange(e.currentTarget.value)}
			>
				<option value="">System Default</option>
				{#each audioInputDevices as device}
					<option value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 8)}`}</option>
				{/each}
			</select>
		</div>
	{/if}
	{#if videoInputDevices.length > 0}
		<div class="quality-mode-row">
			<label for="camera-device-select">Camera Device</label>
			<select
				id="camera-device-select"
				class="theme-select"
				value={selectedCameraDeviceId}
				on:change={(e) => handleCameraDeviceChange(e.currentTarget.value)}
			>
				<option value="">System Default</option>
				{#each videoInputDevices as device}
					<option value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 8)}`}</option>
				{/each}
			</select>
		</div>
	{/if}

	<div class="media-quality-notice" role="note">
		<div class="notice-title">Call Quality Runtime Notice</div>
		<div class="notice-body">
			{#if localAppRuntime}
				You are running the Local App runtime. Enhanced audio/video tuning is available, including optional SRT gateway controls.
			{:else}
				You are running Web runtime. Calls use compatibility-first media settings. For best audio quality, use the Local App.
			{/if}
		</div>

		<div class="quality-mode-row">
			<label for="audio-processing-mode">Audio Processing</label>
			<select
				id="audio-processing-mode"
				class="theme-select"
				value={audioProcessingMode}
				on:change={(e) => updateAudioProcessingMode(e.currentTarget.value as AudioProcessingMode)}
			>
				<option value="auto">Automatic (Recommended)</option>
				<option value="dsp">DSP (Low CPU)</option>
				<option value="rnn">RNN / Native Suppression</option>
				<option value="studio">Studio / Raw</option>
			</select>
		</div>
		{#if $audioProcessingRuntimeStatus.fallbackActive || $audioProcessingRuntimeStatus.reason}
			<div class="runtime-note">
				Effective mode: <strong>{$audioProcessingRuntimeStatus.effective.toUpperCase()}</strong>
				{#if $audioProcessingRuntimeStatus.reason === 'performance_guard'}
					(performance fallback)
				{:else if $audioProcessingRuntimeStatus.reason === 'native_not_supported'}
					(native suppression not supported on this runtime)
				{/if}
			</div>
		{/if}

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Spatial Audio</span>
				<span class="setting-description">Position call participants in stereo/3D space.</span>
			</div>
			<button class="toggle-btn" class:active={spatialAudioEnabled} on:click={toggleSpatialAudio}>
				{spatialAudioEnabled ? 'ON' : 'OFF'}
			</button>
		</div>

		<div class="quality-mode-row">
			<label for="spatial-audio-mode">Spatial Rendering</label>
			<select
				id="spatial-audio-mode"
				class="theme-select"
				value={spatialAudioMode}
				on:change={(e) => updateSpatialAudioMode(e.currentTarget.value as SpatialAudioMode)}
				disabled={!spatialAudioEnabled}
			>
				<option value="auto">Auto (Recommended)</option>
				<option value="pan_distance">Stereo Pan + Distance</option>
				<option value="full_3d">Full 3D (HRTF)</option>
				<option value="off">Off</option>
			</select>
		</div>

		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Spatial Strength</span>
				<span class="setting-description">{Math.round(spatialAudioStrength * 100)}%</span>
			</div>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				bind:value={spatialAudioStrength}
				on:input={(e) => updateSpatialAudioStrength(parseFloat(e.currentTarget.value))}
				class="volume-slider"
				disabled={!spatialAudioEnabled}
			/>
		</div>

		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Spatial Distance Scale</span>
				<span class="setting-description">{spatialAudioDistanceScale.toFixed(2)}x</span>
			</div>
			<input
				type="range"
				min="0.4"
				max="4"
				step="0.1"
				bind:value={spatialAudioDistanceScale}
				on:input={(e) => updateSpatialAudioDistanceScale(parseFloat(e.currentTarget.value))}
				class="volume-slider"
				disabled={!spatialAudioEnabled}
			/>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Mute Spatial Warnings</span>
				<span class="setting-description">Hide one-time fallback notices during calls.</span>
			</div>
			<button class="toggle-btn" class:active={spatialAudioWarningsMuted} on:click={toggleSpatialWarningsMuted}>
				{spatialAudioWarningsMuted ? 'ON' : 'OFF'}
			</button>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Show In-Call Spatial Toggle</span>
				<span class="setting-description">Display quick enable/disable button in call controls.</span>
			</div>
			<button class="toggle-btn" class:active={spatialAudioQuickToggleVisible} on:click={toggleSpatialQuickToggleVisible}>
				{spatialAudioQuickToggleVisible ? 'ON' : 'OFF'}
			</button>
		</div>

		{#if $spatialAudioRuntimeStatus.active || $spatialAudioRuntimeStatus.fallbackReason}
			<div class="runtime-note">
				Spatial runtime: <strong>{$spatialAudioRuntimeStatus.effectiveMode.toUpperCase()}</strong>
				{#if $spatialAudioRuntimeStatus.fallbackReason}
					({$spatialAudioRuntimeStatus.fallbackReason.replace('_', ' ')})
				{/if}
			</div>
		{/if}
		<div class="runtime-note">
			Spatial sources: <strong>{$spatialAudioDiagnostics.totalSources}</strong>
			(call {$spatialAudioDiagnostics.callSources}, share {$spatialAudioDiagnostics.shareSources})
		</div>
		<div class="runtime-note">
			Spatial seats: call {$spatialAudioDiagnostics.callSeatSlots}, share {$spatialAudioDiagnostics.shareSeatSlots}
			. Last sync {formatRuntimeTime($spatialAudioDiagnostics.lastUpdatedAt)}.
		</div>
		<div class="runtime-note">
			Transport runtime: <strong>{$callTransportState.activeTransport.toUpperCase()}</strong>
			(control plane {$callTransportState.gatewayControlPlaneStatus})
		</div>

		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Mic Test</span>
				<span class="setting-description">Record 4 seconds with the selected audio mode, then play it back.</span>
			</div>
			<button
				class="action-btn"
				on:click={runMicTest}
				disabled={micTestState === 'recording'}
			>
				{micTestState === 'recording' ? 'Recording...' : 'Record 4s Sample'}
			</button>
			<div class="volume-slider" aria-label="Mic input level">
				<div style="height: 8px; border-radius: 6px; background: var(--surface-base); overflow: hidden;">
					<div style="height: 100%; width: {Math.round(micTestLevel * 100)}%; background: var(--accent-primary); transition: width 80ms linear;"></div>
				</div>
			</div>
			{#if micTestAudioUrl}
				<audio src={micTestAudioUrl} controls></audio>
			{/if}
		</div>

		<div class="quality-mode-row">
			<label for="media-quality-mode">Media Quality Mode</label>
			<select
				id="media-quality-mode"
				class="theme-select"
				value={mediaQualityMode}
				on:change={(e) => updateMediaQualityMode(e.currentTarget.value as MediaQualityMode)}
			>
				<option value="web-baseline">Web Baseline</option>
				<option value="local-enhanced" disabled={!localAppRuntime}>Local App Enhanced</option>
			</select>
		</div>

		<div class="quality-mode-row">
			<label for="screen-share-quality">Screen Share Resolution</label>
			<select
				id="screen-share-quality"
				class="theme-select"
				value={screenShareQualityPreset}
				on:change={(e) => updateScreenShareQualityPreset(e.currentTarget.value as ScreenShareQualityPreset)}
			>
				<option value="auto">Auto (Recommended)</option>
				<option value="1080p">1080p</option>
				<option value="source-unbounded">Source (Unbounded Bitrate)</option>
				<option value="720p">720p</option>
				<option value="480p">480p</option>
				<option value="144p-mobile">144p (Mobile / Low data)</option>
			</select>
		</div>

		<div class="quality-mode-row">
			<label for="screen-share-bitrate-kbps">Screen Share Bitrate (kbps)</label>
			<input
				id="screen-share-bitrate-kbps"
				class="theme-select"
				type="number"
				min="0"
				max="200000"
				step="250"
				value={screenShareBitrateKbps}
				on:change={(e) => updateScreenShareBitrateKbps(parseInt(e.currentTarget.value || '0', 10) || 0)}
			/>
			<div class="runtime-note">Set `0` to use preset bitrate behavior. Any value above `0` is applied directly.</div>
		</div>

		<div class="quality-mode-row">
			<label for="call-transport-mode">Call Mode</label>
			<select
				id="call-transport-mode"
				class="theme-select"
				value={callTransportMode}
				on:change={(e) => updateCallTransportMode(e.currentTarget.value as CallTransportMode)}
			>
				<option value="p2p-only">P2P (Default)</option>
				<option value="sfu-preferred">SFU (Media Server)</option>
				<option value="stdb">SpacetimeDB</option>
			</select>
			<div class="runtime-note">
				P2P uses direct WebRTC between clients. SFU routes through a media server (requires server config). SpacetimeDB uses the experimental STDB call path.
			</div>
			{#if mediaRuntimeSnapshot && !mediaRuntimeSnapshot.media?.turn?.configured}
				<div class="runtime-note">
					TURN relay is not configured on this server right now. DM calls can fail across NAT, mobile, and home-network boundaries.
				</div>
			{/if}
			{#if mediaRuntimeSnapshot?.media?.boosterRelay}
				<div class="runtime-note">
					Server booster relay: requested {getBoosterRelayModeLabel(boosterRelayRequestedMode)}, effective {getBoosterRelayModeLabel(boosterRelayEffectiveMode)}.
				</div>
				<div class="runtime-note">{getBoosterRelayComponentsSummary(mediaRuntimeSnapshot)}</div>
				<div class="runtime-note">{getBoosterRelaySelfAdvertisementSummary(mediaRuntimeSnapshot)}</div>
				{#if mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement?.reason}
					<div class="runtime-note">
						{mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement.reason}
					</div>
				{/if}
				{#if boosterRelayRequestedMode !== 'off' && boosterRelayRequestedMode !== boosterRelayEffectiveMode}
					<div class="runtime-note">
						The deployment is asking for a heavier server-side relay mode than this runtime currently exposes. Start the matching compose profiles on the server machine.
					</div>
				{/if}
			{/if}
		</div>

		<div class="quality-mode-row">
			<label for="call-mute-behavior">Call Mute Behavior</label>
			<select
				id="call-mute-behavior"
				class="theme-select"
				value={callMuteBehavior}
				on:change={(e) => updateCallMuteBehavior(e.currentTarget.value as CallMuteBehavior)}
			>
				<option value="mute-local-input">Mute outbound + local recording (Default)</option>
				<option value="outbound-only">Mute outbound only</option>
			</select>
			<div class="runtime-note">
				Mute outbound only keeps your mic in local call recordings for VTuber/avatar workflows while still silencing what other participants hear.
			</div>
		</div>

		<div class="quality-mode-row">
			<label for="call-recording-stem-mode">Recording Outputs</label>
			<select
				id="call-recording-stem-mode"
				class="theme-select"
				value={callRecordingStemMode}
				on:change={(e) => updateCallRecordingStemMode(e.currentTarget.value as CallRecordingStemMode)}
			>
				<option value="mixed-only">Mixed recording only (Default)</option>
				<option value="mixed-plus-mic">Mixed + mic stem</option>
				<option value="mixed-plus-all-audio">Mixed + all live audio stems</option>
			</select>
			<div class="runtime-note">
				Extra stems add CPU load, file size, and save time. All-stems mode exports separate audio files for your mic and each live remote/share audio source that appears during the recording.
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Experimental SpaceChatDB STDB Calls</span>
				<span class="setting-description">Desktop-only experimental path for DM/group calls. Channel voice calls stay on standard routing.</span>
			</div>
			<button
				class="toggle-btn"
				class:active={experimentalStdbCallsEnabled}
				on:click={toggleExperimentalStdbCalls}
				disabled={!desktopLocalAppRuntime}
				title="Experimental desktop STDB routing for DM/group calls only"
			>
				{experimentalStdbCallsEnabled ? 'ON' : 'OFF'}
			</button>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">SRT Gateway</span>
				<span class="setting-description">Requires Local App + self-hosted media gateway with worker mode enabled. Browser-only calls do not use SRT directly.</span>
			</div>
			<button class="toggle-btn" class:active={srtGatewayEnabled} on:click={toggleSrtGateway} disabled={!localAppRuntime}>
				{srtGatewayEnabled ? 'ON' : 'OFF'}
			</button>
		</div>

		{#if desktopLocalAppRuntime}
			<div class="upload-limits-panel">
				<h4>Desktop Helper Profile</h4>
				<p class="admin-help">Pick the human-readable name this desktop should use before helper activation is turned on. This avoids exposing raw machine hostnames later.</p>
				<div class="quality-mode-row">
					<label for="desktop-helper-name">Helper Name</label>
					<input
						id="desktop-helper-name"
						class="emoji-name-input"
						maxlength="120"
						placeholder="Will Laptop"
						bind:value={desktopHelperProfileName}
					/>
				</div>
				<div class="quality-mode-row">
					<label for="desktop-helper-mode">Helper Mode</label>
					<select
						id="desktop-helper-mode"
						class="theme-select"
						bind:value={desktopHelperProfileMode}
					>
						<option value="off">Off</option>
						<option value="files-only">Files Only</option>
						<option value="desktop-assist">Desktop Assist</option>
					</select>
				</div>
				<button class="action-btn" on:click={saveDesktopHelperProfile}>
					Save Helper Profile
				</button>
				{#if desktopHelperProfileStatus}
					<p class="admin-help">{desktopHelperProfileStatus}</p>
				{/if}
			</div>
		{/if}

		{#if !localAppRuntime && browser}
			<p class="runtime-note">Tip: install the Local App (Tauri) to unlock enhanced call quality mode.</p>
		{/if}
	</div>
</div>
