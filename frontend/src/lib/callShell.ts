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
import { derived, writable, type Readable } from 'svelte/store';
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

/**
 * Why the call leaves center stage, and so how its panel closes. Navigation (a folio word, Ctrl K,
 * a channel, a DM, Server home, the DM hub, Connection details) is a plain close, the same as the
 * sidebar's text-channel click: the call can still come back by itself, for example when someone
 * starts sharing their screen. Only the call's own Minimize is the person dismissing it, which
 * keeps it down for the rest of that call (dismissChannelCallPanel).
 */
export type CallDockCause = 'navigation' | 'minimize';

export function dockCallPanel(
	cause: CallDockCause,
	panel: { close: () => void; dismiss?: () => void }
): 'closed' | 'dismissed' {
	if (cause === 'minimize' && panel.dismiss) {
		panel.dismiss();
		return 'dismissed';
	}
	panel.close();
	return 'closed';
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

/**
 * The note under the call header that says who is recording (§8.5, §9.5). The names come from the
 * recording presence echo; until it arrives your own recording is named by its state: "starting"
 * only before the readout has counted a second, then "You're recording", so the note never says
 * "starting" beside a running timer (local-only or offline recordings get no echo at all).
 */
export function recordingNoteWords(
	status: 'idle' | 'recording' | 'saving' | 'error',
	elapsedMs: number,
	presenceWords: string
): string {
	if (status === 'saving') return 'Recording has stopped. Saving locally on this device.';
	if (presenceWords) return presenceWords;
	if (status !== 'recording') return '';
	return Number.isFinite(elapsedMs) && elapsedMs >= 1000
		? "You're recording. Everyone in this call can see it."
		: 'Recording is starting. Everyone in this call can see it.';
}

/**
 * The call foot and the call dock can sit in the window's bottom-right corner on phones, where the
 * global connection badge lives. Each publishes how far it rises from the bottom of the window
 * there; the badge stays clear of the highest one (ConnectionBadge.svelte).
 */
export const CORNER_BADGE_ZONE = { width: 160, height: 36 } as const;

type Box = { left: number; top: number; right: number; bottom: number };

/** How far `rect` rises from the window bottom when it reaches into the badge's corner, else 0. */
export function cornerClearance(
	rect: Box,
	viewport: { width: number; height: number },
	zone: { width: number; height: number } = CORNER_BADGE_ZONE
): number {
	if (!(rect.right > rect.left && rect.bottom > rect.top)) return 0;
	const reachesCorner = rect.right > viewport.width - zone.width && rect.bottom > viewport.height - zone.height;
	const onScreen = rect.top < viewport.height && rect.left < viewport.width;
	return reachesCorner && onScreen ? Math.max(0, Math.ceil(viewport.height - rect.top)) : 0;
}

const cornerBars = writable<ReadonlyMap<symbol, number>>(new Map());

/** The highest call bar in the badge's corner, in px from the window bottom (0: none). */
export const callCornerClearance: Readable<number> = derived(cornerBars, (bars) => Math.max(0, ...bars.values()));

/** Publish one bar's corner clearance (0 withdraws it). */
export function reportCornerBar(key: symbol, clearance: number): void {
	cornerBars.update((bars) => {
		if ((bars.get(key) ?? 0) === clearance) return bars;
		const next = new Map(bars);
		if (clearance > 0) next.set(key, clearance);
		else next.delete(key);
		return next;
	});
}

/**
 * Svelte action for a call bar (the call foot, the dock): measures where it sits and keeps its
 * corner clearance published while it is mounted. A bar moves when the box it is placed in
 * changes size (the stage, the call room going full window), so those few ancestors are watched
 * as well as the bar itself and the window.
 */
export function cornerBar(node: HTMLElement) {
	const key = Symbol('call-corner-bar');
	let frame = 0;
	const measure = () => {
		frame = 0;
		const box = node.getBoundingClientRect();
		reportCornerBar(key, cornerClearance(box, { width: window.innerWidth, height: window.innerHeight }));
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(measure);
	};
	const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
	observer?.observe(node);
	for (let box = node.parentElement, depth = 0; box && depth < 3; box = box.parentElement, depth += 1) observer?.observe(box);
	window.addEventListener('resize', schedule);
	// The bar's entrance moves it (translate) without resizing it: measure again where it lands.
	node.addEventListener('animationend', schedule);
	node.addEventListener('transitionend', schedule);
	schedule();
	return {
		destroy() {
			if (frame) cancelAnimationFrame(frame);
			observer?.disconnect();
			window.removeEventListener('resize', schedule);
			node.removeEventListener('animationend', schedule);
			node.removeEventListener('transitionend', schedule);
			reportCornerBar(key, 0);
		}
	};
}

/**
 * The More menu opens from a key inside the dock pill (6px padding + its hairline), so it keeps
 * a 14px gap from the key: it clears the pill's edge by 7px instead of touching it (§7.4, §7.26).
 */
export const DOCK_MENU_GAP = 14;

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
		icon: 'record',
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
