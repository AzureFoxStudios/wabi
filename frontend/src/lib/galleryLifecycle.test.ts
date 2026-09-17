import { afterAll, describe, expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { get, writable } from 'svelte/store';

// Bun's mock.module registry is process-wide: a mock-heavy suite loaded
// alongside other test files poisons their imports. Here the partial
// $lib/authSession mock (plus the global fetch overwrite) broke
// galleryFeedbackStore's transitive setAuthToken import when the three
// gallery suites ran in one `bun test` process. Established repo pattern
// (messageStore.e2ee-boundary.test.ts) runs mock-heavy suites in a separate
// bun process via Bun.spawnSync. This task forbids new fixture files, so
// this file is both wrapper and fixture: without the env flag it registers
// no mocks and only spawns itself with the flag; with the flag it runs the
// real galleryStore suite fully isolated. All 12 tests still exercise the
// actual gallery store; nothing is skipped and no assertion is weakened.
const GALLERY_LIFECYCLE_FIXTURE = 'WABI_GALLERY_LIFECYCLE_FIXTURE';

if (process.env[GALLERY_LIFECYCLE_FIXTURE] !== '1') {
	test(
		'gallery workspace lifecycle runs in an isolated fixture process',
		() => {
			const self = fileURLToPath(import.meta.url);
			const result = Bun.spawnSync([process.execPath, 'test', self], {
				cwd: fileURLToPath(new URL('../../', import.meta.url)),
				env: { ...process.env, [GALLERY_LIFECYCLE_FIXTURE]: '1' },
				stdout: 'pipe',
				stderr: 'pipe'
			});
			const decode = new TextDecoder();
			const out = decode.decode(result.stdout);
			const err = decode.decode(result.stderr);
			// Surface the fixture's own counts so the parent log keeps the
			// exact per-test evidence (parent reports this wrapper as 1 pass).
			// Note: with piped stdio bun prints the summary to stderr.
			if (out.trim()) console.log(out.trim());
			if (err.trim()) console.log(err.trim());
			expect(result.exitCode, `${out}\n${err}`.trim()).toBe(0);
		},
		30_000
	);
} else {
	// ---- Controllable dependency state (read through mock closures) ----
	function jwt(sub: string, nonce: string): string {
		return `header.${btoa(JSON.stringify({ sub, nonce }))}.signature`;
	}
	let authToken: string | null = jwt('7', 'one');
	let serverUrl = 'https://wabi.example';
	const sessionClearListeners = new Set<(server: string) => void>();
	const contextListeners = new Set<() => void>();
	const revokedListeners = new Set<(event: { channelId: string }) => void>();
	let membershipDenied = false;

	const usersStore = writable<Array<{ dbUserId: number; username: string }>>([]);

	type AlbumRow = { id: number; name: string; updatedAt: number };
	type ItemRow = {
		id: number;
		albumId: number;
		attachmentUrl: string;
		attachmentName: string;
		attachmentSize: number | null;
		attachmentMime: string | null;
		uploadedBy: number;
		uploadedAt: number;
		caption: string | null;
	};
	let albumsResult: AlbumRow[] | Error = [];
	let itemsImpl: (albumId: number) => Promise<{ album: AlbumRow; items: ItemRow[] }> = async () => {
		throw new Error('itemsImpl not configured');
	};
	let addedItems: Array<{ albumId: number; payload: Record<string, unknown> }> = [];

	type UploadBehavior = { status: number; body: unknown } | Error;
	let uploadBehavior: UploadBehavior = {
		status: 200,
		body: { fileUrl: '/uploads/f.png', fileName: 'f.png', fileSize: 12 }
	};
	const uploadCalls: string[] = [];

	mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));
	mock.module('$lib/authSession', () => ({
		getAuthToken: () => authToken,
		authSessionGeneration: () => 0,
		onAuthSessionCleared: (fn: (server: string) => void) => {
			sessionClearListeners.add(fn);
			return () => {
				sessionClearListeners.delete(fn);
			};
		}
	}));
	mock.module('$lib/serverUrl', () => ({
		getServerUrl: () => serverUrl,
		normalizeServerUrl: (value: string) => value
	}));
	mock.module('$lib/socket', () => ({ users: usersStore, currentUser: writable(null) }));
	mock.module('$lib/api', () => ({
		listMediaAlbums: async () => {
			if (albumsResult instanceof Error) throw albumsResult;
			return albumsResult;
		},
		listMediaAlbumItems: (token: string, albumId: number, limit: number) => itemsImpl(albumId),
		createMediaAlbum: async (token: string, payload: Record<string, unknown>) => ({
			id: 999,
			name: payload['name'],
			updatedAt: Date.now()
		}),
		addMediaAlbumItem: async (token: string, albumId: number, payload: Record<string, unknown>) => {
			addedItems.push({ albumId, payload });
			return { id: addedItems.length, albumId, ...payload, uploadedBy: 7, uploadedAt: Date.now() };
		}
	}));
	mock.module('./groupAccess', () => ({
		groupMembership: {
			realm: () => 'test-realm',
			onContextChanged: (fn: () => void) => {
				contextListeners.add(fn);
				return () => {
					contextListeners.delete(fn);
				};
			},
			onRevoked: (fn: (event: { channelId: string }) => void) => {
				revokedListeners.add(fn);
				return () => {
					revokedListeners.delete(fn);
				};
			},
			tracks: () => true,
			capture: (channelId: string) => {
				if (membershipDenied) throw new Error('Group is unavailable; reconnect to refresh membership');
				return { realm: 'test-realm', channelId, epoch: 0, generation: 0 };
			},
			current: () => !membershipDenied
		}
	}));

	// This suite owns global fetch for its upload tests. Save and restore so
	// the overwrite never leaks past this (already subprocess-isolated) file.
	const originalFetch = (globalThis as Record<string, unknown>).fetch;
	(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
		uploadCalls.push(String(url));
		if (uploadBehavior instanceof Error) throw uploadBehavior;
		return {
			ok: uploadBehavior.status >= 200 && uploadBehavior.status < 300,
			status: uploadBehavior.status,
			json: async () => uploadBehavior
		};
	};
	afterAll(() => {
		(globalThis as Record<string, unknown>).fetch = originalFetch;
	});

	const {
		createGalleryWorkspace,
		GALLERY_ALBUM_LIMIT,
		GALLERY_RECENT_COUNT
	} = await import('./galleryStore');

	function album(id: number, name = `Album ${id}`): AlbumRow {
		return { id, name, updatedAt: 1_700_000_000_000 + id };
	}
	function row(albumId: number, id: number, name = `pic-${id}.png`): ItemRow {
		return {
			id,
			albumId,
			attachmentUrl: `/uploads/${name}`,
			attachmentName: name,
			attachmentSize: 10,
			attachmentMime: 'image/png',
			uploadedBy: 7,
			uploadedAt: 1_700_000_000_000 + id,
			caption: null
		};
	}
	function file(name: string, type: string, content = 'bytes'): File {
		return new File([content], name, { type });
	}
	function resetDeps() {
		authToken = jwt('7', 'one');
		serverUrl = 'https://wabi.example';
		membershipDenied = false;
		albumsResult = [];
		addedItems = [];
		uploadCalls.length = 0;
		uploadBehavior = {
			status: 200,
			body: { fileUrl: '/uploads/f.png', fileName: 'f.png', fileSize: 12 }
		};
		usersStore.set([]);
	}

	describe('gallery workspace lifecycle (GF02-GF05)', () => {
		test('mounted workspaces own separate state', async () => {
			resetDeps();
			const first = createGalleryWorkspace();
			const second = createGalleryWorkspace();
			albumsResult = [album(1)];
			itemsImpl = async (albumId) => ({ album: album(albumId), items: [row(albumId, 1, 'a.png')] });
			await first.loadGallery('channel-a');
			expect(get(first.galleryItemsStore)).toHaveLength(1);
			expect(get(second.galleryItemsStore)).toHaveLength(0);
			expect(get(second.galleryChannelStore)).toBeNull();
			first.dispose();
			second.dispose();
		});

		test('late loads for a previous channel never overwrite newer results', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			let releaseFirst!: () => void;
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			albumsResult = [album(1)];
			itemsImpl = async (albumId) => {
				if (get(workspace.galleryChannelStore) === 'channel-slow') await firstGate;
				return { album: album(albumId), items: [row(albumId, albumId)] };
			};
			const slow = workspace.loadGallery('channel-slow');
			await workspace.loadGallery('channel-fast');
			expect(get(workspace.galleryItemsStore).map((i) => i.attachmentName)).toEqual(['pic-1.png']);
			releaseFirst();
			await slow;
			// The stale slow-channel write must be fenced, not re-applied.
			expect(get(workspace.galleryChannelStore)).toBe('channel-fast');
			expect(get(workspace.galleryItemsStore).map((i) => i.attachmentName)).toEqual(['pic-1.png']);
			expect(get(workspace.galleryLoadingStore)).toBe(false);
			workspace.dispose();
		});

		test('partial album failure preserves successes with a warning and retry surface', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			albumsResult = [album(1), album(2)];
			itemsImpl = async (albumId) => {
				if (albumId === 2) throw new Error('album 2 exploded');
				return { album: album(albumId), items: [row(albumId, 1, 'kept.png')] };
			};
			await workspace.loadGallery('channel-a');
			expect(get(workspace.galleryItemsStore).map((i) => i.attachmentName)).toEqual(['kept.png']);
			expect(get(workspace.galleryErrorStore)).toBeNull();
			const warning = get(workspace.galleryWarningStore);
			expect(warning).not.toBeNull();
			expect(String(warning)).toMatch(/partial/i);
			workspace.dispose();
		});

		test('total album failure surfaces an error and clears items', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			albumsResult = [album(1), album(2)];
			itemsImpl = async () => {
				throw new Error('every album exploded');
			};
			await workspace.loadGallery('channel-a');
			expect(get(workspace.galleryItemsStore)).toEqual([]);
			expect(get(workspace.galleryWarningStore)).toBeNull();
			expect(get(workspace.galleryErrorStore)).not.toBeNull();
			workspace.dispose();
		});

		test('album listing at the fetch cap discloses the limit', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			albumsResult = Array.from({ length: GALLERY_ALBUM_LIMIT }, (_, n) => album(n + 1));
			itemsImpl = async (albumId) => ({ album: album(albumId), items: [] });
			await workspace.loadGallery('channel-a');
			expect(String(get(workspace.galleryWarningStore) || '')).toMatch(/200/);
			workspace.dispose();
		});

		test('same-account token refresh does not lose recoverable results', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			albumsResult = [album(1)];
			itemsImpl = async (albumId) => {
				await gate;
				return { album: album(albumId), items: [row(albumId, 5, 'refreshed.png')] };
			};
			const pending = workspace.loadGallery('channel-a');
			authToken = jwt('7', 'two-after-refresh');
			release();
			await pending;
			expect(get(workspace.galleryItemsStore).map((i) => i.attachmentName)).toEqual(['refreshed.png']);
			expect(get(workspace.galleryErrorStore)).toBeNull();
			workspace.dispose();
		});

		test('logout/session clear retires gallery state and fences late writes', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			albumsResult = [album(1)];
			itemsImpl = async (albumId) => {
				await gate;
				return { album: album(albumId), items: [row(albumId, 5, 'late.png')] };
			};
			const pending = workspace.loadGallery('channel-a');
			authToken = null;
			for (const fn of [...sessionClearListeners]) fn(serverUrl);
			release();
			await pending;
			expect(get(workspace.galleryItemsStore)).toEqual([]);
			expect(get(workspace.galleryChannelStore)).toBeNull();
			workspace.dispose();
		});

		test('upload keeps acknowledged counts with per-file errors and MIME fallback', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			albumsResult = [album(1)];
			let calls = 0;
			(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
				uploadCalls.push(String(url));
				calls += 1;
				if (calls === 4) throw new Error('network blew up');
				return {
					ok: true,
					status: 200,
					json: async () => ({ fileUrl: `/uploads/ok-${calls}.png`, fileName: `ok-${calls}.png`, fileSize: 4 })
				};
			};
			itemsImpl = async (albumId) => ({ album: album(albumId), items: [] });
			const result = await workspace.uploadGalleryImages('channel-a', [
				file('typed.png', 'image/png'),
				file('untyped-photo.jpg', ''),
				file('clip.mp4', ''),
				file('bad-clip.mp4', '')
			]);
			// All four are gallery-eligible through MIME fallback; the failed
			// last upload must not erase the three acknowledged uploads.
			expect(result.uploaded).toBe(3);
			expect(result.perFileErrors).toHaveLength(1);
			expect(result.perFileErrors[0].fileName).toBe('bad-clip.mp4');
			expect(result.errors).toHaveLength(1);
			const mimes = addedItems.map((entry) => entry.payload['attachmentMime']);
			expect(mimes).toContain('image/png');
			expect(mimes).toContain('image/jpeg');
			expect(mimes).toContain('video/mp4');
			workspace.dispose();
		});

		test('upload never continues against a changed server', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			albumsResult = [album(1)];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
				uploadCalls.push(String(url));
				await gate;
				return {
					ok: true,
					status: 200,
					json: async () => ({ fileUrl: '/uploads/x.png', fileName: 'x.png', fileSize: 4 })
				};
			};
			const pending = workspace.uploadGalleryImages('channel-a', [file('a.png', 'image/png')]);
			serverUrl = 'https://other.example';
			release();
			const result = await pending;
			expect(result.uploaded).toBe(0);
			expect(addedItems).toEqual([]);
			expect(uploadCalls.every((url) => url.startsWith('https://wabi.example'))).toBe(true);
			workspace.dispose();
		});

		test('revoked group membership fails fast with an error', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			membershipDenied = true;
			await workspace.loadGallery('channel-a');
			expect(get(workspace.galleryItemsStore)).toEqual([]);
			expect(get(workspace.galleryErrorStore)).toMatch(/unavailable|access|membership/i);
			workspace.dispose();
		});

		test('disposed workspaces stop loading and uploading', async () => {
			resetDeps();
			const workspace = createGalleryWorkspace();
			albumsResult = [album(1)];
			itemsImpl = async (albumId) => ({ album: album(albumId), items: [row(albumId, 1)] });
			workspace.dispose();
			await workspace.loadGallery('channel-a');
			expect(get(workspace.galleryItemsStore)).toEqual([]);
			const result = await workspace.uploadGalleryImages('channel-a', [file('a.png', 'image/png')]);
			expect(result.uploaded).toBe(0);
			expect(addedItems).toEqual([]);
		});

		test('recent-count constant keeps the filter-before-split contract stable', () => {
			expect(GALLERY_RECENT_COUNT).toBe(6);
		});
	});
}
