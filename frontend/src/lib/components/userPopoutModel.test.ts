import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildProfileMenu, memberSince, presenceLabelKey, presenceOf, stampInitial, type ProfileMenuInput } from './userPopoutModel';

const noop = () => {};
function input(patch: Partial<ProfileMenuInput> = {}): ProfileMenuInput {
	return {
		isOwnProfile: false,
		hasAccount: true,
		profileExpanded: false,
		inSidePanel: false,
		friendsReady: true,
		canFriend: true,
		friendState: 'none',
		friendBusy: false,
		localNicknamesEnabled: true,
		localNickname: '',
		canManageRoles: false,
		targetRole: 'member',
		roles: [],
		isBanned: false,
		onOpenFullProfile: noop,
		onOpenGames: noop,
		onVideoCall: noop,
		onScreenShare: noop,
		onFriendAction: noop,
		onRemoveFriend: noop,
		onSetLocalNickname: noop,
		onClearLocalNickname: noop,
		onSetRole: noop,
		onBanUser: noop,
		onUnbanUser: noop,
		...patch
	};
}
const ids = (patch: Partial<ProfileMenuInput> = {}) => buildProfileMenu(input(patch)).map((entry) => entry.id);

describe('profile popout words', () => {
	test('presence maps to the four marks and their words', () => {
		expect(presenceOf('active')).toBe('online');
		expect(presenceOf('away')).toBe('away');
		expect(presenceOf('busy')).toBe('busy');
		expect(presenceOf('invisible')).toBe('offline');
		expect(presenceOf(undefined)).toBe('offline');
		expect(presenceLabelKey('online')).toBe('user.status.online');
		expect(presenceLabelKey('busy')).toBe('user.status.busy');
	});

	test('the stamp takes one initial, emoji and combining marks included', () => {
		expect(stampInitial('nora ellis')).toBe('N');
		expect(stampInitial('  ')).toBe('?');
		expect(stampInitial('🌿 garden')).toBe('🌿');
	});

	test('member since is empty for a missing or unreadable date', () => {
		expect(memberSince(undefined)).toBe('');
		expect(memberSince('not a date')).toBe('');
		expect(memberSince('2026-09-01T00:00:00Z', 'en-US')).toBe('Sep 2026');
	});
});

describe('profile ⋯ menu (§8.9)', () => {
	test('someone else: open, call, then friends and this device', () => {
		expect(ids()).toEqual(['full-profile', 'games', 'call-rule', 'video-call', 'screen-share', 'personal-rule', 'friend', 'nickname']);
	});

	test('your own profile keeps only open rows', () => {
		expect(ids({ isOwnProfile: true })).toEqual(['full-profile', 'games']);
		expect(ids({ isOwnProfile: true, hasAccount: false })).toEqual(['full-profile']);
	});

	test('friend rows follow the relation, and remove friend is danger', () => {
		const incoming = buildProfileMenu(input({ friendState: 'incoming' })).find((entry) => entry.id === 'friend');
		expect(incoming?.label).toBe('Accept friend request');
		const friend = buildProfileMenu(input({ friendState: 'friend' }));
		expect(friend.some((entry) => entry.id === 'friend')).toBe(false);
		expect(friend.find((entry) => entry.id === 'remove-friend')?.danger).toBe(true);
		expect(ids({ friendsReady: false })).not.toContain('friend');
	});

	test('a nickname on this device can be changed or cleared', () => {
		const rows = buildProfileMenu(input({ localNickname: 'Nono' }));
		expect(rows.find((entry) => entry.id === 'nickname')?.label).toBe('Change nickname on this device');
		expect(rows.some((entry) => entry.id === 'clear-nickname')).toBe(true);
		expect(ids({ localNicknamesEnabled: false })).not.toContain('nickname');
	});

	test('moderation sits under a kicker with seal glyphs; ban is danger and unban is not', () => {
		const rows = buildProfileMenu(
			input({ canManageRoles: true, targetRole: 'artist', roles: [{ roleName: 'artist', displayName: 'Artist' }, { roleName: 'mod', displayName: 'Moderator' }] })
		);
		const kicker = rows.findIndex((entry) => entry.type === 'kicker');
		expect(rows[kicker].label).toBe('Moderation');
		const moderation = rows.slice(kicker + 1);
		expect(moderation.map((entry) => entry.id)).toEqual(['role-artist', 'role-mod', 'reset-role', 'ban']);
		expect(moderation.find((entry) => entry.id === 'role-artist')).toMatchObject({ label: 'Remove Artist', checked: true, seal: true });
		expect(moderation.find((entry) => entry.id === 'role-mod')).toMatchObject({ label: 'Make Moderator', checked: false, seal: true });
		expect(moderation.find((entry) => entry.id === 'ban')).toMatchObject({ danger: true });
		const banned = buildProfileMenu(input({ canManageRoles: true, isBanned: true }));
		expect(banned.find((entry) => entry.id === 'unban')).toMatchObject({ seal: true });
		expect(banned.find((entry) => entry.id === 'unban')?.danger).toBeUndefined();
	});

	test('every row label is sentence case', () => {
		const rows = buildProfileMenu(input({ canManageRoles: true, friendState: 'friend', localNickname: 'x' }));
		for (const entry of rows) {
			if (!entry.label || entry.keepCase) continue;
			expect(entry.label.slice(1)).toBe(entry.label.slice(1).toLowerCase());
		}
	});
});

describe('profile popout components', () => {
	const impl = readFileSync(new URL('./UserPopoutImpl.svelte', import.meta.url), 'utf8');
	const actions = readFileSync(new URL('./UserPopoutActions.svelte', import.meta.url), 'utf8');
	const css = readFileSync(new URL('../../styles/components/user-popout.css', import.meta.url), 'utf8');

	test('identity comes before the actions, and the note after them', () => {
		const identity = impl.indexOf('class="pop-id"');
		const actionRow = impl.indexOf('<UserPopoutActions');
		const note = impl.indexOf('class="pop-note"');
		expect(identity).toBeGreaterThan(0);
		expect(identity).toBeLessThan(actionRow);
		expect(actionRow).toBeLessThan(note);
		expect(impl).toContain("$_('user.popout.note_placeholder')");
	});

	test('Message is the one ink primary; there are no native prompts or confirms', () => {
		expect(actions).toMatch(/class="w-btn w-btn--primary pop-actions__main"[^>]*on:click=\{onOpenDM\}/);
		expect((actions.match(/w-btn--primary/g) ?? []).length).toBe(2); // one per branch (others, you)
		for (const source of [impl, actions]) expect(source).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
		expect(actions).toContain('confirmAction(');
		expect(impl).toContain('confirmAction(');
	});

	test('the popout is drawn on roles: no raw colors, no accent-filled primary', () => {
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|:\s*white\b/i);
		expect(css).not.toMatch(/--accent-rgb|--status-|--surface-|--text-/);
		expect(css).not.toMatch(/background:\s*var\(--w-accent\)/);
		expect(css).not.toMatch(/transition:\s*all/);
		expect(impl).toContain('$inkFor(identityColor)');
	});
});
