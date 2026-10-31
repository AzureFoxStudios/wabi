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

export type NoteProblemKind = 'load' | 'save';

export interface NoteProblemCopy {
	title: string;
	text: string;
	/** Offer "Download draft" (only when there is draft text to keep). */
	canDownload: boolean;
	/** The one way back: reload the saved note, or try opening it again. */
	retryLabel: string;
}

/**
 * What the note's notice says (§7.16: the cause, then what is unchanged). It only promises a
 * draft when there is one: a note that failed to open with nothing kept on this device offers
 * just "Try again".
 */
export function noteProblemCopy(kind: NoteProblemKind, hasDraft: boolean): NoteProblemCopy {
	if (kind === 'save') {
		return hasDraft
			? { title: "Couldn't save the note.", text: 'Your draft is still here on this device.', canDownload: true, retryLabel: 'Load saved note' }
			: { title: "Couldn't clear the note.", text: 'The saved note is unchanged.', canDownload: false, retryLabel: 'Load saved note' };
	}
	return hasDraft
		? { title: "Couldn't open the saved note.", text: 'Your unsaved draft is still here on this device.', canDownload: true, retryLabel: 'Load saved note' }
		: { title: "Couldn't open this note.", text: 'Nothing was changed. Try again in a moment.', canDownload: false, retryLabel: 'Try again' };
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

function friendLabel(state: FriendState): string {
	if (state === 'incoming') return 'Accept friend request';
	if (state === 'outgoing') return 'Cancel friend request';
	return 'Add friend';
}

/**
 * The ⋯ rows: open · call · friends and this device · server role (a radio list under a kicker)
 * · moderation (seal glyph, under a kicker), then the destructive rows (remove friend, ban) as
 * the last group (§7.4). The menu draws danger rows last as well; building them last keeps this
 * list in the order people read it.
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

	const friendRows = input.canFriend && input.friendsReady;
	const personal: MenuEntry[] = [];
	if (friendRows && input.friendState !== 'friend') {
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
	group('personal', personal);

	const destructive: MenuEntry[] = [];
	if (friendRows && input.friendState === 'friend') {
		destructive.push({ id: 'remove-friend', label: 'Remove friend', icon: 'x', danger: true, disabled: input.friendBusy, onSelect: input.onRemoveFriend });
	}

	if (input.canManageRoles) {
		// The person's server role as a radio list: the checked row is the role they hold now, so a
		// screen reader hears "Admin, checked" only when that is true. Role names are names
		// (keepCase), and "Member" takes back any role.
		// A role this short list does not show (the member list has them all) checks no row.
		const current = input.targetRole || 'member';
		const roleRows: MenuEntry[] = [{ roleName: 'member', displayName: 'Member' }, ...input.roles].map((role) => ({
			id: `role-${role.roleName}`,
			label: role.displayName,
			keepCase: true,
			role: 'menuitemradio',
			checked: current === role.roleName,
			onSelect: () => {
				if (current !== role.roleName) input.onSetRole(role.roleName);
			}
		}));
		group('roles', roleRows, 'Server role');
		if (input.isBanned) {
			group('moderation', [{ id: 'unban', label: 'Unban from server', icon: 'shield', seal: true, onSelect: input.onUnbanUser }], 'Moderation');
		} else {
			destructive.push({ id: 'ban', label: 'Ban from server', icon: 'shield', danger: true, onSelect: input.onBanUser });
		}
	}
	group('danger', destructive);
	return rows;
}
