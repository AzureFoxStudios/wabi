import { describe, expect, test } from 'bun:test';
import type { User } from '$lib/socket';
import type { VoiceChannelParticipant } from '$lib/presenceStore';
import {
	buildPeopleEntries,
	buildPeopleGroups,
	getStatusColor,
	participantMatchesUser,
	personAriaLabel,
	personSubline,
	voiceStateOf,
	writingChannelFor,
	type PeopleVoiceRoom
} from './userPanelHelpers';

function person(dbUserId: number, username: string, extra: Partial<User> = {}): User {
	return { id: `user-${dbUserId}`, dbUserId, username, color: '#98d8c8', status: 'active', ...extra } as User;
}

function participant(userId: string, flags: Partial<VoiceChannelParticipant> = {}): VoiceChannelParticipant {
	return { userId, username: userId, isSpeaking: false, isMuted: false, isDeafened: false, ...flags };
}

const mira = person(1, 'Mira', { highestRole: 'admin' });
const theo = person(2, 'Theo Park', { handle: 'theo' });
const nora = person(3, 'Nora Ellis', { bio: 'Collecting little discoveries.\nSecond line' });
const jun = person(4, 'Jun Sato');
const amara = person(5, 'Amara Okafor');
const leo = person(6, 'Leo Martin', { handle: 'leo' });
const sofia = person(7, 'Sofia Reyes', { status: 'away', statusMessage: 'Back after lunch' });
const iris = person(8, 'Iris Wong');
const kai = person(9, 'Kai Offline', { status: 'offline' });

const studio: PeopleVoiceRoom = {
	id: 'studio-lounge',
	name: 'Studio lounge',
	members: [participant('user-5', { isSpeaking: true }), participant('user-2'), participant('user-4', { isMuted: true })]
};
const quiet: PeopleVoiceRoom = { id: 'quiet', name: 'Quiet coworking', members: [] };

const online = [mira, theo, nora, jun, amara, leo, sofia, iris];
const members = [...online, kai];

describe('People grouping by place (spec §8.4)', () => {
	const groups = buildPeopleGroups({ online, members, self: mira, rooms: [studio, quiet], show: 'all', grouping: 'place' });

	test('voice rooms with people come first, then Here now, Away and Offline; empty rooms are left out', () => {
		expect(groups.map((group) => group.label)).toEqual(['In Studio lounge', 'Here now', 'Away', 'Offline']);
	});

	test('a person in a voice room is listed only under the room, with their voice state', () => {
		const room = groups[0];
		expect(room.entries.map((entry) => entry.user.username)).toEqual(['Amara Okafor', 'Jun Sato', 'Theo Park']);
		expect(room.entries.map((entry) => entry.voice)).toEqual(['speaking', 'muted', 'listening']);
		const here = groups[1].entries.map((entry) => entry.user.username);
		expect(here).not.toContain('Theo Park');
	});

	test('the viewer comes first in their group, then everyone alphabetically', () => {
		expect(groups[1].entries.map((entry) => entry.user.username)).toEqual(['Mira', 'Iris Wong', 'Leo Martin', 'Nora Ellis']);
		expect(groups[1].entries[0].isSelf).toBe(true);
	});

	test('away people and members who are not connected get their own groups', () => {
		expect(groups[2].entries.map((entry) => entry.user.username)).toEqual(['Sofia Reyes']);
		expect(groups[3].entries.map((entry) => entry.user.username)).toEqual(['Kai Offline']);
		expect(groups[3].entries[0].presence).toBe('offline');
	});

	test('one row per person even when the stores repeat them', () => {
		const repeated = buildPeopleEntries({ online: [mira, mira, { ...theo, id: 'socket-xyz' }, theo], members: [mira, theo], self: mira, rooms: [] });
		expect(repeated.map((entry) => entry.user.username)).toEqual(['Mira', 'Theo Park']);
	});
});

