import type { User } from '$lib/socket';
import type { VoiceChannelParticipant } from '$lib/presenceStore';

export function isCurrentUserEntry(user: User, currentUser: User | null): boolean {
	if (!currentUser) return false;
	if (user.id === currentUser.id) return true;
	if (user.dbUserId && currentUser.dbUserId && user.dbUserId === currentUser.dbUserId) return true;
	return false;
}

// DM helpers removed in 2026-06-16 DM-strip pass. Stubs retained so
// existing import sites keep compiling. Each is a no-op that returns
// a value safe for the previous call sites (empty string, 0, null).

export function formatBadgeStub(_count: number): string {
	return '';
}

/** Presence mark color (spec §5.3): online dot, away = warn, busy = danger, offline = a hollow ring. */
export function getStatusColor(status: string): string {
	switch (status) {
		case 'active':
			return 'var(--w-online)';
		case 'away':
			return 'var(--w-warn)';
		case 'busy':
			return 'var(--w-danger)';
		default:
			return 'transparent';
	}
}

export function computeTotalUnreadDMsStub(_channelUnreadCounts: Record<string, number>): number {
	return 0;
}

export function getUserUnreadCountStub(
	_user: User,
	channelUnreadCounts: Record<string, number>,
	_dmIdFn: (current: User, target: User) => string,
	_currentUser: User | null
): number {
	return 0;
}

export function createSyntheticMouseEvent(touch: Touch): MouseEvent {
	return {
		preventDefault: () => {},
		stopPropagation: () => {},
		clientX: touch.clientX,
		clientY: touch.clientY
	} as unknown as MouseEvent;
}

export function extractUserFromEventStub(
	event: CustomEvent<{ user: User }> | User | undefined,
	contextMenuUser: User | null
): User | null {
	if (!event) return contextMenuUser;
	if ('detail' in event && event.detail?.user) return event.detail.user;
	if ('id' in event) return event as User;
	return contextMenuUser;
}

// ---------------------------------------------------------------------------------------------
// People companion (spec §7.11 member row, §8.4 People): grouped by where people are.
// ---------------------------------------------------------------------------------------------

/** Who the list shows (the filter menu's "Show" group). */
export type PeopleShow = 'all' | 'here' | 'away' | 'offline';
/** How the list is grouped (the filter menu's "Group" group). */
export type PeopleGrouping = 'place' | 'role';
/**
 * 'invisible' is only ever the viewer's own row: the server masks Invisible as "offline" for
 * everyone (the viewer's own stores included), so another person who reads "offline" is listed as
 * offline even while connected; only the viewer is told the real state.
 */
export type PeoplePresence = 'active' | 'away' | 'busy' | 'offline' | 'invisible';
export type PeopleVoiceState = 'speaking' | 'listening' | 'muted' | 'deafened';

export const PEOPLE_SHOW_LABELS: Record<PeopleShow, string> = {
	all: 'Everyone',
	here: 'Here now',
	away: 'Away',
	offline: 'Offline'
};

/** A voice room as the roster needs it: its name and who is in it right now. */
export interface PeopleVoiceRoom {
	id: string;
	name: string;
	members: readonly VoiceChannelParticipant[];
}

export interface PersonEntry {
	user: User;
	presence: PeoplePresence;
	/** The voice room this person is in, if any. */
	room: { id: string; name: string } | null;
	voice: PeopleVoiceState | null;
	isSelf: boolean;
}

export interface PeopleGroup {
	/** Stable key: `room:<id>`, `here`, `away`, `offline` or `role:<name>`. */
	id: string;
	/** Sentence-case label; the kicker style upper-cases it ("In Studio lounge" → IN STUDIO LOUNGE). */
	label: string;
	kind: 'room' | 'here' | 'away' | 'offline' | 'role';
	entries: PersonEntry[];
}

