<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { PresenterOverlayTool } from '$lib/calling/presenterOverlay';
	import { PRESENTER_OVERLAY_COLORS, PRESENTER_OVERLAY_WIDTHS } from '$lib/calling/presenterOverlay';

	export let isMuted: boolean = false;
	export let isDeafened: boolean = false;
	export let isVideoOff: boolean = false;
	export let isSharing: boolean = false;
	export let canScreenShare: boolean = false;
	export let captureAvailable: boolean = false;
	export let captureBusy: boolean = false;
	export let callRecordingStatus: 'idle' | 'recording' | 'saving' | 'error' = 'idle';

	export let presenterOverlayVisible: boolean = false;
	export let presenterOverlayAvailable: boolean = false;
	export let presenterOverlayCanUndo: boolean = false;
	export let presenterOverlayCanRedo: boolean = false;
	export let presenterOverlayTool: PresenterOverlayTool = 'pen';
	export let presenterOverlayColor: string = PRESENTER_OVERLAY_COLORS[0];
	export let presenterOverlayStrokeWidth: number = PRESENTER_OVERLAY_WIDTHS[1];

	// Event handlers
	export let onToggleMute: () => void = () => {};
	export let onToggleDeafen: () => void = () => {};
	export let onToggleVideo: () => void = () => {};
	export let onToggleScreenShare: () => void = () => {};
	export let onTogglePresenterOverlay: () => void = () => {};
	export let onCaptureToWhiteboard: () => void = () => {};
	export let onOpenWhiteboard: () => void = () => {};
	export let onToggleRecording: () => void = () => {};
	export let onEndCall: () => void = () => {};

	// Device picker
	export let devices: {
		audioin: MediaDeviceInfo[];
		audioout: MediaDeviceInfo[];
		video: MediaDeviceInfo[];
	} | null = null;
	export let selectedAudioInputId: string | null = null;
	export let selectedAudioOutputId: string | null = null;
	export let onOpenDevicePicker: () => void = () => {};
	export let onSelectDevice: (kind: 'audioinput' | 'audiooutput', deviceId: string) => void = () => {};

	let devicePickerOpen = false;
	let devicePickerEl: HTMLDivElement | null = null;

	async function toggleDevicePicker() {
		if (devicePickerOpen) {
			devicePickerOpen = false;
			return;
		}
		onOpenDevicePicker();
		devicePickerOpen = true;
		await tick();
		devicePickerEl?.focus();
	}

	function closeDevicePicker() {
		devicePickerOpen = false;
	}

	function handleDeviceClick(kind: 'audioinput' | 'audiooutput', deviceId: string) {
		onSelectDevice(kind, deviceId);
	}

	function handleOutsideClick(event: MouseEvent) {
		if (!devicePickerEl) return;
		const target = event.target as Node;
		if (devicePickerEl.contains(target)) return;
		const gearBtn = devicePickerEl.previousElementSibling;
		if (gearBtn && gearBtn.contains(target)) return;
		closeDevicePicker();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') closeDevicePicker();
	}

	onMount(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('click', handleOutsideClick, true);
		return () => window.removeEventListener('click', handleOutsideClick, true);
	});

	function deviceLabel(device: MediaDeviceInfo, index: number): string {
		return device.label || `Device ${index + 1}`;
	}

	// Presenter overlay events
	export let onPresenterOverlayToolChange: (tool: PresenterOverlayTool) => void = () => {};
	export let onPresenterOverlayColorChange: (color: string) => void = () => {};
	export let onPresenterOverlayStrokeWidthChange: (width: number) => void = () => {};
	export let onPresenterOverlayUndo: () => void = () => {};
	export let onPresenterOverlayRedo: () => void = () => {};
	export let onPresenterOverlayClear: () => void = () => {};

	const presenterOverlayTools: PresenterOverlayTool[] = ['pen', 'arrow', 'rect', 'ellipse'];
</script>

