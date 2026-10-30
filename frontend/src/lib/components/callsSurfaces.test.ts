import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source contract for the Calls surfaces (design contract §7.26, §8.1 item 7, §8.5, §9.4–9.5;
 * critique voice#3–#17, beta-sweep#4/#5/#7/#18). The components are store-heavy, so these
 * guards read the sources: member UI must not regain developer instruments, the raw transport
 * and lifecycle enums, the six-button footer or off-role colors.
 */

const here = import.meta.dir;
const read = (...parts: string[]) => readFileSync(join(here, ...parts), 'utf8');

const voiceView = read('VoiceView.svelte');
const callsPanel = read('CallsPanel.svelte');
const statusRow = read('sidebar', 'VoiceUserCard.svelte');
const liveStrip = read('VoiceLiveStrip.svelte');
const skin = read('..', '..', 'styles', 'surfaces', 'calls.css');
const legacySheet = read('..', '..', 'styles', 'components', 'voice-view.css');

describe('Calls workspace (VoiceView)', () => {
	test('describes masthead row A instead of drawing its own title band or footer bar', () => {
		expect(voiceView).toContain('setStageHeader(HEADER_OWNER');
		expect(voiceView).toContain('clearStageHeader(HEADER_OWNER)');
		expect(voiceView).not.toContain('<h2>Voice</h2>');
		expect(voiceView).not.toContain('vv-global');
	});

	test('global controls exist only while a call is connected', () => {
		expect(voiceView).toMatch(/if \(!inCall\) return \[\];/);
	});

	test('no transport swap button, raw enums, status-as-button or glyph labels', () => {
		for (const banned of ['Swap to', 'WabiDB', "'Connected'", 'Unmic All', 'Mute All', 'Hang up', 'transport.toUpperCase', 'Listen / Join', '⏺']) {
			expect(voiceView).not.toContain(banned);
		}
	});

	test('one rooms list: connected rooms are cards, the rest are rows with Listen and Join', () => {
		expect(voiceView).toContain("voiceChannels.filter((ch) => !$callSessions.has(ch.id))");
		expect(voiceView).toContain("joinVoice(ch.id, 'listen')");
		expect(voiceView).toContain("joinVoice(ch.id, 'join')");
		expect(voiceView).toMatch(/aria-busy=\{busyLabel\('join', ch\.id\)\}/);
	});

	test('rooms carry data-voice-room for the jump palette', () => {
		expect(voiceView.match(/data-voice-room=/g)?.length).toBe(2);
	});

	test('the volume is labelled for its room and the speaker toggle reports its state', () => {
		expect(voiceView).toContain("t('calls.volume_for', { room })");
		expect(voiceView).toContain("aria-label={t('calls.silence_call')}");
		expect(voiceView).toContain('aria-pressed={session.muted}');
	});

	test('failures render where they happened instead of only reaching the console', () => {
		expect(voiceView).not.toContain('console.warn');
		expect(voiceView).toContain("t('calls.join_failed', { room: name })");
	});
});

describe('Calls companion (CallsPanel)', () => {
	test('the frame names the panel; the body draws no title and publishes the count', () => {
		expect(callsPanel).not.toContain('cpanel-title');
		expect(callsPanel).toContain("setPanelFrameCount('calls'");
	});

	test('the volume says whose volume it is, never "You"', () => {
		expect(callsPanel).not.toContain('<span>You</span>');
		expect(callsPanel).toContain("t('calls.volume_for', { room })");
	});

	test('stamps use real pictures and identity ink', () => {
		expect(callsPanel).toContain('mediaUrl(member.profilePicture)');
		expect(callsPanel).toContain('$inkFor(');
	});
});

describe('Sidebar voice status row (VoiceUserCard)', () => {
	test('replaces the Voice Connected card: no diagnostics header, raw selects or text chevrons', () => {
		for (const banned of ['Voice Connected', '<select', 'Ping', 'Jitter', "'v' : '>'", '{$callConnectionState}', 'voice-usercard']) {
			expect(statusRow).not.toContain(banned);
		}
	});

	test('names the room and where the mic goes, with Connection details and Leave', () => {
		expect(statusRow).toContain('voiceStatusLine(');
		expect(statusRow).toContain('triggerLabel={connectionLabel}');
		expect(statusRow).toContain('aria-label={leaveLabel}');
		expect(statusRow).toContain('openConnectionDetails');
	});

	test('recording has one control elsewhere, not a third one here', () => {
		expect(statusRow).not.toContain('startCallRecording');
	});
});

describe('Calls styling is on roles', () => {
	const hex = /#[0-9a-fA-F]{3,8}\b/;
	const legacyTokens = /var\(--(surface|text|accent-primary|border)-/;

	test('calls.css, the retired voice-view.css and the live strip hold no raw colors', () => {
		for (const source of [skin, legacySheet, liveStrip]) {
			expect(source).not.toMatch(hex);
			expect(source).not.toMatch(/rgba?\(/);
			expect(source).not.toMatch(legacyTokens);
		}
	});

	test('no glow, no scale and no infinite animation on call cards', () => {
		expect(skin).not.toMatch(/scale\(/);
		expect(skin).not.toMatch(/infinite/);
		expect(skin).not.toMatch(/\btransition:\s*all\b/);
	});

	test('legacy voice-view.css holds no rules', () => {
		expect(legacySheet).not.toMatch(/\{/);
	});
});
