import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CAPTURE_FAILED_WORDS,
	connectionWords,
	deviceIcon,
	dockBarControls,
	dockMoreItems,
	followPlaceUnderCall,
	minimizedCallLabel,
	peopleCountLabel,
	recordingReadout,
	recordingResultWords,
	sessionConnectionState,
	stampColumns,
	visibleStamps,
	voiceStateWord,
	type DockMenuState
} from './callShell';
import { isIconName } from './components/ui/icons';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), 'utf8');

const noop = () => {};
const actions = {
	onToggleVideo: noop,
	onToggleScreenShare: noop,
	onTogglePresenterOverlay: noop,
	onCaptureToWhiteboard: noop,
	onOpenWhiteboard: noop,
	onToggleRecording: noop,
	onOpenDevices: noop
};
const base: DockMenuState = {
	compact: false,
	isVideoOff: true,
	isSharing: false,
	canScreenShare: true,
	presenterOverlayVisible: false,
	presenterOverlayAvailable: false,
	captureAvailable: false,
	captureBusy: false,
	callRecordingStatus: 'idle'
};

describe('call header words', () => {
	test('counts people in words', () => {
		expect(peopleCountLabel(1)).toBe('1 person');
		expect(peopleCountLabel(8)).toBe('8 people');
		expect(peopleCountLabel(0)).toBe('0 people');
		expect(peopleCountLabel(Number.NaN)).toBe('0 people');
	});

	test('says connection trouble in plain words, never the lifecycle enum', () => {
		expect(connectionWords('connected')).toBeNull();
		expect(connectionWords('idle')).toBeNull();
		expect(connectionWords(null)).toBeNull();
		expect(connectionWords('connecting')).toBe('Connecting…');
		expect(connectionWords('signaling')).toBe('Connecting…');
		expect(connectionWords('reconnecting')).toBe('Reconnecting…');
		expect(connectionWords('failed')).toBe('Connection failed');
		for (const state of ['connecting', 'signaling', 'reconnecting', 'failed', 'disconnected'] as const) {
			expect(connectionWords(state)).not.toBe(state);
		}
	});

	test('a channel session lifecycle uses the same words', () => {
		expect(connectionWords(sessionConnectionState('joining'))).toBe('Connecting…');
		expect(connectionWords(sessionConnectionState('reconnecting'))).toBe('Reconnecting…');
		expect(connectionWords(sessionConnectionState('failed'))).toBe('Connection failed');
		expect(connectionWords(sessionConnectionState('connected'))).toBeNull();
		expect(connectionWords(sessionConnectionState(null))).toBeNull();
	});

	test('recording readout is the same words for everyone, with the time for the recorder', () => {
		expect(recordingReadout('recording', '02:14', 0)).toBe('Recording 02:14');
		expect(recordingReadout('idle', '00:00', 2)).toBe('Recording');
		expect(recordingReadout('saving', '00:00', 0)).toBe('Saving recording…');
		expect(recordingReadout('idle', '00:00', 0)).toBe('');
		expect(recordingReadout('recording', '02:14', 0)).not.toMatch(/REC/);
	});

	test('after a recording: plain words, never the file path or the raw error', () => {
		const path = '/home/mira/Recordings/call-2026-10-30.webm';
		expect(recordingResultWords({ status: 'idle', savedFileCount: 1, savedPath: path })).toBe('Recording saved on this device');
		expect(recordingResultWords({ status: 'idle', savedFileCount: 0, savedPath: path })).toBe('Recording saved on this device');
		expect(recordingResultWords({ status: 'idle', savedFileCount: 3, savedPath: path })).toBe('Recording saved on this device · 3 files');
		const failed = recordingResultWords({ status: 'error', lastError: 'NotAllowedError: Permission denied', savedPath: path });
		expect(failed).toBe('Recording failed. Nothing was saved.');
		for (const words of [failed, recordingResultWords({ status: 'idle', savedFileCount: 1, savedPath: path })]) {
			expect(words).not.toContain(path);
			expect(words).not.toMatch(/Error|Permission/);
		}
		expect(recordingResultWords({ status: 'saving', savedFileCount: 0 })).toBe('Saving recording…');
		expect(recordingResultWords({ status: 'recording', savedFileCount: 0 })).toBe('');
		expect(recordingResultWords({ status: 'idle', savedFileCount: 0 })).toBe('');
		expect(CAPTURE_FAILED_WORDS).toMatch(/Nothing was added to the whiteboard/);
	});

	test('the minimized call is named without saying "Call" twice', () => {
		expect(minimizedCallLabel('Call with Theo Park')).toBe('Call with Theo Park');
		expect(minimizedCallLabel('Group call')).toBe('Group call');
		expect(minimizedCallLabel('Book club')).toBe('Call: Book club');
	});
});

