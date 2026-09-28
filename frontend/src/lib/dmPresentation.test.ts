import { expect, test } from 'bun:test';
import { groupRecipientSummary, livePresenceForUser, missingDeviceParticipantLabel, missingDeviceParticipantNames } from './dmPresentation';
import type { Channel, User } from './socket-types';

const self = { id: 'user-1', dbUserId: 1, username: 'Me' } as User;
const other = { id: 'user-2', dbUserId: 2, username: 'Tim', status: 'active' } as User;

test('DM presence uses the live roster, not the server member snapshot', () => {
	expect(livePresenceForUser(other, [], true)).toBe('offline');
	expect(livePresenceForUser(other, [], false)).toBe('unavailable');
	expect(livePresenceForUser(other, [{ ...other, id: 'socket-2', status: 'away' }], true)).toBe('away');
	expect(livePresenceForUser(other, [{ ...other, status: 'offline' }], true)).toBe('offline');
	expect(livePresenceForUser(null, [other], true)).toBe('unavailable');
});

test('group heading names recipients and omits the current user', () => {
	const group = { id: 'group-1', type: 'group', members: ['user-1', 'user-2', 'user-3'] } as Channel;
	const ana = { id: 'user-3', dbUserId: 3, username: 'Ana' } as User;
	expect(groupRecipientSummary(group, self, [other, ana])).toBe('Tim, Ana');
	expect(groupRecipientSummary({ ...group, members: ['user-1', 'user-4'] }, self, [])).toBe('1 other member');
});

test('missing device IDs become recipient names when the roster knows them', () => {
	expect(missingDeviceParticipantNames([2, 3], [other, { id: 'user-3', username: 'Ana' } as User])).toEqual(['Tim', 'Ana']);
	expect(missingDeviceParticipantNames([4], [other])).toEqual([]);
	expect(missingDeviceParticipantLabel([2, 4], [other])).toBe('Tim, 1 other participant');
});