<div class="call-controls">
	<div class="control-actions">
		<button
			class="control-btn"
			class:active={isMuted}
			on:click={onToggleMute}
			title={isMuted ? 'Unmute' : 'Mute'}
		>
			{#if isMuted}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
			{:else}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
			{/if}
		</button>

		<button
			class="control-btn"
			class:active={isDeafened}
			on:click={onToggleDeafen}
			title={isDeafened ? 'Undeafen' : 'Deafen'}
		>
			{#if isDeafened}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
			{:else}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
			{/if}
		</button>

		<button
			class="control-btn"
			class:active={!isVideoOff}
			on:click={onToggleVideo}
			title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
		</button>

		{#if canScreenShare}
			<button
				class="control-btn"
				class:active={isSharing}
				on:click={onToggleScreenShare}
				title={isSharing ? 'Stop sharing' : 'Share screen'}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
			</button>
		{/if}

		<button
			class="control-btn"
			class:active={presenterOverlayVisible}
			on:click={onTogglePresenterOverlay}
			disabled={!presenterOverlayAvailable}
			title="Toggle local presenter overlay"
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17c2.5-4 5.17-6 8-6 2.2 0 4.2 1.2 6 3.6"/><path d="M5 5l14 14"/><path d="M14 5H5v9"/></svg>
		</button>

		{#if canScreenShare}
			<button
				class="control-btn"
				class:active={captureAvailable}
				on:click={onCaptureToWhiteboard}
				disabled={!captureAvailable || captureBusy}
				title="Capture current shared frame to whiteboard"
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h4l2-2h4l2 2h4v10H4z"/><circle cx="12" cy="12" r="3.5"/></svg>
			</button>
		{/if}

		<button
			class="control-btn"
			on:click={onOpenWhiteboard}
			title="Open whiteboard for this call"
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<rect x="3" y="4" width="18" height="14" rx="2"></rect>
				<path d="M7 8h10"></path>
				<path d="M7 12h6"></path>
				<path d="M8 20h8"></path>
			</svg>
		</button>

		<button
			class="control-btn record"
			class:active={callRecordingStatus === 'recording'}
			class:is-saving={callRecordingStatus === 'saving'}
			on:click={onToggleRecording}
			title={callRecordingStatus === 'recording' ? 'Stop recording' : 'Start recording'}
		>
			<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="7"></circle></svg>
		</button>

		<button
			class="control-btn"
			class:active={devicePickerOpen}
			on:click={toggleDevicePicker}
			title="Audio & video settings"
			aria-haspopup="dialog"
			aria-expanded={devicePickerOpen}
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
		</button>

		<button class="control-btn end" on:click={onEndCall} title="Leave call">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
		</button>
	</div>

	{#if devicePickerOpen}
		<div
			class="device-picker"
			role="dialog"
			aria-label="Audio and video device settings"
			bind:this={devicePickerEl}
			on:keydown={handleKeydown}
			tabindex="-1"
		>
			{#if !devices}
				<p class="device-picker-empty">Loading devices…</p>
			{:else}
				<section class="device-group">
					<h4 class="device-group-title">Microphone</h4>
					{#if devices.audioin.length === 0}
						<p class="device-picker-empty">No input devices</p>
					{:else}
						{#each devices.audioin as device, index (device.deviceId)}
							<button
								class="device-option"
								class:is-selected={selectedAudioInputId === device.deviceId}
								on:click={() => handleDeviceClick('audioinput', device.deviceId)}
							>
								<span class="device-radio" aria-hidden="true"></span>
								<span class="device-label">{deviceLabel(device, index)}</span>
							</button>
						{/each}
					{/if}
				</section>

				<section class="device-group">
					<h4 class="device-group-title">Output</h4>
					{#if devices.audioout.length === 0}
						<p class="device-picker-empty">No output devices</p>
					{:else}
						{#each devices.audioout as device, index (device.deviceId)}
							<button
								class="device-option"
								class:is-selected={selectedAudioOutputId === device.deviceId}
								on:click={() => handleDeviceClick('audiooutput', device.deviceId)}
							>
								<span class="device-radio" aria-hidden="true"></span>
								<span class="device-label">{deviceLabel(device, index)}</span>
							</button>
						{/each}
					{/if}
				</section>
			{/if}
		</div>
	{/if}

	{#if presenterOverlayVisible && presenterOverlayAvailable}
		<div class="presenter-overlay-toolbar" role="toolbar" aria-label="Presenter overlay tools">
			<div class="presenter-overlay-group presenter-overlay-group--tools">
				<span class="presenter-overlay-label">Tools</span>
				{#each presenterOverlayTools as nextTool}
					<button
						class="presenter-overlay-btn"
						class:is-active={presenterOverlayTool === nextTool}
						on:click={() => onPresenterOverlayToolChange(nextTool)}
						title={`Use ${nextTool} tool`}
					>
						{nextTool}
					</button>
				{/each}
			</div>

			<div class="presenter-overlay-group">
				{#each PRESENTER_OVERLAY_WIDTHS as width}
					<button
						class="presenter-overlay-width"
						class:is-active={presenterOverlayStrokeWidth === width}
						on:click={() => onPresenterOverlayStrokeWidthChange(width)}
						title={`Set stroke width ${width}`}
					>
						{width}px
					</button>
				{/each}
			</div>

			<div class="presenter-overlay-group presenter-overlay-group--colors">
				{#each PRESENTER_OVERLAY_COLORS as color}
					<button
						class="presenter-overlay-swatch"
						class:is-active={presenterOverlayColor === color}
						style={`--overlay-color: ${color};`}
						on:click={() => onPresenterOverlayColorChange(color)}
						title={`Set overlay color ${color}`}
					></button>
				{/each}
			</div>

			<div class="presenter-overlay-group presenter-overlay-group--actions">
				<button
					class="presenter-overlay-btn"
					on:click={onPresenterOverlayUndo}
					disabled={!presenterOverlayCanUndo}
					title="Undo overlay"
				>
					Undo
				</button>
				<button
					class="presenter-overlay-btn"
					on:click={onPresenterOverlayRedo}
					disabled={!presenterOverlayCanRedo}
					title="Redo overlay"
				>
					Redo
				</button>
				<button
					class="presenter-overlay-btn danger"
					on:click={onPresenterOverlayClear}
					title="Clear current overlay"
				>
					Clear
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.call-controls {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		gap: 0.9rem;
		padding: 0.8rem;
		padding-bottom: calc(0.8rem + env(safe-area-inset-bottom, 0px));
		background: color-mix(in srgb, var(--surface-base, #111827) 90%, black 10%);
		border-top: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
	}

	.control-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.control-btn {
		width: 40px;
		height: 40px;
		border-radius: 999px;
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.14);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
		color: var(--text-inverse, var(--text-inverse, #fff));
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		flex-shrink: 0;
	}

	.control-btn svg {
		width: 17px;
		height: 17px;
		stroke: currentColor;
		flex-shrink: 0;
	}

	.control-btn.active {
		background: color-mix(in srgb, var(--accent, var(--accent-primary, var(--accent-primary-color))) 35%, transparent);
		border-color: color-mix(in srgb, var(--accent, var(--accent-primary, var(--accent-primary-color))) 65%, transparent);
	}

	.control-btn.record {
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.22);
		border-color: rgba(var(--color-danger-rgb, 248, 113, 113), 0.36);
		color: var(--accent-danger-soft, var(--accent-danger-soft, #fecaca));
	}

	.control-btn.record.active {
		background: rgba(var(--color-danger-rgb, 220, 38, 38), 0.46);
		border-color: rgba(var(--color-danger-rgb, 248, 113, 113), 0.72);
		color: var(--accent-danger-soft, var(--text-inverse, #fff));
	}

	.control-btn.record.is-saving {
		background: var(--color-warning, rgba(161, 98, 7, 0.26));
		border-color: rgba(var(--color-warning-rgb, 250, 204, 21), 0.52);
		color: var(--accent-warning-soft, #fef3c7);
	}

	.control-btn.end {
		background: var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.2));
		border-color: rgba(var(--color-danger-rgb, 239, 68, 68), 0.5);
		color: var(--color-danger, #fda4af);
	}

	.presenter-overlay-toolbar {
		width: min(100%, 980px);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.65rem;
		padding: 0.75rem 0.9rem;
		border-radius: 18px;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.88);
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
		box-shadow: 0 20px 45px rgba(var(--surface-app-rgb, 2, 6, 23), 0.28);
		backdrop-filter: blur(12px);
	}

	.presenter-overlay-group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
	}

	.presenter-overlay-group--tools {
		margin-right: 0.2rem;
	}

	.presenter-overlay-group--actions {
		margin-left: 0.2rem;
	}

	.presenter-overlay-label {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.76);
	}

	.presenter-overlay-btn,
	.presenter-overlay-width {
		padding: 0.42rem 0.7rem;
		border-radius: 999px;
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.14);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.06);
		color: rgba(var(--text-inverse-rgb, 241, 245, 249), 0.94);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: capitalize;
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
	}

	.presenter-overlay-btn:hover:not(:disabled),
	.presenter-overlay-width:hover:not(:disabled),
	.presenter-overlay-swatch:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.presenter-overlay-btn.is-active,
	.presenter-overlay-width.is-active {
		background: color-mix(in srgb, var(--accent, var(--accent-primary, var(--accent-primary-color))) 28%, rgba(var(--surface-app-rgb, 15, 23, 42), 0.82));
		border-color: color-mix(in srgb, var(--accent, var(--accent-primary, var(--accent-primary-color))) 64%, transparent);
		color: var(--text-inverse, var(--text-inverse, #fff));
	}

	.presenter-overlay-btn.danger {
		color: var(--accent-danger-soft, var(--accent-danger-soft, #fecaca));
		border-color: rgba(var(--color-danger-rgb, 248, 113, 113), 0.32);
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.22);
	}

	.presenter-overlay-btn:disabled,
	.presenter-overlay-width:disabled {
		cursor: not-allowed;
		opacity: 0.45;
		transform: none;
	}

	.presenter-overlay-group--colors {
		gap: 0.35rem;
	}

	.presenter-overlay-swatch {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		border: 2px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.18);
		background: var(--overlay-color, var(--text-inverse, var(--text-inverse, #f8fafc)));
		cursor: pointer;
		box-shadow: inset 0 0 0 1px rgba(var(--surface-app-rgb, 15, 23, 42), 0.26);
		transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
	}

	.presenter-overlay-swatch.is-active {
		border-color: var(--text-inverse, var(--text-inverse, #fff));
		box-shadow: 0 0 0 2px rgba(var(--text-inverse-rgb, 255, 255, 255), 0.16);
	}

	.presenter-overlay-swatch:disabled {
		cursor: not-allowed;
		opacity: 0.5;
		transform: none;
	}

	@media (max-width: 640px) {
		.presenter-overlay-toolbar {
			padding: 0.65rem 0.7rem;
			gap: 0.55rem;
		}

		.presenter-overlay-group--tools {
			width: 100%;
		}
	}
</style>
