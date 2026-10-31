import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildProfileMenu, memberSince, noteProblemCopy, presenceLabelKey, presenceOf, stampInitial, type ProfileMenuInput } from './userPopoutModel';

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

	test('the note notice promises a draft only when one exists', () => {
		expect(noteProblemCopy('load', false)).toEqual({
			title: "Couldn't open this note.",
			text: 'Nothing was changed. Try again in a moment.',
			canDownload: false,
			retryLabel: 'Try again'
		});
		expect(noteProblemCopy('load', true)).toMatchObject({ text: 'Your unsaved draft is still here on this device.', canDownload: true, retryLabel: 'Load saved note' });
		expect(noteProblemCopy('save', true)).toMatchObject({ title: "Couldn't save the note.", text: 'Your draft is still here on this device.', canDownload: true });
		expect(noteProblemCopy('save', false)).toMatchObject({ title: "Couldn't clear the note.", canDownload: false });
		for (const kind of ['load', 'save'] as const) {
			expect(noteProblemCopy(kind, false).text).not.toMatch(/draft is still here/);
		}
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

	test('danger rows come last, after moderation, for staff viewers too', () => {
		const order = ids({
			canManageRoles: true,
			friendState: 'friend',
			roles: [{ roleName: 'admin', displayName: 'Admin' }]
		});
		expect(order.slice(-3)).toEqual(['danger-rule', 'remove-friend', 'ban']);
		expect(order.indexOf('roles-kicker')).toBeLessThan(order.indexOf('remove-friend'));
		const rows = buildProfileMenu(input({ canManageRoles: true, friendState: 'friend' }));
		const firstDanger = rows.findIndex((entry) => entry.danger);
		expect(rows.slice(firstDanger).every((entry) => entry.danger || entry.type === 'separator')).toBe(true);
	});

	test('a nickname on this device can be changed or cleared', () => {
		const rows = buildProfileMenu(input({ localNickname: 'Nono' }));
		expect(rows.find((entry) => entry.id === 'nickname')?.label).toBe('Change nickname on this device');
		expect(rows.some((entry) => entry.id === 'clear-nickname')).toBe(true);
		expect(ids({ localNicknamesEnabled: false })).not.toContain('nickname');
	});

	test('the server role is a radio list whose checked row is the role held now', () => {
		const set: string[] = [];
		const rows = buildProfileMenu(
			input({
				canManageRoles: true,
				targetRole: 'artist',
				roles: [{ roleName: 'artist', displayName: 'Artist' }, { roleName: 'mod', displayName: 'Moderator' }],
				onSetRole: (role) => set.push(role)
			})
		);
		const kicker = rows.findIndex((entry) => entry.type === 'kicker');
		expect(rows[kicker].label).toBe('Server role');
		const roleRows = rows.filter((entry) => entry.id.startsWith('role-'));
		expect(roleRows.map((entry) => entry.id)).toEqual(['role-member', 'role-artist', 'role-mod']);
		for (const entry of roleRows) expect(entry.role).toBe('menuitemradio');
		expect(roleRows.map((entry) => [entry.label, entry.checked])).toEqual([['Member', false], ['Artist', true], ['Moderator', false]]);
		// No "Remove X, checked" rows, and no Title Case verb phrases.
		expect(rows.some((entry) => /^(Make|Remove) [A-Z]/.test(entry.label ?? ''))).toBe(false);
		roleRows[0].onSelect?.();
		roleRows[1].onSelect?.();
		roleRows[2].onSelect?.();
		expect(set).toEqual(['member', 'mod']);
		// A role this short list does not show checks nothing rather than claiming "Member".
		const hidden = buildProfileMenu(input({ canManageRoles: true, targetRole: 'developer', roles: [{ roleName: 'mod', displayName: 'Moderator' }] }));
		expect(hidden.filter((entry) => entry.checked).length).toBe(0);
	});

	test('ban is danger and last; unban sits under Moderation with the seal', () => {
		const rows = buildProfileMenu(input({ canManageRoles: true }));
		expect(rows.at(-1)).toMatchObject({ id: 'ban', danger: true, icon: 'shield' });
		const banned = buildProfileMenu(input({ canManageRoles: true, isBanned: true }));
		const kicker = banned.findIndex((entry) => entry.id === 'moderation-kicker');
		expect(banned[kicker + 1]).toMatchObject({ id: 'unban', seal: true, icon: 'shield' });
		expect(banned.find((entry) => entry.id === 'unban')?.danger).toBeUndefined();
		// The shield means server moderation only: no other row wears it.
		const other = buildProfileMenu(input({ canManageRoles: true, roles: [{ roleName: 'mod', displayName: 'Moderator' }] }));
		expect(other.filter((entry) => entry.icon === 'shield').map((entry) => entry.id)).toEqual(['ban']);
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

	test('saving the note keeps focus in the field (readonly while busy, never disabled)', () => {
		const field = impl.slice(impl.indexOf('<textarea'), impl.indexOf('</textarea>'));
		expect(field).toContain('disabled={!noteReady}');
		expect(field).toContain('readonly={noteBusy}');
		expect(field).toContain('aria-busy={noteBusy}');
		expect(field).not.toMatch(/disabled=\{[^}]*noteBusy/);
		expect(impl).toContain('noteProblemCopy(noteProblem');
		expect(impl).not.toContain('<p class="w-notice__text">Your draft is still here on this device.</p>');
	});

	test('the action row has no dead modifiers', () => {
		expect(actions).not.toContain('pop-actions--stacked');
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
