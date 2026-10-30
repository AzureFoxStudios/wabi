import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	connectionWords,
	deviceIcon,
	dockBarControls,
	dockMoreItems,
	peopleCountLabel,
	recordingReadout,
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
		expect(controls).toMatch(/class="w-btn w-btn--danger call-dock__leave"[\s\S]{0,200}>Leave</);
		expect(controls).not.toMatch(/text-inverse/);
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

	test('nothing in the shell is position: fixed except the full-window mode and the call dialog', () => {
		const part1 = read('../styles/components/call-modal-part1.css');
		const fixed = [...part1.matchAll(/([^{}]+)\{[^}]*position:\s*fixed/g)].map((m) => m[1].trim());
		for (const selector of fixed) {
			expect(selector).toMatch(/mode-focus|hatch-scrim|call-modal-overlay/);
		}
	});
});
