/**
 * Words and menu rows for the profile popout (design contract §7.11, §8.9): identity first, then
 * one primary "Message", a default "Call" and a ⋯ menu that holds everything else. Kept out of the
 * components so the order, the seal on moderation rows and the copy can be tested without a DOM.
 */
import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';

export type Presence = 'online' | 'away' | 'busy' | 'offline';

/** The presence a status draws (§5.3): online dot, away warn, busy danger, offline hollow ring. */
export function presenceOf(status: string | null | undefined): Presence {
	switch (status) {
		case 'active':
		case 'online':
			return 'online';
		case 'away':
		case 'idle':
			return 'away';
		case 'busy':
		case 'dnd':
			return 'busy';
		default:
			return 'offline';
	}
}

/** Locale key of the presence word ("Online", "Away", "Do not disturb", "Offline"). */
export function presenceLabelKey(presence: Presence): string {
	return presence === 'online' ? 'user.status.online' : `user.status.${presence}`;
}

/** One initial for the stamp (§7.12), from the first character of the shown name. */
export function stampInitial(name: string | null | undefined): string {
	const first = Array.from((name ?? '').trim())[0];
	return first ? first.toLocaleUpperCase() : '?';
}

/** "Member since Sep 2026", or '' when the date is missing or unreadable. */
export function memberSince(joinedAt: string | number | null | undefined, locale?: string): string {
	if (joinedAt === null || joinedAt === undefined || joinedAt === '') return '';
	const date = new Date(joinedAt);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleDateString(locale, { month: 'short', year: 'numeric' });
}

export type FriendState = 'none' | 'incoming' | 'outgoing' | 'friend';

export interface ProfileMenuInput {
	isOwnProfile: boolean;
	/** Registered account (guests have none): games and friends need one. */
	hasAccount: boolean;
	profileExpanded: boolean;
	inSidePanel: boolean;
	/** Friend rows only once the friendship list is loaded and the person can be friended. */
	friendsReady: boolean;
	canFriend: boolean;
	friendState: FriendState;
	friendBusy: boolean;
	localNicknamesEnabled: boolean;
	localNickname: string;
	canManageRoles: boolean;
	targetRole: string;
	roles: Array<{ roleName: string; displayName: string }>;
	isBanned: boolean;
	onOpenFullProfile: () => void;
	onOpenGames: () => void;
	onVideoCall: () => void;
	onScreenShare: () => void;
	onFriendAction: () => void;
	onRemoveFriend: () => void;
	onSetLocalNickname: () => void;
	onClearLocalNickname: () => void;
	onSetRole: (role: string) => void;
	onBanUser: () => void;
	onUnbanUser: () => void;
}

const STAFF_ROLES = ['admin', 'developer', 'mod', 'artist'];

function friendLabel(state: FriendState): string {
	if (state === 'incoming') return 'Accept friend request';
	if (state === 'outgoing') return 'Cancel friend request';
	return 'Add friend';
}

/**
 * The ⋯ rows: open · call · friends and this device · moderation (seal glyphs, under a kicker),
 * with the destructive rows (remove friend, ban) last.
 */
export function buildProfileMenu(input: ProfileMenuInput): MenuEntry[] {
	const rows: MenuEntry[] = [];
	const group = (id: string, entries: MenuEntry[], kicker?: string) => {
		if (!entries.length) return;
		if (kicker) rows.push({ id: `${id}-kicker`, type: 'kicker', label: kicker });
		else if (rows.length) rows.push({ id: `${id}-rule`, type: 'separator' });
		rows.push(...entries);
	};

	const fullProfileLabel = input.profileExpanded ? (input.inSidePanel ? 'Return to side panel' : 'Back to popout') : 'View full profile';
	const open: MenuEntry[] = [{ id: 'full-profile', label: fullProfileLabel, icon: input.profileExpanded ? 'collapse' : 'expand', onSelect: input.onOpenFullProfile }];
	if (input.hasAccount) open.push({ id: 'games', label: 'Games', icon: 'gamepad', keepCase: true, onSelect: input.onOpenGames });
	group('open', open);

	if (input.isOwnProfile) return rows;

	group('call', [
		{ id: 'video-call', label: 'Video call', icon: 'video', onSelect: input.onVideoCall },
		{ id: 'screen-share', label: 'Share screen', icon: 'screen', onSelect: input.onScreenShare }
	]);

	const personal: MenuEntry[] = [];
	if (input.canFriend && input.friendsReady && input.friendState !== 'friend') {
		personal.push({
			id: 'friend',
			label: friendLabel(input.friendState),
			icon: input.friendState === 'outgoing' ? 'x' : input.friendState === 'incoming' ? 'check' : 'userPlus',
			disabled: input.friendBusy,
			onSelect: input.onFriendAction
		});
	}
	if (input.localNicknamesEnabled) {
		personal.push({
			id: 'nickname',
			label: input.localNickname ? 'Change nickname on this device' : 'Set nickname on this device',
			icon: 'pencil',
			onSelect: input.onSetLocalNickname
		});
		if (input.localNickname) personal.push({ id: 'clear-nickname', label: 'Clear nickname on this device', icon: 'minus', onSelect: input.onClearLocalNickname });
	}
	if (input.canFriend && input.friendsReady && input.friendState === 'friend') {
		personal.push({ id: 'remove-friend', label: 'Remove friend', icon: 'x', danger: true, disabled: input.friendBusy, onSelect: input.onRemoveFriend });
	}
	group('personal', personal);

	if (input.canManageRoles) {
		const moderation: MenuEntry[] = input.roles.map((role) => {
			const has = input.targetRole === role.roleName;
			return {
				id: `role-${role.roleName}`,
				label: has ? `Remove ${role.displayName}` : `Make ${role.displayName}`,
				icon: 'shield',
				seal: true,
				keepCase: true,
				role: 'menuitemcheckbox',
				checked: has,
				onSelect: () => input.onSetRole(has ? 'member' : role.roleName)
			} satisfies MenuEntry;
		});
		if (input.roles.some((role) => role.roleName === input.targetRole) || STAFF_ROLES.includes(input.targetRole)) {
			moderation.push({ id: 'reset-role', label: 'Reset to member', icon: 'undo', seal: true, onSelect: () => input.onSetRole('member') });
		}
		moderation.push(
			input.isBanned
				? { id: 'unban', label: 'Unban from server', icon: 'shield', seal: true, onSelect: input.onUnbanUser }
				: { id: 'ban', label: 'Ban from server', icon: 'shield', danger: true, onSelect: input.onBanUser }
		);
		group('moderation', moderation, 'Moderation');
	}
	return rows;
}
