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
const surfaces = read('..', 'callSurfaces.ts');
const stageBarSource = read('StageBar.svelte');

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

	test('the visible "Joining…" is the accessible name while busy (no aria-label over the swap)', () => {
		expect(voiceView).toContain('aria-label={joining ? undefined : `${t(\'calls.listen\')} to ${name}`}');
		expect(voiceView).toContain('aria-label={joining ? undefined : `${t(\'calls.join\')} ${name}`}');
	});

	test('state words follow the audio path: direction, "All rooms I hear" and deafen (review w1-calls majors 1, 2, 4)', () => {
		expect(voiceView).toContain('transmitMode: $voiceTransmitMode');
		expect(voiceView).toContain('deafened: $isDeafened');
		expect(voiceView).toContain('sessionState(session, audio)');
		expect(voiceView).toContain("here = session.lifecycle !== 'failed' && micGoesTo(session, audio)");
		expect(voiceView).toContain('callsSummary(sessions, { nameOf: displayName, roomCount: voiceChannels.length, t, audio })');
	});

	test('no control relabels the mic without moving it (review w1-calls major 3)', () => {
		// "Join" is offered only while the mic is in no other call; there is no "Speak here".
		expect(voiceView).toContain('const joinListensOnly = $derived(Boolean($activeVoiceChannel) || Boolean($activeCallSessionId))');
		expect(voiceView).toContain("showJoin = !joinListensOnly || busyLabel('join', ch.id)");
		expect(voiceView).not.toContain('focusCall(');
		expect(voiceView).not.toContain('Speak here</');
		const join = surfaces.slice(surfaces.indexOf('export function joinVoice'), surfaces.indexOf('/** Close a join failure notice. */'));
		expect(join).not.toContain('setFocus');
	});

	test('the masthead menu renders only anchored to the masthead ⋯, never with its own unnamed trigger', () => {
		expect(voiceView).toContain('{#if inCall && moreAnchor}');
		expect(voiceView).not.toMatch(/label: phone \? 'Call options' : t\('calls\.connection_details'\)/);
		expect(voiceView).toContain("label: 'Call options',");
	});

	test('Record keeps one size; Record and Leave all fold into ⋯ on a narrow stage', () => {
		expect(voiceView).not.toContain("variant: recording ? 'danger' : 'default'");
		expect(voiceView).toContain('bind:clientWidth={stageWidth}');
		expect(voiceView).toContain('if (compact) return [mic, sound, more];');
		expect(voiceView).toContain('class="calls-recbar"');
	});

	test('Record keeps one accessible name while its readout ticks (w1-calls recheck)', () => {
		// The visible words read "Recording 02:14"; the toggle stays "Record" and aria-pressed
		// says it is on, so screen readers do not hear a new control every second.
		expect(voiceView).toContain("accessibleName: t('calls.record'),");
		expect(stageBarSource).toContain('aria-label={action.accessibleName}');
	});

	test('row 3 of a card holds Silence this call, the volume and Leave (§7.26)', () => {
		expect(voiceView).not.toContain('call-card__actions');
		const row = voiceView.slice(voiceView.indexOf('<div class="call-card__volume"'), voiceView.indexOf('</article>'));
		expect(row).toContain("t('calls.silence_call')");
		expect(row).toContain('class="w-range"');
		expect(row).toContain('call-card__leave');
	});

	test('one silence: the toggle is pressed whenever the call is silent', () => {
		expect(voiceView).toContain('aria-pressed={silenced}');
		expect(surfaces).toContain('if (!sessionSilenced(session))');
	});

	test('the route hint describes the connection, never confidentiality', () => {
		expect(voiceView).not.toContain('the audio goes between devices');
		expect(voiceView).toContain('a relay may still carry the audio');
	});

	test('rooms carry data-voice-room for the jump palette', () => {
		expect(voiceView.match(/data-voice-room=/g)?.length).toBe(2);
	});

	test('the volume is labelled for its room and the speaker toggle reports its state', () => {
		expect(voiceView).toContain("t('calls.volume_for', { room })");
		expect(voiceView).toContain("aria-label={t('calls.silence_call')}");
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

	test('the same state words as the Calls page, with no "Speak here" that does not move the mic', () => {
		expect(callsPanel).toContain('sessionState(session, audio)');
		expect(callsPanel).toContain('transmitMode: $voiceTransmitMode');
		expect(callsPanel).not.toContain('focusCall(');
	});

	test('the empty state uses the kit and offers Open Calls only while Calls is elsewhere', () => {
		expect(callsPanel).toContain('class="w-empty calls-panel__empty"');
		expect(callsPanel).toContain("$activeWorkspaceView === 'voice'");
	});
});

describe('Sidebar voice status row (VoiceUserCard)', () => {
	test('replaces the Voice Connected card: no diagnostics header, raw selects or text chevrons', () => {
		for (const banned of ['Voice Connected', '<select', 'Ping', 'Jitter', "'v' : '>'", '{$callConnectionState}', 'voice-usercard']) {
			expect(statusRow).not.toContain(banned);
		}
	});

	test('names the room and where the mic goes, with Call options and Leave', () => {
		expect(statusRow).toContain('voiceStatusLine(');
		expect(statusRow).toContain('triggerLabel={optionsLabel}');
		expect(statusRow).toContain('aria-label={leaveLabel}');
		expect(statusRow).toContain('openConnectionDetails');
	});

	test('the line knows "All rooms I hear" and deafen; the Listening to list reads the same sessions', () => {
		expect(statusRow).toContain('transmitMode: $voiceTransmitMode');
		expect(statusRow).toContain('deafened: $callDeafened');
		expect(statusRow).not.toContain('$listeningVoiceChannels');
		expect(statusRow).toMatch(/listenedRooms = sessionList/);
	});

	test('Leave names the room so a failure can say which', () => {
		expect(statusRow).toContain('leaveCall(status.session, roomName)');
		expect(surfaces).toContain("showToast(room ? `Couldn't leave ${room}. Try again.`");
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