export interface BuildPeopleGroupsInput {
	/** Everyone connected right now (the viewer included). */
	online: readonly User[];
	/** Every member of the community, online or not. */
	members: readonly User[];
	self: User | null;
	/** Voice rooms in sidebar order. */
	rooms: readonly PeopleVoiceRoom[];
	show: PeopleShow;
	grouping: PeopleGrouping;
	/** Search predicate (true keeps the person). */
	matches?: (user: User) => boolean;
	displayName?: (user: User) => string;
	/** Role grouping only. */
	rolePriority?: Record<string, number>;
	roleLabel?: (role: string) => string;
}

/** One identity per person: the account id when there is one, else the socket id. */
export function personKey(user: User): string {
	if (typeof user.dbUserId === 'number') return `db:${user.dbUserId}`;
	return `id:${user.id}`;
}

/** Voice participants carry a stable `user-<dbUserId>` id, a socket id, or both. */
export function participantMatchesUser(participant: VoiceChannelParticipant, user: User): boolean {
	if (!participant) return false;
	const ids = [participant.userId, participant.socketId].filter((id): id is string => Boolean(id));
	if (ids.includes(user.id)) return true;
	if (typeof user.dbUserId === 'number') {
		const stable = `user-${user.dbUserId}`;
		if (ids.includes(stable) || ids.includes(String(user.dbUserId))) return true;
	}
	return false;
}

export function voiceStateOf(participant: VoiceChannelParticipant): PeopleVoiceState {
	if (participant.isDeafened) return 'deafened';
	if (participant.isMuted) return 'muted';
	if (participant.isSpeaking) return 'speaking';
	return 'listening';
}

/**
 * Where a person is, as far as observers may know. Invisible reaches every client as the status
 * "offline" (presence.rs masks it, so no one can tell it from a real leave): a connected person
 * whose status is "offline" is shown offline, never "Here now". The viewer sees their own truth.
 */
export function presenceOf(user: User, online: boolean, isSelf = false): PeoplePresence {
	if (!online) return 'offline';
	if (user.status === 'offline') return isSelf ? 'invisible' : 'offline';
	if (user.status === 'away' || user.status === 'busy') return user.status;
	return 'active';
}

function unique(list: readonly User[]): User[] {
	const seen = new Set<string>();
	const out: User[] = [];
	for (const user of list) {
		if (!user) continue;
		const key = personKey(user);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(user);
	}
	return out;
}

function showsEntry(entry: PersonEntry, show: PeopleShow): boolean {
	if (show === 'all') return true;
	if (show === 'offline') return entry.presence === 'offline';
	if (show === 'away') return entry.presence === 'away';
	return entry.presence === 'active' || entry.presence === 'busy' || entry.presence === 'invisible';
}

/**
 * Everyone in the community as roster entries: online people first (with their voice room, if
 * they are in one), then members who are not connected. Pure; the panel derives it from stores.
 */
export function buildPeopleEntries(input: Pick<BuildPeopleGroupsInput, 'online' | 'members' | 'self' | 'rooms'>): PersonEntry[] {
	const online = unique(input.online);
	const onlineKeys = new Set(online.map(personKey));
	const offline = unique(input.members).filter((user) => !onlineKeys.has(personKey(user)));
	const self = input.self;
	const entries: PersonEntry[] = [];
	for (const user of online) {
		const isSelf = isCurrentUserEntry(user, self);
		const presence = presenceOf(user, true, isSelf);
		let room: PersonEntry['room'] = null;
		let voice: PeopleVoiceState | null = null;
		// Someone shown offline (Invisible, masked by the server) is offline here too: no room, no
		// voice state, so the row never says more than a real leave would.
		for (const candidate of presence === 'offline' ? [] : input.rooms) {
			const participant = candidate.members.find((member) => participantMatchesUser(member, user));
			if (!participant) continue;
			room = { id: candidate.id, name: candidate.name };
			voice = voiceStateOf(participant);
			break;
		}
		entries.push({ user, presence, room, voice, isSelf });
	}
	for (const user of offline) {
		entries.push({ user, presence: 'offline', room: null, voice: null, isSelf: isCurrentUserEntry(user, self) });
	}
	return entries;
}

