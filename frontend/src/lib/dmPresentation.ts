import { getDmIdentityCandidates, normalizeDmIdentityId, userMatchesIdentity } from './dmConversations';
import type { Channel, User } from './socket-types';

export type DmPresence = 'active' | 'away' | 'busy' | 'offline' | 'unavailable';

/** The full member directory is not a presence source; only live socket users are. */
export function livePresenceForUser(user: User | null | undefined, liveUsers: User[], connected: boolean): DmPresence {
	if (!user || !connected) return 'unavailable';
	const identities = getDmIdentityCandidates(user);
	const matches = liveUsers.filter((candidate) =>
		[...identities].some((identity) => userMatchesIdentity(candidate, identity))
	);
	if (matches.some((candidate) => candidate.status === 'active')) return 'active';
	if (matches.some((candidate) => candidate.status === 'away')) return 'away';
	if (matches.some((candidate) => candidate.status === 'busy')) return 'busy';
	return 'offline';
}

export function groupRecipientSummary(channel: Channel | null | undefined, self: User | null | undefined, directory: User[]): string {
	if (!channel || channel.type !== 'group') return '';
	const members = channel.members?.length
		? channel.members
		: (channel.memberUsers || []).map((member) => member.id);
	const others = [...new Set(members.filter((memberId) => !self || !userMatchesIdentity(self, memberId)).map(normalizeDmIdentityId))];
	const candidates = [...(channel.memberUsers || []), ...directory];
	const names = others
		.map((memberId) => candidates.find((candidate) => userMatchesIdentity(candidate, memberId))?.username?.trim())
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) return others.length ? `${others.length} other ${others.length === 1 ? 'member' : 'members'}` : '';
	const shown = names.slice(0, 3);
	const remaining = others.length - shown.length;
	return `${shown.join(', ')}${remaining > 0 ? ` +${remaining} more` : ''}`;
}

export function missingDeviceParticipantNames(userIds: number[], directory: User[]): string[] {
	return userIds
		.map((userId) => directory.find((user) => userMatchesIdentity(user, `user-${userId}`))?.username?.trim())
		.filter((name): name is string => Boolean(name));
}

export function missingDeviceParticipantLabel(userIds: number[], directory: User[]): string {
	const names = missingDeviceParticipantNames(userIds, directory);
	const unnamed = userIds.length - names.length;
	const parts = [...names];
	if (unnamed > 0) parts.push(`${unnamed} other ${unnamed === 1 ? 'participant' : 'participants'}`);
	return parts.join(', ');
}
