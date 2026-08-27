import type { Channel, User } from './socket-types';
import { getDmDirectoryKey } from './dmUserDirectory';

const FALLBACK_DM_COLOR = '#98D8C8';

export function normalizeDmIdentityId(value: string | number | null | undefined): string {
	const raw = String(value ?? '').trim();
	if (!raw) return '';
	return /^\d+$/.test(raw) ? `user-${raw}` : raw;
}

export function getDmStableUserId(user: User | null | undefined): string {
	if (!user) return '';
	if (typeof user.dbUserId === 'number' && Number.isFinite(user.dbUserId)) {
		return `user-${user.dbUserId}`;
	}
	return normalizeDmIdentityId(user.id);
}

export function getDmIdentityCandidates(user: User | null | undefined): Set<string> {
	const ids = new Set<string>();
	if (!user) return ids;
	const rawId = String(user.id || '').trim();
	if (rawId) ids.add(rawId);
	const stableId = getDmStableUserId(user);
	if (stableId) ids.add(stableId);
	if (typeof user.dbUserId === 'number' && Number.isFinite(user.dbUserId)) {
		ids.add(String(user.dbUserId));
		ids.add(`user-${user.dbUserId}`);
	}
	return ids;
}

function identitiesMatch(left: string | number | null | undefined, right: string | number | null | undefined): boolean {
	const leftRaw = String(left ?? '').trim();
	const rightRaw = String(right ?? '').trim();
	if (!leftRaw || !rightRaw) return false;
	return leftRaw === rightRaw || normalizeDmIdentityId(leftRaw) === normalizeDmIdentityId(rightRaw);
}

export function userMatchesIdentity(user: User | null | undefined, identity: string | number | null | undefined): boolean {
	if (!user) return false;
	const raw = String(identity ?? '').trim();
	if (!raw) return false;
	const normalized = normalizeDmIdentityId(raw);
	return getDmIdentityCandidates(user).has(raw) || getDmIdentityCandidates(user).has(normalized);
}

function findKnownUserByIdentity(identity: string | number | null | undefined, candidates: User[]): User | null {
	const raw = String(identity ?? '').trim();
	if (!raw) return null;
	return candidates.find((candidate) => userMatchesIdentity(candidate, raw)) || null;
}

function findKnownEquivalentUser(user: User, candidates: User[]): User | null {
	return candidates.find((candidate) => {
		if (identitiesMatch(candidate.id, user.id)) return true;
		if (typeof candidate.dbUserId === 'number' && typeof user.dbUserId === 'number') {
			return candidate.dbUserId === user.dbUserId;
		}
		if (typeof user.dbUserId === 'number' && userMatchesIdentity(candidate, `user-${user.dbUserId}`)) return true;
		if (typeof candidate.dbUserId === 'number' && userMatchesIdentity(user, `user-${candidate.dbUserId}`)) return true;
		return false;
	}) || null;
}

export function doesDmChannelIncludeUser(channel: Channel | null | undefined, user: User | null | undefined): boolean {
	if (!channel || channel.type !== 'dm' || !user) return false;
	if (channel.otherUser) {
		if (findKnownEquivalentUser(user, [channel.otherUser])) return true;
		if (userMatchesIdentity(user, channel.otherUser.id)) return true;
		if (typeof channel.otherUser.dbUserId === 'number' && userMatchesIdentity(user, `user-${channel.otherUser.dbUserId}`)) return true;
	}
	return (channel.members || []).some((memberId) => userMatchesIdentity(user, memberId));
}

export function findExistingDmChannel(channels: Channel[], user: User | null | undefined): Channel | null {
	if (!user) return null;
	return channels.find((channel) => doesDmChannelIncludeUser(channel, user)) || null;
}

function dmFallbackName(channel: Channel, identity: string): string {
	const name = String(channel.name || '').trim();
	if (name && name !== channel.id) {
		return name.replace(/^DM\s+with\s+/i, '').trim() || name;
	}
	const normalized = normalizeDmIdentityId(identity);
	if (normalized.startsWith('user-')) return `User ${normalized.slice(5)}`;
	return normalized || 'Unknown';
}

export function resolveDmOtherUser(
	channel: Channel | null | undefined,
	currentUser: User | null | undefined,
	onlineUsers: User[] = [],
	serverMembers: User[] = []
): User | null {
	if (!channel || channel.type !== 'dm') return null;
	const candidates = [...serverMembers, ...onlineUsers];

	if (channel.otherUser && !findKnownEquivalentUser(channel.otherUser, currentUser ? [currentUser] : [])) {
		const known = findKnownEquivalentUser(channel.otherUser, candidates);
		return known ? { ...channel.otherUser, ...known } : channel.otherUser;
	}

	const selfIds = getDmIdentityCandidates(currentUser);
	const otherMemberId = (channel.members || []).find((memberId) => {
		const raw = String(memberId || '').trim();
		if (!raw) return false;
		const normalized = normalizeDmIdentityId(raw);
		return !selfIds.has(raw) && !selfIds.has(normalized);
	});

	if (otherMemberId) {
		const known = findKnownUserByIdentity(otherMemberId, candidates);
		if (known) return known;
	}

	if (channel.otherUser) return channel.otherUser;
	if (!otherMemberId) return null;

	return {
		id: normalizeDmIdentityId(otherMemberId),
		username: dmFallbackName(channel, otherMemberId),
		color: FALLBACK_DM_COLOR,
		status: 'offline'
	};
}

export function buildDmPlaceholderChannel(channelId: string, targetUser: User, currentUser: User | null | undefined): Channel {
	const currentStableId = getDmStableUserId(currentUser);
	const targetStableId = getDmDirectoryKey(targetUser);
	const members = [currentStableId, targetStableId].filter(Boolean);
	return {
		id: channelId,
		name: `DM with ${targetUser.username}`,
		type: 'dm',
		createdAt: Date.now(),
		members,
		otherUser: targetUser,
		memberUsers: currentUser ? [currentUser, targetUser] : [targetUser],
		minRole: 'member'
	} as Channel;
}
