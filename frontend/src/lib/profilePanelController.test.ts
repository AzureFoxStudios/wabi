import { expect, test } from 'bun:test';
import { get, writable } from 'svelte/store';
import type { User } from './socket-types';
import { createProfilePanelController } from './profilePanelController';
import { getUserNoteDraft, retainUserNoteDraft, forgetUserNoteDraft } from './userNotes';
import { getWorkspacePanelManifest } from './workspacePanels';
import { openRightPanel } from './layoutStoreRightPanel';
import { activeRightTab, pinnedPanelId, rightPanelMode, stubStrip } from './layoutStoreStates';

function fixture() {
	const self = writable<User | null>({ id: 'self-connection', dbUserId: 1, username: 'Artist', color: '#223344', status: 'active' });
	const server = writable('https://one.example');
	const users = writable<User[]>([]), members = writable<User[]>([]);
	return { self, server, users, members, controller: createProfilePanelController({ self, server, users, members }) };
}
const target: User = { id: 'first-connection', dbUserId: 2, username: 'Mira', color: '#334455', status: 'active', bio: 'Original bio' };

test('complete profile follows an account through reconnects and live profile edits', () => {
	const f = fixture();
	try {
		f.controller.select(target);
		f.users.set([{ ...target, id: 'replacement-connection', username: 'New name', bio: 'Published bio' }]);
		expect(get(f.controller.user)?.username).toBe('New name');
		expect(get(f.controller.user)?.bio).toBe('Published bio');
		f.users.set([]);
		f.members.set([{ ...target, id: 'user-2', status: 'offline', bio: 'Offline profile' }]);
		expect(get(f.controller.user)?.bio).toBe('Offline profile');
		// A connection id reused by a different account must never replace it.
		f.users.set([{ ...target, dbUserId: 3, username: 'Someone else' }]);
		expect(get(f.controller.user)?.username).toBe('Mira');
	} finally { f.controller.destroy(); }
});

test('server/account switches retire a hidden profile and cannot resurrect it', () => {
	const f = fixture();
	try {
		f.controller.select(target);
		f.server.set('https://two.example');
		expect(get(f.controller.user)).toBeNull();
		f.server.set('https://one.example');
		expect(get(f.controller.user)).toBeNull();
		f.controller.select(target);
		f.self.set({ id: 'second-account', dbUserId: 4, username: 'Other account', color: '#445566', status: 'active' });
		expect(get(f.controller.selection)).toBeNull();
		f.controller.select(target);
		f.self.set(null);
		expect(get(f.controller.user)).toBeNull();
		expect(f.controller.select(target)).toBe(false);
	} finally { f.controller.destroy(); }
});

test('conflicting canonical IDs cannot be selected or supply live profile data', () => {
	const f = fixture();
	try {
		const conflicting = { ...target, id: 'user-3', username: 'Wrong account' };
		expect(f.controller.select(conflicting)).toBe(false);
		expect(get(f.controller.selection)).toBeNull();
		f.controller.select(target);
		f.users.set([conflicting]);
		expect(get(f.controller.user)?.username).toBe('Mira');
		f.self.set({ ...get(f.self)!, id: 'user-9' });
		expect(get(f.controller.selection)).toBeNull();
	} finally { f.controller.destroy(); }
});

test('explicit logout clears the selected server even when the account id is unchanged', () => {
	const f = fixture();
	try {
		f.controller.select(target);
		f.controller.clearForServer('https://two.example');
		expect(get(f.controller.user)).not.toBeNull();
		f.controller.clearForServer('https://one.example');
		expect(get(f.controller.user)).toBeNull();
	} finally { f.controller.destroy(); }
});

test('dock and popout retain independent personal-note drafts', () => {
	const owner = { scopeId: 'profile-draft-test', isCurrent: () => true };
	try {
		retainUserNoteDraft(owner, '2', { text: 'Popout draft', baseRevision: 1 });
		retainUserNoteDraft(owner, '2', { text: 'Dock draft', baseRevision: 1 }, 'panel');
		expect(getUserNoteDraft(owner, '2')?.text).toBe('Popout draft');
		expect(getUserNoteDraft(owner, '2', 'panel')?.text).toBe('Dock draft');
		forgetUserNoteDraft(owner, '2', 'panel');
		expect(getUserNoteDraft(owner, '2')?.text).toBe('Popout draft');
	} finally {
		forgetUserNoteDraft(owner, '2'); forgetUserNoteDraft(owner, '2', 'panel');
	}
});

test('Profile is a real registry panel and repeated opens keep its existing pin', () => {
	const previous = { mode: get(rightPanelMode), panel: get(pinnedPanelId), tab: get(activeRightTab), strip: get(stubStrip) };
	try {
		expect(getWorkspacePanelManifest('profile')?.component).toBe('profile');
		expect(getWorkspacePanelManifest('profile')?.mobileMode).toBe('fullscreen');
		openRightPanel('profile'); openRightPanel('profile');
		expect(get(rightPanelMode)).toBe('pinned');
		expect(get(pinnedPanelId)).toBe('profile');
		expect(get(activeRightTab)).toBe('profile');
		expect(get(stubStrip).filter((panel) => panel === 'profile')).toHaveLength(1);
	} finally {
		rightPanelMode.set(previous.mode); pinnedPanelId.set(previous.panel); activeRightTab.set(previous.tab); stubStrip.set(previous.strip);
	}
});
