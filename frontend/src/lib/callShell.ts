/**
 * The embedded call shell and its dock (design contract §7.26, §8.5, §8.12): the plain words,
 * the stage arithmetic and the dock layout, kept out of the components so they can be tested.
 *
 * - The header names the room and counts people ("8 people"); connection trouble is said in
 *   plain words ("Reconnecting…"), never as a lifecycle enum or a transport name.
 * - The audio stage is a centered grid of 88px stamps, at most four rows, then "and N more".
 * - The dock keeps Mic and Sound on the bar everywhere; Camera and Share screen join them on
 *   desktop, and on phones they move into More, so the dock is Mic, Sound, More, Leave and fits
 *   a 390px screen. Everything else (draw, capture, whiteboard, recording, devices) is in More.
 */
import type { IconName } from './components/ui/icons';
import type { ConnectionLifecycleState } from './callingTypes';

/** "1 person" / "8 people" (the header count, §8.5). */
export function peopleCountLabel(count: number): string {
	const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
	return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** Connection trouble in plain words; null while connected or idle (nothing to say). */
export function connectionWords(state: ConnectionLifecycleState | null | undefined): string | null {
	switch (state) {
		case 'signaling':
		case 'connecting':
			return 'Connecting…';
		case 'reconnecting':
			return 'Reconnecting…';
		case 'failed':
			return 'Connection failed';
		case 'disconnected':
			return 'Disconnected';
		default:
			return null;
	}
}

/** A channel session's lifecycle in the same terms, so the header uses one vocabulary. */
export function sessionConnectionState(
	lifecycle: 'joining' | 'connected' | 'reconnecting' | 'failed' | 'ended' | null | undefined
): ConnectionLifecycleState {
	switch (lifecycle) {
		case 'joining':
			return 'connecting';
		case 'reconnecting':
			return 'reconnecting';
		case 'failed':
			return 'failed';
		default:
			return 'connected';
	}
}

export type VoiceStateWord = 'Speaking' | 'Muted' | 'Listening';

/** The word under a stamp: a ring alone never carries the state (§10). */
export function voiceStateWord(person: {
	isSpeaking?: boolean;
	isMuted?: boolean;
	isListenOnly?: boolean;
}): VoiceStateWord | null {
	if (person.isMuted) return 'Muted';
	if (person.isSpeaking) return 'Speaking';
	if (person.isListenOnly) return 'Listening';
	return null;
}

/** Stage grid cell: an 88px stamp in a 120px column, 24px apart, four rows at most (§8.5). */
export const STAMP_CELL = 120;
export const STAMP_GAP = 24;
export const STAMP_ROWS = 4;

/** How many stamp columns fit a stage of `width` px (always at least one). */
export function stampColumns(width: number, cell = STAMP_CELL, gap = STAMP_GAP): number {
	if (!Number.isFinite(width) || width <= 0) return 1;
	return Math.max(1, Math.floor((width + gap) / (cell + gap)));
}

/**
 * The stamps that fit `rows` rows of `columns`; when someone does not fit, the last cell becomes
 * "and N more" (so the grid never grows a fifth row).
 */
export function visibleStamps<T>(
	people: readonly T[],
	columns: number,
	rows = STAMP_ROWS
): { shown: T[]; more: number } {
	const capacity = Math.max(1, Math.floor(columns)) * Math.max(1, Math.floor(rows));
	if (people.length <= capacity) return { shown: people.slice(), more: 0 };
	const shown = people.slice(0, Math.max(0, capacity - 1));
	return { shown, more: people.length - shown.length };
}

/**
 * Center stage owns the selected workspace (layout contract). While the call covers the stage
 * (embedded below the masthead, or full window), the place it opened over is remembered; choosing
 * another one (a folio word, Ctrl K, a channel, Open whiteboard) docks the call so the stage shows
 * what was chosen instead of the folio naming one workspace while the call hides it.
 * `place` is any stable key for what center stage shows (workspace view, channel, DM).
 */
export function followPlaceUnderCall(
	remembered: string | null,
	place: string,
	covering: boolean
): { remembered: string | null; dock: boolean } {
	if (!covering) return { remembered: null, dock: false };
	if (remembered === null || remembered === place) return { remembered: place, dock: false };
	return { remembered: null, dock: true };
}

/** The minimized call's region name, without saying "Call" twice ("Call with Theo Park"). */
export function minimizedCallLabel(title: string): string {
	return /\bcall\b/i.test(title) ? title : `Call: ${title}`;
}

/** What a finished recording left, in plain words: never a file path or a raw error (§7.16). */
export function recordingResultWords(state: {
	status: 'idle' | 'recording' | 'saving' | 'error';
	savedFileCount?: number;
	savedPath?: string | null;
	lastError?: string | null;
}): string {
	if (state.status === 'recording') return '';
	if (state.status === 'saving') return 'Saving recording…';
	if (state.status === 'error') return 'Recording failed. Nothing was saved.';
	const files = state.savedFileCount ?? 0;
	if (files > 1) return `Recording saved on this device · ${files} files`;
	if (files === 1 || state.savedPath) return 'Recording saved on this device';
	return '';
}

/** A failed "Capture frame to whiteboard": the cause and what is unchanged (§7.16). */
export const CAPTURE_FAILED_WORDS = "Couldn't capture the frame. Nothing was added to the whiteboard.";

/** "Recording 02:14" for your own recording, "Recording" when someone else records (§8.5, §9.5). */
export function recordingReadout(
	status: 'idle' | 'recording' | 'saving' | 'error',
	elapsed: string,
	othersRecording: number
): string {
	if (status === 'saving') return 'Saving recording…';
	if (status === 'recording') return `Recording ${elapsed}`;
	if (othersRecording > 0) return 'Recording';
	return '';
}

export type DockControl = 'mic' | 'sound' | 'camera' | 'screen';

/** The toggles on the dock bar itself; the rest live in More. Phones keep only Mic and Sound. */
export function dockBarControls(compact: boolean, canScreenShare: boolean): DockControl[] {
	if (compact) return ['mic', 'sound'];
	return canScreenShare ? ['mic', 'sound', 'camera', 'screen'] : ['mic', 'sound', 'camera'];
}

/** A row of the dock's More menu (structurally a ContextMenu `MenuEntry`). */
export type DockMenuEntry = {
	id: string;
	label?: string;
	type?: 'action' | 'separator' | 'kicker';
	icon?: IconName;
	role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
	checked?: boolean;
	disabled?: boolean;
	hidden?: boolean;
	hint?: string;
	onSelect?: () => void;
};

export type DockMenuState = {
	compact: boolean;
	isVideoOff: boolean;
	isSharing: boolean;
	canScreenShare: boolean;
	presenterOverlayVisible: boolean;
	presenterOverlayAvailable: boolean;
	captureAvailable: boolean;
	captureBusy: boolean;
	callRecordingStatus: 'idle' | 'recording' | 'saving' | 'error';
};

export type DockMenuActions = {
	onToggleVideo: () => void;
	onToggleScreenShare: () => void;
	onTogglePresenterOverlay: () => void;
	onCaptureToWhiteboard: () => void;
	onOpenWhiteboard: () => void;
	onToggleRecording: () => void;
	onOpenDevices: () => void;
};

/** The More menu: what is not on the bar, in one predictable order, every capability kept. */
export function dockMoreItems(state: DockMenuState, actions: DockMenuActions): DockMenuEntry[] {
	const items: DockMenuEntry[] = [];
	if (state.compact) {
		items.push({
			id: 'camera',
			label: 'Camera',
			icon: state.isVideoOff ? 'videoOff' : 'video',
			role: 'menuitemcheckbox',
			checked: !state.isVideoOff,
			onSelect: actions.onToggleVideo
		});
		if (state.canScreenShare) {
			items.push({
				id: 'screen',
				label: 'Share screen',
				icon: 'screen',
				role: 'menuitemcheckbox',
				checked: state.isSharing,
				onSelect: actions.onToggleScreenShare
			});
		}
		items.push({ id: 'sep-share', type: 'separator' });
	}
	items.push({
		id: 'draw',
		label: 'Draw on shared screen',
		// Not 'pencil': next to Open whiteboard's pencil-and-line glyph the two read as one (§6).
		icon: 'palette',
		role: 'menuitemcheckbox',
		checked: state.presenterOverlayVisible,
		disabled: !state.presenterOverlayAvailable,
		hint: state.presenterOverlayAvailable ? 'Only on your screen' : 'Needs a shared screen',
		onSelect: actions.onTogglePresenterOverlay
	});
	if (state.canScreenShare) {
		items.push({
			id: 'capture',
			label: state.captureBusy ? 'Capturing frame…' : 'Capture frame to whiteboard',
			icon: 'image',
			disabled: !state.captureAvailable || state.captureBusy,
			hint: state.captureAvailable ? undefined : 'Needs a shared screen',
			onSelect: actions.onCaptureToWhiteboard
		});
	}
	items.push({ id: 'whiteboard', label: 'Open whiteboard', icon: 'whiteboard', onSelect: actions.onOpenWhiteboard });
	items.push({ id: 'sep-record', type: 'separator' });
	items.push({
		id: 'record',
		label:
			state.callRecordingStatus === 'saving'
				? 'Saving recording…'
				: state.callRecordingStatus === 'recording'
					? 'Stop recording'
					: 'Start recording',
		role: 'menuitemcheckbox',
		checked: state.callRecordingStatus === 'recording',
		disabled: state.callRecordingStatus === 'saving',
		hint: state.callRecordingStatus === 'recording' ? undefined : 'Everyone in the call sees it',
		onSelect: actions.onToggleRecording
	});
	items.push({ id: 'devices', label: 'Microphone and speakers…', icon: 'sliders', onSelect: actions.onOpenDevices });
	return items;
}

/** Registry glyph for a media device row (the device label stays the words). */
export function deviceIcon(visual: 'headset' | 'microphone' | 'speaker' | 'camera'): IconName {
	return visual === 'headset' ? 'headphones' : visual === 'speaker' ? 'voice' : visual === 'camera' ? 'video' : 'mic';
}
