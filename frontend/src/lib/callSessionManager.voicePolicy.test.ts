import { beforeEach, describe, expect, test } from 'bun:test';
import { callSessionManager } from './callSessionManager';
import { clearVoiceAdmissions, rememberVoiceAdmission } from './voiceAdmissionState';

beforeEach(() => {
	callSessionManager.leaveAll();
	clearVoiceAdmissions();
});

describe('CallSessionManager voice admission policy', () => {
	test('Authority-forced listener cannot be promoted to transmit by focus', () => {
		rememberVoiceAdmission('voice-a', { listeningOnly: true });
		const session = callSessionManager.register({
			id: 'voice-a',
			channelId: 'voice-a',
			kind: 'channel',
			name: 'Audience',
			direction: 'transmit'
		});
		expect(session.direction).toBe('listen');

		callSessionManager.setFocus('voice-a');
		expect(callSessionManager.get('voice-a')?.direction).toBe('listen');

		callSessionManager.setDirection('voice-a', 'transmit');
		expect(callSessionManager.get('voice-a')?.direction).toBe('listen');
	});

	test('ordinary open admission can transmit and focus normally', () => {
		rememberVoiceAdmission('voice-a', { listeningOnly: false });
		const session = callSessionManager.register({
			id: 'voice-a',
			channelId: 'voice-a',
			kind: 'channel',
			name: 'Voice',
			direction: 'transmit'
		});
		expect(session.direction).toBe('transmit');
	});

	test('leaving a channel clears the stale admission constraint', () => {
		rememberVoiceAdmission('voice-a', { listeningOnly: true });
		callSessionManager.register({ id: 'voice-a', channelId: 'voice-a', kind: 'channel', name: 'Voice' });
		callSessionManager.unregister('voice-a');
		const replacement = callSessionManager.register({
			id: 'voice-a', channelId: 'voice-a', kind: 'channel', name: 'Voice', direction: 'transmit'
		});
		expect(replacement.direction).toBe('transmit');
	});

	test('a newly received listener restriction is retained when focusing an existing session', () => {
		callSessionManager.register({ id: 'voice-a', channelId: 'voice-a', kind: 'channel', direction: 'transmit' });
		rememberVoiceAdmission('voice-a', { listeningOnly: true });
		callSessionManager.setFocus('voice-a');
		expect(callSessionManager.get('voice-a')?.direction).toBe('listen');
	});

	test('leaving all sessions clears their channel admission constraints', () => {
		rememberVoiceAdmission('voice-a', { listeningOnly: true });
		callSessionManager.register({ id: 'voice-a', channelId: 'voice-a', kind: 'channel' });
		callSessionManager.leaveAll();
		const replacement = callSessionManager.register({
			id: 'voice-a', channelId: 'voice-a', kind: 'channel', direction: 'transmit'
		});
		expect(replacement.direction).toBe('transmit');
	});

});
