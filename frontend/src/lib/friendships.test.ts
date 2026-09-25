import { expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { get, writable } from 'svelte/store';

// These dependency mocks must not leak into unrelated frontend suites.
const FIXTURE_FLAG = 'WABI_FRIENDSHIPS_FIXTURE';

if (process.env[FIXTURE_FLAG] !== '1') {
	test('friendship account scope runs in an isolated fixture', () => {
		const result = Bun.spawnSync([process.execPath, 'test', fileURLToPath(import.meta.url)], {
			cwd: fileURLToPath(new URL('../../', import.meta.url)),
			env: { ...process.env, [FIXTURE_FLAG]: '1' },
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(result.exitCode, output).toBe(0);
	}, 30_000);
} else {
	let server = 'https://server-a.example';
	let token: string | null = 'account-a';
	let generation = 0;
	let listCalls = 0;
	let resolveList: ((value: unknown) => void) | null = null;
	const activeServerUrl = writable(server);
	const currentUser = writable({ dbUserId: 1 });
	const socket = writable(null);
	const person = (user_id: number) => ({ user_id, username: `User ${user_id}`, handle: null, profile_picture: null, color: '#6366f1', status: null });
	const snapshot = (user_id: number) => ({ friends: [person(user_id)], incoming: [], outgoing: [] });

	mock.module('./authSession', () => ({
		authSessionGeneration: () => generation,
		getAuthToken: () => token,
		getStoredDbUserId: () => 1,
		onAuthSessionCleared: () => () => {}
	}));
	mock.module('./apiRequest', () => ({ accountTokenSubject: (value: string | null) => value }));
	mock.module('./serverUrl', () => ({ activeServerUrl }));
	mock.module('./socket', () => ({ currentUser, socket }));
	mock.module('./api/utils', () => ({ getApiBase: () => server }));
	mock.module('./api/friends', () => ({
		listFriends: () => { listCalls += 1; return new Promise((resolve) => { resolveList = resolve; }); },
		acceptFriendRequest: async () => {},
		dismissFriendRequest: async () => {},
		removeFriend: async () => {},
		sendFriendRequest: async () => {}
	}));

	const { friendships, refreshFriendships } = await import('./friendships');

	test('remount sees no previous account friends and ignores an old response', async () => {
		const firstLoad = refreshFriendships();
		resolveList?.(snapshot(2));
		await firstLoad;
		expect(get(friendships).friends.map((friend) => friend.user_id)).toEqual([2]);

		const oldLoad = refreshFriendships();
		const completeOldLoad = resolveList;
		token = 'account-b';
		// The old currentUser and stored id intentionally remain stale.
		expect(get(friendships)).toMatchObject({ friends: [], ready: false });
		completeOldLoad?.(snapshot(99));
		await oldLoad;
		expect(get(friendships).friends).toEqual([]);

		const nextLoad = refreshFriendships();
		resolveList?.(snapshot(3));
		await nextLoad;
		expect(get(friendships).friends.map((friend) => friend.user_id)).toEqual([3]);

		server = 'https://server-b.example';
		activeServerUrl.set(server);
		expect(get(friendships)).toMatchObject({ friends: [], ready: false });

		generation += 1;
		token = null;
		expect(get(friendships)).toMatchObject({ friends: [], ready: false });
		const callsBeforeGuest = listCalls;
		await refreshFriendships();
		expect(listCalls).toBe(callsBeforeGuest);
		expect(get(friendships)).toMatchObject({ friends: [], ready: false, error: null });
	});
}