describe('center stage owns the selected workspace', () => {
	test('the place the call opened over is remembered while it covers the stage', () => {
		expect(followPlaceUnderCall(null, 'voice|general|', true)).toEqual({ remembered: 'voice|general|', dock: false });
		expect(followPlaceUnderCall('voice|general|', 'voice|general|', true)).toEqual({ remembered: 'voice|general|', dock: false });
	});

	test('choosing another workspace, channel or DM docks the call', () => {
		// Folio "Chat" while the call covers Calls, "My Planner", a sidebar channel, a DM in center stage.
		for (const next of ['messages|general|', 'planner|general|', 'voice|random|', 'voice|general|dm-1']) {
			expect(followPlaceUnderCall('voice|general|', next, true)).toEqual({ remembered: null, dock: true });
		}
	});

	test('a docked or closed call forgets the place, so reopening it over any workspace keeps it open', () => {
		expect(followPlaceUnderCall('voice|general|', 'planner|general|', false)).toEqual({ remembered: null, dock: false });
		// Reopened (sidebar voice room, second click) while My Planner is on stage: it stays.
		const reopened = followPlaceUnderCall(null, 'planner|general|', true);
		expect(reopened).toEqual({ remembered: 'planner|general|', dock: false });
		expect(followPlaceUnderCall(reopened.remembered, 'planner|general|', true).dock).toBe(false);
	});
});

describe('audio stage', () => {
	test('a stamp under a ring always carries a word', () => {
		expect(voiceStateWord({ isSpeaking: true })).toBe('Speaking');
		expect(voiceStateWord({ isMuted: true, isSpeaking: true })).toBe('Muted');
		expect(voiceStateWord({ isListenOnly: true })).toBe('Listening');
		expect(voiceStateWord({})).toBeNull();
	});

	test('columns follow the stage width, never below one', () => {
		expect(stampColumns(0)).toBe(1);
		expect(stampColumns(100)).toBe(1);
		expect(stampColumns(120)).toBe(1);
		expect(stampColumns(264)).toBe(2);
		expect(stampColumns(1150)).toBe(8);
	});

	test('four rows at most, then the last cell says how many more', () => {
		const people = Array.from({ length: 9 }, (_, i) => i);
		expect(visibleStamps(people, 8)).toEqual({ shown: people, more: 0 });
		const crowd = Array.from({ length: 40 }, (_, i) => i);
		const { shown, more } = visibleStamps(crowd, 8);
		expect(shown).toHaveLength(31);
		expect(more).toBe(9);
		expect(shown.length + 1).toBe(8 * 4);
		expect(visibleStamps(crowd, 1)).toEqual({ shown: [0, 1, 2], more: 37 });
	});
});

