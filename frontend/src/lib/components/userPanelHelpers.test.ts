import { describe, expect, test } from 'bun:test';
import type { User } from '$lib/socket';
import type { VoiceChannelParticipant } from '$lib/presenceStore';
import {
	buildPeopleEntries,
	buildPeopleGroups,
	facepileOf,
	getStatusColor,
	participantMatchesUser,
	personAriaLabel,
	personDescription,
	personSubline,
	presenceOf,
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
		expect(personSubline(entry('Amara Okafor'))).toEqual({ text: 'Speaking', kind: 'voice', glyph: 'voice', tone: 'speaking' });
		expect(personSubline(entry('Theo Park'))?.text).toBe('Listening');
		expect(personSubline(entry('Jun Sato'))).toEqual({ text: 'Muted', kind: 'voice', glyph: 'micOff', tone: 'plain' });
		expect(personSubline(entry('Mira'))?.text).toBe('You');
		expect(personSubline(entry('Iris Wong'), '#general')?.text).toBe('Writing in #general');
		expect(personSubline(entry('Sofia Reyes'))?.text).toBe('Back after lunch');
		expect(personSubline(entry('Nora Ellis'))?.text).toBe('Collecting little discoveries.');
		expect(personSubline(entry('Leo Martin'))).toEqual({ text: '@leo', kind: 'handle', glyph: null, tone: 'handle' });
	});

	test('the row names the person, where they are and what they are doing', () => {
		const theoEntry = entry('Theo Park');
		expect(personAriaLabel('Theo Park', theoEntry, personSubline(theoEntry), null)).toBe('Theo Park, in Studio lounge, listening');
		const miraEntry = entry('Mira');
		expect(personAriaLabel('Mira', miraEntry, personSubline(miraEntry), 'Admin')).toBe('Mira, here now, you, admin');
		const irisEntry = entry('Iris Wong');
		expect(personAriaLabel('Iris Wong', irisEntry, personSubline(irisEntry, '#general'), null)).toBe('Iris Wong, here now, Writing in #general');
	});

	test('free text and handles describe the row instead of joining its name', () => {
		const sofiaEntry = entry('Sofia Reyes');
		const sofiaLine = personSubline(sofiaEntry);
		expect(personAriaLabel('Sofia Reyes', sofiaEntry, sofiaLine, null)).toBe('Sofia Reyes, away');
		expect(personDescription(sofiaLine)).toBe('Back after lunch');
		const long = person(20, 'Bartholomew Long', { bio: 'A very long biography line that should truncate in the row and never be read as part of the name' });
		const longEntry = buildPeopleEntries({ online: [long], members: [long], self: mira, rooms: [] })[0];
		const longLine = personSubline(longEntry);
		expect(personAriaLabel('Bartholomew Long', longEntry, longLine, 'Admin')).toBe('Bartholomew Long, here now, admin');
		expect(personDescription(longLine)).toBe(long.bio!);
		expect(personDescription(personSubline(entry('Leo Martin')))).toBe('@leo');
		expect(personDescription(personSubline(entry('Theo Park')))).toBeNull();
		expect(personDescription(personSubline(entry('Iris Wong'), '#general'))).toBeNull();
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

describe('Invisible stays invisible (presence.rs masks it as "offline")', () => {
	const ghost = person(30, 'Ghost Writer', { status: 'offline' });

	test('a connected person whose status reads offline is listed as offline, never Here now', () => {
		const groups = buildPeopleGroups({ online: [mira, ghost], members: [mira, ghost], self: mira, rooms: [], show: 'all', grouping: 'place' });
		expect(groups.map((group) => [group.id, group.entries.map((entry) => [entry.user.username, entry.presence])])).toEqual([
			['here', [['Mira', 'active']]],
			['offline', [['Ghost Writer', 'offline']]]
		]);
		const ghostEntry = groups[1].entries[0];
		expect(personAriaLabel('Ghost Writer', ghostEntry, personSubline(ghostEntry), null)).toBe('Ghost Writer, offline');
		expect(buildPeopleGroups({ online: [mira, ghost], members: [mira, ghost], self: mira, rooms: [], show: 'here', grouping: 'place' }).flatMap((group) => group.entries.map((entry) => entry.user.username))).toEqual(['Mira']);
		expect(buildPeopleGroups({ online: [mira, ghost], members: [mira, ghost], self: mira, rooms: [], show: 'offline', grouping: 'place' }).flatMap((group) => group.entries.map((entry) => entry.user.username))).toEqual(['Ghost Writer']);
	});

	test('a masked person in a voice room is not listed in it: no room, no voice state', () => {
		const room: PeopleVoiceRoom = { id: 'studio-lounge', name: 'Studio lounge', members: [participant('user-30'), participant('user-2')] };
		const groups = buildPeopleGroups({ online: [mira, theo, ghost], members: [mira, theo, ghost], self: mira, rooms: [room], show: 'all', grouping: 'place' });
		expect(groups.map((group) => [group.id, group.entries.map((entry) => entry.user.username)])).toEqual([
			['room:studio-lounge', ['Theo Park']],
			['here', ['Mira']],
			['offline', ['Ghost Writer']]
		]);
		const ghostEntry = groups[2].entries[0];
		expect([ghostEntry.room, ghostEntry.voice]).toEqual([null, null]);
		expect(personSubline(ghostEntry)).toBeNull();
		expect(personAriaLabel('Ghost Writer', ghostEntry, personSubline(ghostEntry), null)).toBe('Ghost Writer, offline');
	});

	test('the masked person is offline when grouped by role too', () => {
		const groups = buildPeopleGroups({ online: [mira, ghost], members: [mira, ghost], self: mira, rooms: [], show: 'all', grouping: 'role' });
		expect(groups.at(-1)?.entries.map((entry) => entry.user.username)).toEqual(['Ghost Writer']);
	});

	test('the viewer who went invisible keeps their place and is told the real state', () => {
		const me = { ...mira, status: 'offline' } as User;
		const groups = buildPeopleGroups({ online: [me, theo], members: [me, theo], self: me, rooms: [], show: 'all', grouping: 'place' });
		expect(groups[0].id).toBe('here');
		const meEntry = groups[0].entries[0];
		expect(meEntry.presence).toBe('invisible');
		expect(personSubline(meEntry)?.text).toBe('You · invisible');
		expect(personAriaLabel('Mira', meEntry, personSubline(meEntry), 'Admin')).toBe('Mira, invisible, you, admin');
		expect(presenceOf(me, true, false)).toBe('offline');
		expect(presenceOf(me, false, true)).toBe('offline');
	});
});

describe('the phone bar facepile (§8.12)', () => {
	test('counts everyone here now, the viewer included, and shows three others by name', () => {
		const pile = facepileOf({ online: [mira, theo, nora, jun, amara], self: mira });
		expect(pile.count).toBe(5);
		expect(pile.faces.map((user) => user.username)).toEqual(['Amara Okafor', 'Jun Sato', 'Nora Ellis']);
	});

	test('away people are here; people the server shows offline are not counted or shown', () => {
		const ghost = person(9, 'Ada Ghost', { status: 'offline' });
		const pile = facepileOf({ online: [mira, sofia, ghost], self: mira });
		expect(pile.count).toBe(2);
		expect(pile.faces.map((user) => user.username)).toEqual(['Sofia Reyes', 'Mira']);
	});

	test('the viewer shows last, and only when there is room; duplicates count once', () => {
		expect(facepileOf({ online: [mira, mira], self: mira }).faces.map((user) => user.username)).toEqual(['Mira']);
		expect(facepileOf({ online: [mira, mira], self: mira }).count).toBe(1);
		expect(facepileOf({ online: [], self: null })).toEqual({ count: 0, faces: [] });
	});
});