/** Alphabetical by the name on screen, the viewer first (spec §8.4). */
export function sortPeopleEntries(entries: PersonEntry[], displayName: (user: User) => string = (user) => user.username): PersonEntry[] {
	return [...entries].sort((a, b) => {
		if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
		const byName = displayName(a.user).localeCompare(displayName(b.user), undefined, { sensitivity: 'base' });
		return byName !== 0 ? byName : personKey(a.user).localeCompare(personKey(b.user));
	});
}

/**
 * The People companion's groups. By place (default): "In <room>" for each voice room with people
 * in it, then "Here now", "Away", "Offline". By role: one group per role of the people online
 * (highest first), then "Offline". Empty groups are left out.
 */
export function buildPeopleGroups(input: BuildPeopleGroupsInput): PeopleGroup[] {
	const displayName = input.displayName ?? ((user: User) => user.username);
	const matches = input.matches ?? (() => true);
	const entries = buildPeopleEntries(input).filter((entry) => showsEntry(entry, input.show) && matches(entry.user));
	const groups: PeopleGroup[] = [];
	const push = (group: PeopleGroup) => {
		if (group.entries.length > 0) groups.push({ ...group, entries: sortPeopleEntries(group.entries, displayName) });
	};
	const connected = entries.filter((entry) => entry.presence !== 'offline');
	if (input.grouping === 'role') {
		const priority = input.rolePriority ?? {};
		const byRole = new Map<string, PersonEntry[]>();
		for (const entry of connected) {
			const role = entry.user.highestRole || 'member';
			byRole.set(role, [...(byRole.get(role) ?? []), entry]);
		}
		const roles = [...byRole.keys()].sort((a, b) => (priority[b] ?? 0) - (priority[a] ?? 0) || a.localeCompare(b));
		for (const role of roles) {
			push({ id: `role:${role}`, label: input.roleLabel?.(role) ?? role, kind: 'role', entries: byRole.get(role) ?? [] });
		}
	} else {
		for (const room of input.rooms) {
			push({ id: `room:${room.id}`, label: `In ${room.name}`, kind: 'room', entries: connected.filter((entry) => entry.room?.id === room.id) });
		}
		const elsewhere = connected.filter((entry) => !entry.room);
		push({ id: 'here', label: 'Here now', kind: 'here', entries: elsewhere.filter((entry) => entry.presence !== 'away') });
		push({ id: 'away', label: 'Away', kind: 'away', entries: elsewhere.filter((entry) => entry.presence === 'away') });
	}
	push({ id: 'offline', label: 'Offline', kind: 'offline', entries: entries.filter((entry) => entry.presence === 'offline') });
	return groups;
}

export const VOICE_STATE_LABELS: Record<PeopleVoiceState, string> = {
	speaking: 'Speaking',
	listening: 'Listening',
	muted: 'Muted',
	deafened: 'Deafened'
};

export type PersonSublineGlyph = 'voice' | 'headphones' | 'micOff' | 'headphonesOff';

/** What the second line says: the row's accessible name carries only the short kinds. */
export type PersonSublineKind = 'voice' | 'self' | 'activity' | 'status' | 'bio' | 'handle';

export interface PersonSubline {
	text: string;
	kind: PersonSublineKind;
	glyph: PersonSublineGlyph | null;
	/** 'handle' is set in mono; 'speaking' tints the glyph --w-online. */
	tone: 'plain' | 'handle' | 'speaking';
}

const VOICE_GLYPHS: Record<PeopleVoiceState, PersonSublineGlyph> = {
	speaking: 'voice',
	listening: 'headphones',
	muted: 'micOff',
	deafened: 'headphonesOff'
};

