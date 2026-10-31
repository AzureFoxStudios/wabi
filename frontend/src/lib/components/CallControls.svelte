<!--
	The call dock (design contract §7.26, §8.12): one floating pill at the bottom centre of the call.
	- Desktop bar: Mic, Sound, Camera, Share screen, More, a hairline, then "Leave" (danger,
	  labelled). Phones (the compact dock): Mic, Sound, More, Leave, and it never clips.
	- Toggles keep one name and report their state with aria-pressed; a muted mic shows the
	  mic-off glyph in --w-danger.
	- More (one menu, a bottom sheet on phones) holds what is not on the bar: Camera and Share
	  screen on phones, then Draw on shared screen, Capture frame to whiteboard, Open whiteboard,
	  Start / Stop recording, Microphone and speakers… (dockMoreItems in $lib/callShell).
	- Above the dock, in this order: the capture feedback line, the drawing tools while drawing,
	  and the Microphone and speakers popover.
-->
<script module lang="ts">
	let dockCounter = 0;
</script>

<script lang="ts">
	import { deviceVisual } from '$lib/deviceVisuals';
	import { onMount, tick } from 'svelte';
	import type { PresenterOverlayTool } from '$lib/calling/presenterOverlay';
	import { PRESENTER_OVERLAY_COLORS, PRESENTER_OVERLAY_WIDTHS } from '$lib/calling/presenterOverlay';
	import { cornerBar, deviceIcon, dockBarControls, dockMoreItems, DOCK_MENU_GAP } from '$lib/callShell';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';
	import Segmented from './ui/Segmented.svelte';
	import Tooltip from './ui/Tooltip.svelte';

	/** The phone dock: only Mic, Sound, More and Leave sit on the bar. */
	export let compact: boolean = false;
	/** One line of feedback from a dock action ("Captured frame queued for the whiteboard."). */
	export let feedback: string = '';

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

	// Presenter overlay events
	export let onPresenterOverlayToolChange: (tool: PresenterOverlayTool) => void = () => {};
	export let onPresenterOverlayColorChange: (color: string) => void = () => {};
	export let onPresenterOverlayStrokeWidthChange: (width: number) => void = () => {};
	export let onPresenterOverlayUndo: () => void = () => {};
	export let onPresenterOverlayRedo: () => void = () => {};
	export let onPresenterOverlayClear: () => void = () => {};

	const dockId = `call-dock-${++dockCounter}`;
	const moreTriggerId = `${dockId}-more`;
	// The drawing tool and line width are kit segmented controls (one Tab stop, ←/→ choose).
	const toolOptions: { value: PresenterOverlayTool; label: string }[] = [
		{ value: 'pen', label: 'Pen' },
		{ value: 'arrow', label: 'Arrow' },
		{ value: 'rect', label: 'Box' },
		{ value: 'ellipse', label: 'Ellipse' }
	];
	const widthOptions = PRESENTER_OVERLAY_WIDTHS.map((width) => ({ value: width, label: `${width} px` }));

	let devicePickerOpen = false;
	let devicePickerEl: HTMLDivElement | null = null;

	$: barControls = dockBarControls(compact, canScreenShare);
	$: moreItems = dockMoreItems(
		{
			compact,
			isVideoOff,
			isSharing,
			canScreenShare,
			presenterOverlayVisible,
			presenterOverlayAvailable,
			captureAvailable,
			captureBusy,
			callRecordingStatus
		},
		{
			onToggleVideo,
			onToggleScreenShare,
			onTogglePresenterOverlay,
			onCaptureToWhiteboard,
			onOpenWhiteboard,
			onToggleRecording,
			onOpenDevices: openDevicePicker
		}
	);
	// The More key shows a dot while something inside it is on (camera on a phone, drawing, recording).
	$: moreHasActive =
		presenterOverlayVisible ||
		callRecordingStatus === 'recording' ||
		(compact && (!isVideoOff || isSharing));

	async function openDevicePicker() {
		onOpenDevicePicker();
		devicePickerOpen = true;
		await tick();
		devicePickerEl?.focus();
	}

	function closeDevicePicker(restoreFocus = false) {
		devicePickerOpen = false;
		if (restoreFocus) document.getElementById(moreTriggerId)?.focus();
	}

	function handleDeviceClick(kind: 'audioinput' | 'audiooutput', deviceId: string) {
		onSelectDevice(kind, deviceId);
	}

	function openAudioSettings() {
		devicePickerOpen = false;
		window.dispatchEvent(new CustomEvent('wabi:open-settings', { detail: { tab: 'audio' } }));
	}

	function handleOutsideClick(event: MouseEvent) {
		if (!devicePickerOpen || !devicePickerEl) return;
		if (devicePickerEl.contains(event.target as Node)) return;
		closeDevicePicker();
	}

	function handlePickerKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		closeDevicePicker(true);
	}

	onMount(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('click', handleOutsideClick, true);
		return () => window.removeEventListener('click', handleOutsideClick, true);
	});

	function deviceLabel(device: MediaDeviceInfo, index: number): string {
		return device.label || `Device ${index + 1}`;
	}