describe('call dock', () => {
	test('phones keep Mic and Sound on the bar and move Camera and Share screen into More', () => {
		expect(dockBarControls(true, true)).toEqual(['mic', 'sound']);
		expect(dockBarControls(false, true)).toEqual(['mic', 'sound', 'camera', 'screen']);
		expect(dockBarControls(false, false)).toEqual(['mic', 'sound', 'camera']);
		const phone = dockMoreItems({ ...base, compact: true }, actions).map((item) => item.id);
		expect(phone.slice(0, 2)).toEqual(['camera', 'screen']);
		const desktop = dockMoreItems(base, actions).map((item) => item.id);
		expect(desktop).not.toContain('camera');
		expect(desktop).not.toContain('screen');
	});

	test('More keeps every capability, in one order, with toggles reporting their state', () => {
		const items = dockMoreItems({ ...base, presenterOverlayAvailable: true, captureAvailable: true }, actions);
		expect(items.filter((item) => item.type !== 'separator').map((item) => item.id)).toEqual([
			'draw',
			'capture',
			'whiteboard',
			'record',
			'devices'
		]);
		const record = items.find((item) => item.id === 'record');
		expect(record?.role).toBe('menuitemcheckbox');
		expect(record?.checked).toBe(false);
		for (const item of items) if (item.icon) expect(isIconName(item.icon)).toBe(true);
		// One meaning per glyph (§6): drawing on the screen and the whiteboard do not share a glyph.
		const glyphs = items.filter((item) => item.icon).map((item) => item.icon);
		expect(new Set(glyphs).size).toBe(glyphs.length);
		expect(items.find((item) => item.id === 'draw')?.icon).not.toBe('pencil');
	});

	test('unavailable tools stay listed, disabled, with the reason', () => {
		const items = dockMoreItems(base, actions);
		const draw = items.find((item) => item.id === 'draw');
		expect(draw?.disabled).toBe(true);
		expect(draw?.hint).toBe('Needs a shared screen');
		expect(items.find((item) => item.id === 'capture')?.disabled).toBe(true);
		// The drawing is a local overlay: the menu says so instead of implying others see it.
		const drawable = dockMoreItems({ ...base, presenterOverlayAvailable: true }, actions).find((item) => item.id === 'draw');
		expect(drawable?.disabled).toBe(false);
		expect(drawable?.hint).toBe('Only on your screen');
		const recording = dockMoreItems({ ...base, callRecordingStatus: 'recording' }, actions).find((item) => item.id === 'record');
		expect(recording?.label).toBe('Stop recording');
		expect(recording?.checked).toBe(true);
		const saving = dockMoreItems({ ...base, callRecordingStatus: 'saving' }, actions).find((item) => item.id === 'record');
		expect(saving?.disabled).toBe(true);
		expect(dockMoreItems({ ...base, canScreenShare: false }, actions).some((item) => item.id === 'capture')).toBe(false);
	});

	test('device rows use registry glyphs, not emoji', () => {
		for (const visual of ['headset', 'microphone', 'speaker', 'camera'] as const) {
			expect(isIconName(deviceIcon(visual))).toBe(true);
		}
	});
});

