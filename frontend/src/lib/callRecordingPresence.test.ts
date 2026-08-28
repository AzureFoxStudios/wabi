import { describe, expect, test, beforeEach } from 'bun:test';
import { get } from 'svelte/store';
import {
	applyRemoteRecordingPresence,
	clearAllRecordingPresence,
	directCallRecordingParticipants,
	groupCallRecordingParticipants,
	removeDirectRecordingParticipant,
	voiceCallRecordingParticipants
} from './callRecordingPresence';

beforeEach(() => {
	clearAllRecordingPresence();
});

describe('applyRemoteRecordingPresence — server delta reducer', () => {
	test('direct scope upserts then removes by recorder id', () => {
		applyRemoteRecordingPresence({
			active: true,
			scope: 'direct',
			recorder: { userId: 'user-2', username: 'alice' }
		});
		expect(get(directCallRecordingParticipants).map((p) => p.userId)).toEqual(['user-2']);

		// A second recorder appends without clobbering the first.
		applyRemoteRecordingPresence({
			active: true,
			scope: 'direct',
			recorder: { userId: 'user-3', username: 'bob' }
		});
		expect(get(directCallRecordingParticipants).map((p) => p.userId).sort()).toEqual(['user-2', 'user-3']);

		applyRemoteRecordingPresence({
			active: false,
			scope: 'direct',
			recorder: { userId: 'user-2' }
		});
		expect(get(directCallRecordingParticipants).map((p) => p.userId)).toEqual(['user-3']);
	});

	test('channel scope fans out into every reported channel list', () => {
		applyRemoteRecordingPresence({
			active: true,
			scope: 'channel',
			channelIds: ['ch-1', 'ch-2'],
			recorder: { userId: 'user-4', username: 'carol' }
		});
		expect(get(voiceCallRecordingParticipants)['ch-1'].map((p) => p.userId)).toEqual(['user-4']);
		expect(get(voiceCallRecordingParticipants)['ch-2'].map((p) => p.userId)).toEqual(['user-4']);

		// Deactivate removes from every channel and drops emptied keys.
		applyRemoteRecordingPresence({
			active: false,
			scope: 'channel',
			channelIds: ['ch-1', 'ch-2'],
			recorder: { userId: 'user-4' }
		});
		expect(get(voiceCallRecordingParticipants)['ch-1']).toBeUndefined();
		expect(get(voiceCallRecordingParticipants)['ch-2']).toBeUndefined();
	});

	test('group scope addresses the group store, not the voice store', () => {
		applyRemoteRecordingPresence({
			active: true,
			scope: 'group',
			channelIds: ['grp-1'],
			recorder: { userId: 'user-5', username: 'dave' }
		});
		expect(get(groupCallRecordingParticipants)['grp-1'].map((p) => p.userId)).toEqual(['user-5']);
		expect(get(voiceCallRecordingParticipants)).toEqual({});
	});

	test('events without a recorder id are ignored', () => {
		applyRemoteRecordingPresence({ active: true, scope: 'direct' });
		expect(get(directCallRecordingParticipants)).toEqual([]);
	});

	test('removeDirectRecordingParticipant drops exactly one peer', () => {
		applyRemoteRecordingPresence({ active: true, scope: 'direct', recorder: { userId: 'user-7' } });
		applyRemoteRecordingPresence({ active: true, scope: 'direct', recorder: { userId: 'user-8' } });
		removeDirectRecordingParticipant('user-7');
		expect(get(directCallRecordingParticipants).map((p) => p.userId)).toEqual(['user-8']);
	});
});
