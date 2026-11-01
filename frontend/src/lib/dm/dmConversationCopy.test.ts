import { describe, expect, test } from 'bun:test';
import type { E2eeRoomStatus } from '../e2ee';
import { privacyWords } from '../privacy/privacyState';
import {
	conversationMatches,
	dmCallStartError,
	dmEncryptionError,
	dmGateActionView,
	dmRetentionChoice,
	dmRetentionControlLabel,
	dmRetentionOptions,
	dmRetentionPhrase,
	dmSendGate,
	DM_RETENTION_FOREVER,
	type DmEncryptionAction
} from './dmConversationCopy';

function status(overrides: Partial<E2eeRoomStatus> = {}): E2eeRoomStatus {
	return {
		enabled: false,
		pendingDefault: false,
		serverReadableSelected: false,
		serverReadableAllowedByMe: false,
		epoch: 0,
		membershipRevision: 'r1',
		currentMembershipRevision: 'r1',
		needsRekey: false,
		devices: [],
		missingUserIds: [],
		keyEnvelopes: [],
		downgradeAllowed: false,
		...overrides
	};
}

const BANNED = /E2EE|end-to-end|secure|verified(?! )|operator-blind/i;

describe('dmSendGate: the composer shows only when this member may send', () => {
	test('encrypted, older server-readable and confirmed server-readable rooms show the composer', () => {
		expect(dmSendGate(status({ enabled: true }))).toBeNull();
		expect(dmSendGate(status())).toBeNull();
		expect(dmSendGate(status({ serverReadableSelected: true, serverReadableAllowedByMe: true }))).toBeNull();
	});

	test('an unknown status pauses sending: it is never assumed safe to send', () => {
		for (const unknown of [null, undefined]) {
			const gate = dmSendGate(unknown);
			expect(gate?.kind).toBe('checking');
			expect(gate?.title).toBe(privacyWords('checking').word);
			expect(gate?.actions.map((action) => action.id)).toEqual(['check']);
		}
	});

	test('a new room waiting for devices says Encryption pending in the D7 words and names who it waits for', () => {
		const gate = dmSendGate(status({ pendingDefault: true, missingUserIds: [2] }), 'Theo Park');
		expect(gate?.kind).toBe('pending');
		expect(gate?.title).toBe('Encryption pending');
		expect(gate?.text).toBe("Messages wait for everyone's devices. You can choose to send server-readable instead.");
		expect(gate?.detail).toBe('Waiting for Theo Park.');
		expect(gate?.actions.map((action) => action.id)).toEqual(['check', 'server-readable']);
		expect(dmSendGate(status({ pendingDefault: true, missingUserIds: [] }))?.detail).toContain('Encryption is starting');
		expect(dmSendGate(status({ pendingDefault: true, missingUserIds: [9] }))?.detail).toBe('Waiting for participant devices.');
	});

	test("another member's server-readable choice needs this member's own confirmation", () => {
		const gate = dmSendGate(status({ serverReadableSelected: true, serverReadableAllowedByMe: false }));
		expect(gate?.kind).toBe('confirm-readable');
		expect(gate?.title).toBe('Server-readable');
		expect(gate?.glyph).toBe('lockOpen');
		expect(gate?.actions.map((action) => action.id)).toEqual(['server-readable']);
	});

	test('an encrypted room with changed membership asks for a key update; an unencrypted one keeps checking', () => {
		expect(dmSendGate(status({ enabled: true, needsRekey: true }))?.kind).toBe('rekey');
		expect(dmSendGate(status({ enabled: false, needsRekey: true }))?.kind).toBe('checking');
	});

	test('a paused-row button follows its own request: a failed check re-enables "Check again"', () => {
		const pending = dmSendGate(status({ pendingDefault: true, missingUserIds: [2] }), 'Theo');
		const [check, readable] = pending?.actions ?? [];
		expect(dmGateActionView(check, { checking: true, busy: false })).toEqual({ id: 'check', label: 'Checking…', busy: true });
		// The check ended (in success or failure): the button is usable again and says so.
		expect(dmGateActionView(check, { checking: false, busy: false })).toEqual({ id: 'check', label: 'Check again', busy: false });
		// A switch in flight does not lock "Check again", and vice versa.
		expect(dmGateActionView(check, { checking: false, busy: true }).busy).toBe(false);
		expect(dmGateActionView(readable, { checking: false, busy: true })).toEqual({ id: 'server-readable', label: 'Switching…', busy: true });
		expect(dmGateActionView(readable, { checking: true, busy: false })).toEqual({ id: 'server-readable', label: 'Send server-readable', busy: false });
		const rekey = dmSendGate(status({ enabled: true, needsRekey: true }))?.actions[0];
		expect(rekey && dmGateActionView(rekey, { checking: false, busy: true }).label).toBe('Updating keys…');
		expect(rekey && dmGateActionView(rekey, { checking: false, busy: false }).label).toBe('Trust devices and update keys');
	});

	test('no gate wording claims more than experimental encryption', () => {
		const gates = [
			dmSendGate(null),
			dmSendGate(status({ pendingDefault: true, missingUserIds: [1] }), 'Ana'),
			dmSendGate(status({ serverReadableSelected: true })),
			dmSendGate(status({ enabled: true, needsRekey: true }))
		];
		for (const gate of gates) {
			const words = [gate?.title, gate?.text, gate?.detail, ...(gate?.actions ?? []).flatMap((a) => [a.label, a.busyLabel])].join(' ');
			expect(words).not.toMatch(BANNED);
		}
	});
});