describe('call shell markup (member UI)', () => {
	const modal = read('components/CallModal.svelte');
	const controls = read('components/CallControls.svelte');
	const stage = read('components/CallStage.svelte');
	const debugPanel = read('components/CallDebugPanel.svelte');

	test('no developer instruments or transport jargon in member UI', () => {
		for (const source of [modal, controls, stage]) {
			expect(source).not.toMatch(/>\s*Diag\s*</);
			expect(source).not.toMatch(/<strong>Spatial Debug<\/strong>/);
			expect(source).not.toMatch(/Transport: \{/);
			expect(source).not.toMatch(/Connection: \{\$connectionState\}/);
			expect(source).not.toMatch(/Speaking: \$\{/);
		}
		expect(modal).not.toMatch(/<details class="call-diagnostics"/);
	});

	test('developer overlays render only in dev builds', () => {
		expect(modal).toMatch(/const isDevBuild = import\.meta\.env\.DEV/);
		expect(modal).toMatch(/\{#if isDevBuild && showSpatialDebugOverlay/);
		expect(debugPanel).toMatch(/const isDevBuild = import\.meta\.env\.DEV/);
		expect(debugPanel).toMatch(/\{#if open && isDevBuild\}/);
	});

	test('dock toggles report their state and Leave is a labelled danger button', () => {
		expect(controls).toMatch(/aria-pressed=\{isMuted\}/);
		expect(controls).toMatch(/aria-pressed=\{isDeafened\}/);
		expect(controls).toMatch(/aria-pressed=\{!isVideoOff\}/);
		expect(controls).toMatch(/aria-pressed=\{isSharing\}/);
		expect(controls).toMatch(/class="w-btn w-btn--danger call-dock__leave[^"]*"[\s\S]{0,200}>Leave</);
		expect(controls).not.toMatch(/text-inverse/);
	});

	test('the audio smoke harness finds the real Leave control', () => {
		const harness = read('../../test/call-panel-browser-harness.ts');
		expect(controls).toMatch(/<button[^>]*class="[^"]*\bcall-dock__leave\b[^"]*"[^>]*data-call-leave/);
		if (harness.includes('.call-controls button.end')) {
			// Back-compat hooks until the harness clicks [data-call-leave].
			expect(controls).toMatch(/class="call-dock call-controls"/);
			expect(controls).toMatch(/class="w-btn w-btn--danger call-dock__leave end"/);
		}
	});

	test('choice groups follow the ARIA pattern: kit segmented controls or toggle buttons', () => {
		// No hand-rolled role=radio keys (every key its own Tab stop, no arrow keys).
		expect(controls).not.toMatch(/role="radio"/);
		expect(controls).toMatch(/<Segmented\s+label="Tool"/);
		expect(controls).toMatch(/<Segmented\s+label="Line width"/);
		expect(controls).toMatch(/aria-pressed=\{presenterOverlayColor === color\}/);
		expect(controls).toMatch(/aria-pressed=\{selectedAudioInputId === device\.deviceId\}/);
		expect(controls).toMatch(/aria-pressed=\{selectedAudioOutputId === device\.deviceId\}/);
	});

	test('choosing another place docks the call; Connection details are one tap from Call options', () => {
		expect(modal).toMatch(/import \{ activeWorkspaceView \} from '\$lib\/workspaceNavigationState'/);
		expect(modal).toMatch(/\$: stagePlace = `\$\{\$activeWorkspaceView\}\|\$\{\$currentChannel/);
		expect(modal).toMatch(/\$: followStagePlace\(showCallShell, stagePlace\)/);
		expect(modal).toMatch(/if \(next\.dock\) minimizeToDocked\(\)/);
		expect(modal).toMatch(/\$: followConnectionDetails\(\$callConnectionDetailsOpen\)/);
		expect(modal).toMatch(/id: 'connection-details',\s*label: 'Connection details',\s*icon: 'signal',\s*onSelect: openConnectionDetails/);
	});

	test('the call follows the stage under a held peek (inert with .chat-surface)', () => {
		expect(modal).toMatch(/use:followStageInert=\{callViewportMode === 'embedded'\}/);
		expect(modal).toMatch(/class="docked-bar"[^>]*use:followStageInert=\{true\}/);
		expect(modal).toMatch(/attributeFilter: \['inert'\]/);
	});

	test('one recording readout, plain-word results, no raw errors or paths', () => {
		// The header shows the same readout as the minimized card; the legacy REC banner is not used.
		expect(modal).toMatch(/class="recording-pill call-head__recording"[\s\S]{0,200}\{recordingPillText\}/);
		expect(modal).not.toMatch(/<CallRecordingPanel[^>]*recordingPresenceCopy/);
		expect(modal).toMatch(/\$: recordingLabel = recordingResultWords\(\$callRecordingState\)/);
		expect(modal).not.toMatch(/Saved: \$\{/);
		expect(modal).not.toMatch(/Recording error: \$\{/);
		expect(modal).not.toMatch(/setCaptureFeedback\(\s*error instanceof Error \? error\.message/);
		expect(modal).toMatch(/setCaptureFeedback\(CAPTURE_FAILED_WORDS\)/);
	});

	test('the minimized card keys say what pressing them does', () => {
		expect(modal).toMatch(/title=\{\$isMuted \? 'Unmute microphone' : 'Mute microphone'\}/);
		expect(modal).toMatch(/title=\{\$isDeafened \? 'Turn sound back on' : 'Deafen'\}/);
		expect(modal).toMatch(/aria-label=\{dockedRegionLabel\}/);
		expect(modal).not.toMatch(/aria-label=\{`Call: \$\{callTitle\}`\}/);
	});

	test('the embedded header is in flow: minimize and full window are header buttons, not fixed hatches', () => {
		expect(modal).toMatch(/class="call-head"/);
		expect(modal).toMatch(/aria-label="Minimize call"/);
		expect(modal).toMatch(/aria-label="Full window"[\s\S]{0,80}aria-pressed=\{callViewportMode === 'focus'\}/);
		expect(modal).not.toMatch(/class="hatch-toggle/);
		// The full-window hatch scrim exists only while it is open (no invisible focusable button).
		expect(modal).toMatch(/\{#if callViewportMode === 'focus' && hatchOpen\}\s*<button[\s\S]{0,80}class="hatch-scrim"/);
	});
});

describe('call CSS is on roles', () => {
	const files = [
		'../styles/components/call-modal-part1.css',
		'../styles/components/call-modal-part2.css',
		'../styles/components/call-stage.css'
	];
	for (const file of files) {
		const css = read(file);
		test(`${file.split('/').pop()} has no raw colors or legacy tokens`, () => {
			expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
			expect(css).not.toMatch(/\brgba?\(/);
			expect(css).not.toMatch(/var\(--(text-inverse|surface-|accent-primary|bg-primary|bg-secondary|border-subtle|text-heading|text-body|color-danger|status-online|shadow-lg)/);
			expect(css).not.toMatch(/transition:\s*all/);
			expect(css).not.toMatch(/backdrop-filter/);
		});
	}

	test('the embedded shell sits below the masthead, not over it', () => {
		const part1 = read('../styles/components/call-modal-part1.css');
		expect(part1).toMatch(/\.stage-bar ~ \.call-shell\.mode-embedded\s*\{[^}]*top:\s*var\(--w-mast\)/);
	});

	test('the minimized call is in the stage flow (never floated over the stream) at the footer band height', () => {
		const part1 = read('../styles/components/call-modal-part1.css');
		const rules = [...part1.matchAll(/(^|\n)([^{}\n]*\.docked-bar[^{}]*)\{([^}]*)\}/g)];
		expect(rules.length).toBeGreaterThan(0);
		for (const [, , , body] of rules) expect(body).not.toMatch(/position:\s*(absolute|fixed)/);
		const base = rules.find(([, , selector]) => selector.trim() === '.docked-bar');
		expect(base?.[3]).toMatch(/flex:\s*none/);
		expect(base?.[3]).toMatch(/height:\s*var\(--w-foot\)/);
		expect(base?.[3]).toMatch(/border-top:\s*var\(--w-bw\) solid var\(--w-line\)/);
	});

	test('phones: the call header starts on the 16px gutter (no hanging live dot)', () => {
		const part1 = read('../styles/components/call-modal-part1.css');
		const phone = part1.slice(part1.indexOf('@media (max-width: 768px)'));
		expect(phone).toMatch(/\.call-head \{[^}]*padding: 0 8px 0 16px/);
		expect(phone).toMatch(/\.call-head__live,\s*\.docked-live \{\s*display: none;/);
	});

	test('nothing in the shell is position: fixed except the full-window mode and the call dialog', () => {
		const part1 = read('../styles/components/call-modal-part1.css');
		const fixed = [...part1.matchAll(/([^{}]+)\{[^}]*position:\s*fixed/g)].map((m) => m[1].trim());
		for (const selector of fixed) {
			expect(selector).toMatch(/mode-focus|hatch-scrim|call-modal-overlay/);
		}
	});
});