</script>

<div class="call-dock-wrap" class:call-dock-wrap--compact={compact}>
	{#if feedback}
		<p class="call-dock-feedback" role="status">{feedback}</p>
	{/if}

	{#if presenterOverlayVisible && presenterOverlayAvailable}
		<div class="presenter-overlay-toolbar" role="group" aria-label="Drawing tools, only on your screen">
			<Segmented
				label="Tool"
				options={toolOptions}
				value={presenterOverlayTool}
				onchange={onPresenterOverlayToolChange}
			/>
			<Segmented
				label="Line width"
				options={widthOptions}
				value={presenterOverlayStrokeWidth}
				onchange={onPresenterOverlayStrokeWidthChange}
			/>
			<div class="presenter-overlay-swatches" role="group" aria-label="Color">
				{#each PRESENTER_OVERLAY_COLORS as color, index}
					<button
						type="button"
						class="presenter-overlay-swatch"
						aria-pressed={presenterOverlayColor === color}
						aria-label={`Color ${index + 1}`}
						style={`--overlay-color: ${color};`}
						on:click={() => onPresenterOverlayColorChange(color)}
					></button>
				{/each}
			</div>
			<span class="presenter-overlay-sep" aria-hidden="true"></span>
			<button
				type="button"
				class="w-ibtn w-ibtn--sm"
				on:click={onPresenterOverlayUndo}
				disabled={!presenterOverlayCanUndo}
				aria-label="Undo drawing"
				title="Undo drawing"
			><Icon name="undo" size={16} /></button>
			<button
				type="button"
				class="w-ibtn w-ibtn--sm"
				on:click={onPresenterOverlayRedo}
				disabled={!presenterOverlayCanRedo}
				aria-label="Redo drawing"
				title="Redo drawing"
			><Icon name="redo" size={16} /></button>
			<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={onPresenterOverlayClear}>Clear</button>
		</div>
	{/if}

	{#if devicePickerOpen}
		<div
			class="device-picker"
			role="dialog"
			aria-labelledby={`${dockId}-devices`}
			bind:this={devicePickerEl}
			on:keydown={handlePickerKeydown}
			tabindex="-1"
		>
			<div class="device-picker__head">
				<h3 class="device-picker__title" id={`${dockId}-devices`}>Microphone and speakers</h3>
				<button
					type="button"
					class="w-ibtn w-ibtn--sm"
					aria-label="Close"
					title="Close"
					on:click={() => closeDevicePicker(true)}
				><Icon name="x" size={16} /></button>
			</div>
			{#if !devices}
				<p class="device-picker-empty" role="status">Looking for devices…</p>
			{:else}
				<!-- Toggle buttons (aria-pressed): choosing a row switches the device, so arrow keys must
				     not switch it while you browse. -->
				<div class="device-group" role="group" aria-labelledby={`${dockId}-mics`}>
					<span class="device-group-title w-kicker" id={`${dockId}-mics`}>Microphone</span>
					{#if devices.audioin.length === 0}
						<p class="device-picker-empty">No microphone found</p>
					{:else}
						{#each devices.audioin as device, index (device.deviceId)}
							<button
								type="button"
								class="device-option"
								aria-pressed={selectedAudioInputId === device.deviceId}
								on:click={() => handleDeviceClick('audioinput', device.deviceId)}
							>
								<Icon name={deviceIcon(deviceVisual(device.kind, device.label))} size={16} />
								<span class="device-label">{deviceLabel(device, index)}</span>
								<span class="device-check" aria-hidden="true"><Icon name="check" size={16} /></span>
							</button>
						{/each}
					{/if}
				</div>

				<div class="device-group" role="group" aria-labelledby={`${dockId}-outs`}>
					<span class="device-group-title w-kicker" id={`${dockId}-outs`}>Speakers</span>
					{#if devices.audioout.length === 0}
						<p class="device-picker-empty">No choice of speakers on this device</p>
					{:else}
						{#each devices.audioout as device, index (device.deviceId)}
							<button
								type="button"
								class="device-option"
								aria-pressed={selectedAudioOutputId === device.deviceId}
								on:click={() => handleDeviceClick('audiooutput', device.deviceId)}
							>
								<Icon name={deviceIcon(deviceVisual(device.kind, device.label))} size={16} />
								<span class="device-label">{deviceLabel(device, index)}</span>
								<span class="device-check" aria-hidden="true"><Icon name="check" size={16} /></span>
							</button>
						{/each}
					{/if}
				</div>
			{/if}
			<div class="device-picker__foot">
				<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={openAudioSettings}>Audio settings</button>
			</div>
		</div>
	{/if}

	<!-- `call-controls` and the Leave key's `end` class are the hooks the audio smoke harness
	     (test/call-panel-browser-harness.ts) clicks; data-call-leave is the stable one. No style
	     uses them. -->
	<div class="call-dock call-controls" id={dockId} role="group" aria-label="Call controls" use:cornerBar>
		{#each barControls as control (control)}
			{#if control === 'mic'}
				<Tooltip text={isMuted ? 'Unmute microphone' : 'Mute microphone'} placement="top">
					<button
						type="button"
						class="w-ibtn call-dock__btn call-dock__mic"
						aria-label="Mute microphone"
						aria-pressed={isMuted}
						on:click={onToggleMute}
					><Icon name={isMuted ? 'micOff' : 'mic'} /></button>
				</Tooltip>
			{:else if control === 'sound'}
				<Tooltip text={isDeafened ? 'Turn sound back on' : 'Deafen'} placement="top">
					<button
						type="button"
						class="w-ibtn call-dock__btn call-dock__sound"
						aria-label="Deafen"
						aria-pressed={isDeafened}
						on:click={onToggleDeafen}
					><Icon name={isDeafened ? 'headphonesOff' : 'headphones'} /></button>
				</Tooltip>
			{:else if control === 'camera'}
				<Tooltip text={isVideoOff ? 'Turn camera on' : 'Turn camera off'} placement="top">
					<button
						type="button"
						class="w-ibtn call-dock__btn"
						aria-label="Camera"
						aria-pressed={!isVideoOff}
						on:click={onToggleVideo}
					><Icon name={isVideoOff ? 'videoOff' : 'video'} /></button>
				</Tooltip>
			{:else if control === 'screen'}
				<Tooltip text={isSharing ? 'Stop sharing your screen' : 'Share your screen'} placement="top">
					<button
						type="button"
						class="w-ibtn call-dock__btn"
						aria-label="Share screen"
						aria-pressed={isSharing}
						on:click={onToggleScreenShare}
					><Icon name="screen" /></button>
				</Tooltip>
			{/if}
		{/each}
		<Tooltip text="More call controls" placement="top">
		<Menu
			id={moreTriggerId}
			items={moreItems}
			label="More call controls"
			triggerLabel="More"
			heading={compact ? 'Call controls' : null}
			class={moreHasActive ? 'w-ibtn call-dock__btn w-ibtn--dot' : 'w-ibtn call-dock__btn'}
			align={compact ? 'end' : 'start'}
			gap={DOCK_MENU_GAP}
		>
			<Icon name="more" />
		</Menu>
		</Tooltip>
		<span class="call-dock__sep" aria-hidden="true"></span>
		<button type="button" class="w-btn w-btn--danger call-dock__leave end" data-call-leave on:click={onEndCall}
			><Icon name="phoneOff" />Leave</button
		>
	</div>
</div>