describe('dmEncryptionError: plain words, never the raw message', () => {
	const actions: DmEncryptionAction[] = ['check', 'server-readable', 'rekey', 'enable'];
	const raws = [
		'E2EE requires a registered account.',
		'Sign in with a registered account to use E2EE.',
		'Your session expired. Sign in again before using E2EE.',
		'This client does not provide WebCrypto required for E2EE.',
		'This client cannot persist E2EE key material locally.',
		'Every participant must open an updated Wabi client before E2EE can start. Missing E2EE devices for user IDs: 4, 5',
		'E2EE request failed (503).',
		'socket hang up'
	];

	test('the raw message is never shown and E2EE never appears', () => {
		for (const action of actions) {
			for (const raw of [...raws, null, undefined, 42]) {
				const copy = dmEncryptionError(action, typeof raw === 'string' ? new Error(raw) : raw);
				const words = `${copy.title} ${copy.text}`;
				expect(words).not.toMatch(/E2EE/);
				if (typeof raw === 'string') expect(words).not.toContain(raw);
				expect(copy.title.length).toBeGreaterThan(0);
				expect(copy.text.length).toBeGreaterThan(0);
			}
		}
	});

	test('the guest-account case is said as plain words about the account', () => {
		const copy = dmEncryptionError('check', new Error('E2EE requires a registered account.'));
		expect(copy.title).toBe('This account can’t set up encryption');
		expect(copy.text).toContain('registered account');
		expect(copy.text).toContain('Nothing was sent.');
		expect(copy.action).toBe('check');
	});

	test('each action says what stayed unchanged', () => {
		expect(dmEncryptionError('check', new Error('boom')).text).toContain('Sending stays paused');
		expect(dmEncryptionError('enable', null).text).toContain('Messages stay server-readable');
		expect(dmEncryptionError('rekey', 'x').title).toBe("Couldn't update the encryption keys");
		expect(dmEncryptionError('server-readable', new Error('x')).text).toContain('Nothing changed');
	});
});