function firstLine(text: string | undefined | null): string {
	return (text ?? '').split(/\r?\n/, 1)[0].trim();
}

/**
 * The second line of a member row (spec §7.11): voice state, else "You", else what they are doing
 * ("Writing in #general"), else their status message, bio or handle. Null for a one-line row.
 */
export function personSubline(entry: PersonEntry, writingIn: string | null = null): PersonSubline | null {
	if (entry.voice) {
		const state = VOICE_STATE_LABELS[entry.voice];
		return {
			text: entry.isSelf ? `You · ${state}` : state,
			kind: 'voice',
			glyph: VOICE_GLYPHS[entry.voice],
			tone: entry.voice === 'speaking' ? 'speaking' : 'plain'
		};
	}
	if (entry.isSelf) return { text: entry.presence === 'invisible' ? 'You · invisible' : 'You', kind: 'self', glyph: null, tone: 'plain' };
	if (writingIn && entry.presence !== 'offline') return { text: `Writing in ${writingIn}`, kind: 'activity', glyph: null, tone: 'plain' };
	const status = firstLine(entry.user.statusMessage);
	if (status) return { text: status, kind: 'status', glyph: null, tone: 'plain' };
	const bio = firstLine(entry.user.bio);
	if (bio) return { text: bio, kind: 'bio', glyph: null, tone: 'plain' };
	if (entry.user.handle) return { text: `@${entry.user.handle}`, kind: 'handle', glyph: null, tone: 'handle' };
	return null;
}

const PRESENCE_WORDS: Record<PeoplePresence, string> = {
	active: 'here now',
	away: 'away',
	busy: 'busy',
	offline: 'offline',
	invisible: 'invisible'
};

/**
 * "Theo Park, in Studio lounge, listening" (spec §7.11): who, where, voice state, "you", what
 * they are doing right now, then the role word. Free text the person wrote (status message, bio)
 * and the handle are not part of the name: they are the row's description (personDescription).
 */
export function personAriaLabel(name: string, entry: PersonEntry, subline: PersonSubline | null, roleWord: string | null): string {
	const parts = [name];
	if (entry.room) parts.push(`in ${entry.room.name}`);
	else parts.push(PRESENCE_WORDS[entry.presence]);
	if (entry.room && entry.presence !== 'active') parts.push(PRESENCE_WORDS[entry.presence]);
	if (entry.voice) parts.push(VOICE_STATE_LABELS[entry.voice].toLowerCase());
	if (entry.isSelf) parts.push('you');
	else if (subline?.kind === 'activity') parts.push(subline.text);
	if (roleWord) parts.push(roleWord.toLowerCase());
	return parts.join(', ');
}

/** The subline a row's aria-describedby points at: status message, bio or handle; else null. */
export function personDescription(subline: PersonSubline | null): string | null {
	if (!subline) return null;
	return subline.kind === 'status' || subline.kind === 'bio' || subline.kind === 'handle' ? subline.text : null;
}

/** Typing indicators name people by username or id; only shared channels count as activity. */
export function writingChannelFor(
	user: User,
	typing: Record<string, readonly string[]>,
	channels: readonly { id: string; name: string; type?: string | null }[],
	preferredChannelId: string | null = null
): string | null {
	const ids = [user.username, user.id, typeof user.dbUserId === 'number' ? `user-${user.dbUserId}` : null].filter(Boolean) as string[];
	const order = preferredChannelId ? [preferredChannelId, ...Object.keys(typing).filter((id) => id !== preferredChannelId)] : Object.keys(typing);
	for (const channelId of order) {
		const who = typing[channelId];
		if (!who || !who.some((name) => ids.includes(name))) continue;
		const channel = channels.find((candidate) => candidate.id === channelId);
		if (!channel || channel.type === 'dm' || channel.type === 'group' || channel.type === 'voice') continue;
		return channel.type === 'text' || !channel.type ? `#${channel.name}` : channel.name;
	}
	return null;
}