describe('People filters and role grouping', () => {
	test('Show: Here now keeps voice rooms and Here now, drops Away and Offline', () => {
		const groups = buildPeopleGroups({ online, members, self: mira, rooms: [studio], show: 'here', grouping: 'place' });
		expect(groups.map((group) => group.kind)).toEqual(['room', 'here']);
	});

	test('Show: Away and Show: Offline list only those people', () => {
		expect(buildPeopleGroups({ online, members, self: mira, rooms: [studio], show: 'away', grouping: 'place' }).map((group) => group.id)).toEqual(['away']);
		expect(buildPeopleGroups({ online, members, self: mira, rooms: [studio], show: 'offline', grouping: 'place' }).map((group) => group.id)).toEqual(['offline']);
	});

	test('search narrows every group and empty groups disappear', () => {
		const groups = buildPeopleGroups({ online, members, self: mira, rooms: [studio], show: 'all', grouping: 'place', matches: (user) => user.username.startsWith('J') });
		expect(groups.map((group) => group.id)).toEqual(['room:studio-lounge']);
		expect(groups[0].entries.map((entry) => entry.user.username)).toEqual(['Jun Sato']);
	});

	test('By role: one group per role online, highest first, then Offline', () => {
		const groups = buildPeopleGroups({
			online,
			members,
			self: mira,
			rooms: [studio],
			show: 'all',
			grouping: 'role',
			rolePriority: { admin: 90, member: 10 },
			roleLabel: (role) => (role === 'admin' ? 'Admin' : 'Member')
		});
		expect(groups.map((group) => group.label)).toEqual(['Admin', 'Member', 'Offline']);
		// Voice state still travels with the row when grouped by role.
		expect(groups[1].entries.find((entry) => entry.user.username === 'Amara Okafor')?.voice).toBe('speaking');
	});
});

describe('Member row words (spec §7.11)', () => {
	const entries = buildPeopleEntries({ online, members, self: mira, rooms: [studio] });
	const entry = (name: string) => entries.find((candidate) => candidate.user.username === name)!;

	test('sublines: voice state, You, writing, status message, first line of bio, then handle', () => {
		expect(personSubline(entry('Amara Okafor'))).toEqual({ text: 'Speaking', glyph: 'voice', tone: 'speaking' });
		expect(personSubline(entry('Theo Park'))?.text).toBe('Listening');
		expect(personSubline(entry('Jun Sato'))).toEqual({ text: 'Muted', glyph: 'micOff', tone: 'plain' });
		expect(personSubline(entry('Mira'))?.text).toBe('You');
		expect(personSubline(entry('Iris Wong'), '#general')?.text).toBe('Writing in #general');
		expect(personSubline(entry('Sofia Reyes'))?.text).toBe('Back after lunch');
		expect(personSubline(entry('Nora Ellis'))?.text).toBe('Collecting little discoveries.');
		expect(personSubline(entry('Leo Martin'))).toEqual({ text: '@leo', glyph: null, tone: 'handle' });
	});

	test('the row names the person, where they are and what they are doing', () => {
		const theoEntry = entry('Theo Park');
		expect(personAriaLabel('Theo Park', theoEntry, personSubline(theoEntry), null)).toBe('Theo Park, in Studio lounge, listening');
		const miraEntry = entry('Mira');
		expect(personAriaLabel('Mira', miraEntry, personSubline(miraEntry), 'Admin')).toBe('Mira, here now, you, admin');
		const sofiaEntry = entry('Sofia Reyes');
		expect(personAriaLabel('Sofia Reyes', sofiaEntry, personSubline(sofiaEntry), null)).toBe('Sofia Reyes, away, Back after lunch');
	});

	test('voice participants match by stable id, bare account id or socket id', () => {
		expect(participantMatchesUser(participant('user-2'), theo)).toBe(true);
		expect(participantMatchesUser(participant('2'), theo)).toBe(true);
		expect(participantMatchesUser(participant('someone', { socketId: 'sock-1' }), { ...theo, id: 'sock-1' })).toBe(true);
		expect(participantMatchesUser(participant('user-3'), theo)).toBe(false);
		expect(voiceStateOf(participant('x', { isDeafened: true, isSpeaking: true }))).toBe('deafened');
	});

	test('writing activity comes from shared channels only, never a DM', () => {
		const channelList = [
			{ id: 'general', name: 'general', type: 'text' },
			{ id: 'dm-1', name: 'Theo Park', type: 'dm' }
		];
		expect(writingChannelFor(iris, { general: ['Iris Wong'] }, channelList)).toBe('#general');
		expect(writingChannelFor(theo, { 'dm-1': ['Theo Park'] }, channelList)).toBeNull();
		expect(writingChannelFor(theo, { general: ['user-2'] }, channelList, 'general')).toBe('#general');
	});

	test('presence marks use status roles, offline is a hollow ring', () => {
		expect(getStatusColor('active')).toBe('var(--w-online)');
		expect(getStatusColor('away')).toBe('var(--w-warn)');
		expect(getStatusColor('busy')).toBe('var(--w-danger)');
		expect(getStatusColor('offline')).toBe('transparent');
	});
});