describe('message lifetime', () => {
	test('null and forever read as kept until deleted; a missing value is the DM default', () => {
		expect(dmRetentionChoice({ autoDeleteAfter: null })).toBe(DM_RETENTION_FOREVER);
		expect(dmRetentionChoice({ autoDeleteAfter: 'forever' })).toBe(DM_RETENTION_FOREVER);
		expect(dmRetentionChoice({ autoDeleteAfter: '7d' })).toBe('7d');
		expect(dmRetentionChoice({})).toBe('24h');
		expect(dmRetentionChoice(null)).toBe('24h');
	});

	test('the choices keep every preset and are sentence-case menu rows', () => {
		const options = dmRetentionOptions();
		expect(options[0]).toEqual({ value: '', label: 'Until someone deletes them' });
		expect(options.find((option) => option.value === '24h')?.label).toBe('24 hours');
		expect(options.length).toBe(15);
		expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
		for (const option of options) expect(option.label.charAt(0)).not.toMatch(/[a-z]/);
	});

	test('the control says the lifetime in the §9.2 words, the same on desktop and phone', () => {
		expect(dmRetentionPhrase(DM_RETENTION_FOREVER)).toBe('Kept until someone deletes them');
		expect(dmRetentionPhrase('24h')).toBe('Kept 24 hours');
		expect(dmRetentionPhrase('7d')).toBe('Kept 7 days');
		// The accessible name starts with the visible words (WCAG 2.5.3 label in name).
		expect(dmRetentionControlLabel('24h')).toBe('Kept 24 hours. Change how long new messages are kept');
		expect(dmRetentionControlLabel(DM_RETENTION_FOREVER)).toBe('Kept until someone deletes them. Change how long new messages are kept');
		expect(dmRetentionControlLabel('24h').startsWith(dmRetentionPhrase('24h'))).toBe(true);
		for (const option of dmRetentionOptions()) {
			expect(dmRetentionPhrase(option.value)).not.toMatch(/private|secure|encrypt/i);
		}
	});
});

describe('dmCallStartError: the cause in plain words', () => {
	test('another call in progress is not blamed on permissions', () => {
		const words = dmCallStartError(new Error('A call is already active or ringing'), false);
		expect(words).toContain('already in a call');
		expect(words).not.toMatch(/microphone|permission/i);
	});

	test('no connection says so', () => {
		const words = dmCallStartError(new Error('No connection to server. Calls require an active connection to the Wabi server.'), true);
		expect(words).toContain('Not connected');
		expect(words).not.toMatch(/camera|permission/i);
	});

	test('the group-call path offline errors also read as not connected', () => {
		// calling_impl_core rejects a group call with these two messages when the socket is down.
		for (const raw of ['Calls require an active server connection', 'Reconnect to refresh group membership before joining a call']) {
			expect(dmCallStartError(new Error(raw), false)).toContain('Not connected');
		}
	});

	test('a refused or missing device names the device for the call kind', () => {
		const refused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
		expect(dmCallStartError(refused, false)).toContain('microphone');
		expect(dmCallStartError(refused, false)).not.toContain('camera');
		expect(dmCallStartError(refused, true)).toContain('camera and microphone');
		const missing = Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
		expect(dmCallStartError(missing, false)).toContain('No microphone');
	});

	test('anything else is a plain retry, never the raw message', () => {
		const raw = 'socket hang up at transport 0x1f';
		const words = dmCallStartError(new Error(raw), false);
		expect(words).toBe('Couldn’t start the call. Try again in a moment.');
		expect(dmCallStartError(null, true)).toBe('Couldn’t start the video call. Try again in a moment.');
		expect(words).not.toContain(raw);
	});
});

describe('conversationMatches', () => {
	test('matches any name, ignoring case and accents; an empty query matches everything', () => {
		expect(conversationMatches('', ['Theo'])).toBe(true);
		expect(conversationMatches('  ', [])).toBe(true);
		expect(conversationMatches('theo', ['Theo Park'])).toBe(true);
		expect(conversationMatches('jose', ['José'])).toBe(true);
		expect(conversationMatches('@theo', ['Theo', '@theo'])).toBe(true);
		expect(conversationMatches('nora', ['Theo', null, undefined])).toBe(false);
	});
});
