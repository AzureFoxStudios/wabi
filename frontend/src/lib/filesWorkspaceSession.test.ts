import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';

// Bun's mock.module registry is process-wide: other suites' mocks break this
// file's transitive imports when the full `bun test src/lib` suite runs in one
// process. Established repo pattern (galleryFeedbackSession.test.ts) isolates
// via a separate bun process. This file is both wrapper and fixture: without
// the env flag it registers no mocks and only spawns itself with the flag;
// with the flag it runs the real GF07 session suite (mock-free,
// dependency-injected harness against the actual filesWorkspaceSession) fully
// isolated. No test is skipped and no assertion is weakened.
const FILES_WORKSPACE_FIXTURE = 'WABI_FILES_WORKSPACE_FIXTURE';

if (process.env[FILES_WORKSPACE_FIXTURE] !== '1') {
	test(
		'files workspace session runs in an isolated fixture process',
		() => {
			const self = fileURLToPath(import.meta.url);
			const result = Bun.spawnSync([process.execPath, 'test', self], {
				cwd: fileURLToPath(new URL('../../', import.meta.url)),
				env: { ...process.env, [FILES_WORKSPACE_FIXTURE]: '1' },
				stdout: 'pipe',
				stderr: 'pipe'
			});
			const decode = new TextDecoder();
			const out = decode.decode(result.stdout);
			const err = decode.decode(result.stderr);
			if (out.trim()) console.log(out.trim());
			if (err.trim()) console.log(err.trim());
			expect(result.exitCode, `${out}\n${err}`.trim()).toBe(0);
		},
		60_000
	);
} else {
	// GF07 regression suite: Files must subscribe reactively, fence every
	// async continuation by scope (server/account/generation/channel/logout/
	// disposal/revocation), invalidate preview on close, tolerate same-account
	// refresh, keep partial results honestly, retain upload failures for
	// explicit retry/dismiss with stable ids, and never silently overwrite
	// conflicts or auto-sync.

	const {
		createFilesWorkspaceSession,
		buildUploadJobs,
		summarizeUploads,
		isConflictError,
		classifyPreviewKind,
		createUploadJobId
	} = await import('./filesWorkspaceSession');

	function jwt(sub: string, nonce = 'original'): string {
		return `header.${btoa(JSON.stringify({ sub, nonce }))}.signature`;
	}

	function deferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((done, fail) => {
			resolve = done;
			reject = fail;
		});
		return { promise, resolve, reject };
	}

	type Deps = Parameters<typeof createFilesWorkspaceSession>[0];

	interface Harness {
		deps: Deps;
		server(value?: string): string;
		token(value?: string | null): string | null;
		account(value?: string | null): string | null;
		generation(value?: number): number;
		repos: Map<number, unknown>;
		repoHandler(value?: (token: string, id: number) => Promise<unknown>): (token: string, id: number) => Promise<unknown>;
		listHandler(value?: (token: string, id: number) => Promise<Array<{ path: string; size: number }>>): (token: string, id: number) => Promise<Array<{ path: string; size: number }>>;
		downloadHandler(value?: (token: string, id: number, path: string) => Promise<Blob>): (token: string, id: number, path: string) => Promise<Blob>;
		uploadHandler(value?: (token: string, id: number, dest: string, file: File | Blob) => Promise<{ pending_review?: boolean }>): (token: string, id: number, dest: string, file: File | Blob) => Promise<{ pending_review?: boolean }>;
		access(value?: (key: string) => () => boolean): (key: string) => () => boolean;
		revoke(key: string): void;
		contextChanged(): void;
		fireSessionCleared(server: string): void;
		notifies(): Array<{ message: string; kind: string }>;
		saved(): Array<{ filename: string }>;
		createdUrls(): string[];
		revokedUrls(): string[];
		calls: { repos: number; lists: number; downloads: number; uploads: number };
	}

	function makeHarness(): Harness {
		let server = 'https://one.test';
		let token: string | null = jwt('7');
		let account: string | null = '7';
		let generation = 0;
		const notifies: Array<{ message: string; kind: string }> = [];
		const saved: Array<{ filename: string }> = [];
		const createdUrls: string[] = [];
		const revokedUrls: string[] = [];
		const revoked = new Set<string>();
		let contextListener = () => {};
		let revokedListener = (_event: { channelId: string }) => {};
		const cleared = new Set<(server: string) => void>();
		const repos = new Map<number, unknown>();
		const calls = { repos: 0, lists: 0, downloads: 0, uploads: 0 };
		let repoHandler = async (_t: string, id: number) => {
			calls.repos += 1;
			if (!repos.has(id)) throw new Error(`space ${id} unavailable`);
			return repos.get(id);
		};
		let listHandler: (token: string, id: number) => Promise<Array<{ path: string; size: number }>> = async (_t: string, _id: number) => {
			calls.lists += 1;
			return [] as Array<{ path: string; size: number }>;
		};
		let downloadHandler: (token: string, id: number, path: string) => Promise<Blob> = async () => {
			calls.downloads += 1;
			return new Blob(['x'], { type: 'text/plain' });
		};
		let uploadHandler: (token: string, id: number, dest: string, file: File | Blob) => Promise<{ pending_review?: boolean }> = async () => {
			calls.uploads += 1;
			return {};
		};
		let urlSeq = 0;
		return {
			deps: {
				server: () => server,
				token: () => token,
				accountId: () => account,
				generation: () => generation,
				getRepo: (t, id) => repoHandler(t, id) as Promise<never>,
				listFiles: (t, id) => listHandler(t, id) as Promise<never>,
				downloadFile: (t, id, path) => downloadHandler(t, id, path),
				uploadFile: (t, id, dest, file) => uploadHandler(t, id, dest, file),
				notify: (message, kind) => {
					notifies.push({ message, kind });
				},
				saveBlob: (_blob, filename) => {
					saved.push({ filename });
				},
				createObjectUrl: (_blob) => {
					urlSeq += 1;
					const url = `blob:preview-${urlSeq}`;
					createdUrls.push(url);
					return url;
				},
				revokeObjectUrl: (url) => {
					revokedUrls.push(url);
				},
				captureAccess: (key) => () => !revoked.has(key),
				onSessionCleared: (fn) => {
					cleared.add(fn);
					return () => {
						cleared.delete(fn);
					};
				},
				onContextChanged: (fn) => {
					contextListener = fn;
					return () => {
						contextListener = () => {};
					};
				},
				onRevoked: (fn) => {
					revokedListener = fn;
					return () => {
						revokedListener = () => {};
					};
				}
			},
			server(value?: string): string {
				if (value !== undefined) server = value;
				return server;
			},
			token(value?: string | null): string | null {
				if (value !== undefined) token = value;
				return token;
			},
			account(value?: string | null): string | null {
				if (value !== undefined) account = value;
				return account;
			},
			generation(value?: number): number {
				if (value !== undefined) generation = value;
				return generation;
			},
			repos,
			repoHandler(value?: (token: string, id: number) => Promise<unknown>) {
				if (value !== undefined) repoHandler = value;
				return repoHandler;
			},
			listHandler(value?: (token: string, id: number) => Promise<Array<{ path: string; size: number }>>) {
				if (value !== undefined) listHandler = value;
				return listHandler;
			},
			downloadHandler(value?: (token: string, id: number, path: string) => Promise<Blob>) {
				if (value !== undefined) downloadHandler = value;
				return downloadHandler;
			},
			uploadHandler(value?: (token: string, id: number, dest: string, file: File | Blob) => Promise<{ pending_review?: boolean }>) {
				if (value !== undefined) uploadHandler = value;
				return uploadHandler;
			},
			access(value?: (key: string) => () => boolean) {
				throw new Error('use revoke()/contextChanged() or override deps.captureAccess directly');
			},
			revoke(key: string): void {
				revoked.add(key);
				revokedListener({ channelId: key });
			},
			contextChanged(): void {
				contextListener();
			},
			fireSessionCleared(value: string): void {
				for (const fn of [...cleared]) fn(value);
			},
			notifies: () => notifies,
			saved: () => saved,
			createdUrls: () => createdUrls,
			revokedUrls: () => revokedUrls,
			calls
		};
	}

	function blobFile(name: string, content = 'hello'): File {
		return new File([content], name, { type: 'text/plain' });
	}

	function loreRefs(): Array<{ id: string; name: string }> {
		return [
			{ id: 'ch_1', name: 'Alpha' },
			{ id: 'ch_2', name: 'Beta' }
		];
	}

	describe('files workspace pure helpers', () => {
		test('repeated filenames get stable unique job ids', () => {
			const jobs = buildUploadJobs(['a.txt', 'a.txt', 'a.txt'], 'docs');
			expect(jobs.map((j) => j.dest)).toEqual(['docs/a.txt', 'docs/a.txt', 'docs/a.txt']);
			expect(new Set(jobs.map((j) => j.id)).size).toBe(3);
			expect(createUploadJobId()).not.toBe(createUploadJobId());
		});

		test('acknowledged counts survive alongside failures', () => {
			const counts = summarizeUploads([
				{ id: '1', name: 'a', dest: 'a', status: 'done' },
				{ id: '2', name: 'b', dest: 'b', status: 'error', error: 'boom' },
				{ id: '3', name: 'c', dest: 'c', status: 'conflict', error: 'stale' },
				{ id: '4', name: 'd', dest: 'd', status: 'pending' }
			]);
			expect(counts).toEqual({ total: 4, done: 1, failed: 2, pending: 1 });
		});

		test('conflict detection never invites silent overwrite', () => {
			const conflict = Object.assign(new Error('File changed on the server since you loaded it'), { name: 'LoreConflictError' });
			expect(isConflictError(conflict)).toBe(true);
			expect(isConflictError(new Error('nope'))).toBe(false);
			expect(classifyPreviewKind('photo.PNG')).toBe('image');
			expect(classifyPreviewKind('notes.md')).toBe('text');
			expect(classifyPreviewKind('archive.zip')).toBe('other');
		});
	});

	describe('files workspace session ownership (GF07)', () => {
		test('missing auth never spins: spaces resolve signed-out immediately', async () => {
			const harness = makeHarness();
			harness.token(null);
			harness.account(null);
			const session = createFilesWorkspaceSession(harness.deps);
			await session.loadSpaces(loreRefs());
			expect(get(session.spacesLoaded)).toBe(true);
			expect(get(session.spaces)).toEqual({});
			expect(String(get(session.spacesError) || '')).toMatch(/sign in/i);
			session.dispose();
		});

		test('spaces distinguish partial results from total failure', async () => {
			const harness = makeHarness();
			harness.repos.set(1, { channelId: 1, repoName: 'a', createdBy: 7, createdAt: 1 });
			const session = createFilesWorkspaceSession(harness.deps);
			await session.loadSpaces(loreRefs());
			expect(Object.keys(get(session.spaces))).toEqual(['1']);
			expect(get(session.spacesError)).toBeNull();
			expect(String(get(session.spacesWarning) || '')).toMatch(/Beta|unavailable/i);
			await session.loadSpaces([]);
			expect(get(session.spaces)).toEqual({});
			expect(get(session.spacesError)).toBeNull();
			session.dispose();

			const failing = makeHarness();
			const bad = createFilesWorkspaceSession(failing.deps);
			await bad.loadSpaces(loreRefs());
			expect(get(bad.spaces)).toEqual({});
			expect(get(bad.spacesLoaded)).toBe(true);
			expect(String(get(bad.spacesError) || '')).toMatch(/could not load/i);
			bad.dispose();
		});

		test('stale file loads cannot overwrite a newer view (A-B-A)', async () => {
			const harness = makeHarness();
			const gate = deferred<Array<{ path: string; size: number }>>();
			harness.listHandler(async (_t, id) => {
				harness.calls.lists += 1;
				if (id === 1) return gate.promise;
				return [{ path: 'b.txt', size: 2 }];
			});
			const session = createFilesWorkspaceSession(harness.deps);
			const slow = session.loadFiles(1);
			await session.loadFiles(2);
			expect(get(session.files).map((f) => f.path)).toEqual(['b.txt']);
			gate.resolve([{ path: 'stale.txt', size: 1 }]);
			await slow;
			expect(get(session.files).map((f) => f.path)).toEqual(['b.txt']);
			expect(get(session.filesLoading)).toBe(false);
			session.dispose();
		});

		test('logout retires scope and fences late file writes', async () => {
			const harness = makeHarness();
			const gate = deferred<Array<{ path: string; size: number }>>();
			harness.listHandler(() => gate.promise);
			const session = createFilesWorkspaceSession(harness.deps);
			const pending = session.loadFiles(1);
			harness.token(null);
			harness.account(null);
			harness.generation(1);
			harness.fireSessionCleared('https://one.test');
			gate.resolve([{ path: 'late.txt', size: 1 }]);
			await pending;
			expect(get(session.files)).toEqual([]);
			expect(get(session.filesLoading)).toBe(false);
			expect(String(get(session.filesError) || '')).toMatch(/session|sign in/i);
			session.dispose();
		});

		test('same-account token refresh keeps recoverable file results', async () => {
			const harness = makeHarness();
			const gate = deferred<Array<{ path: string; size: number }>>();
			harness.listHandler(() => gate.promise);
			const session = createFilesWorkspaceSession(harness.deps);
			const pending = session.loadFiles(1);
			harness.token(jwt('7', 'refreshed'));
			gate.resolve([{ path: 'kept.txt', size: 3 }]);
			await pending;
			expect(get(session.files).map((f) => f.path)).toEqual(['kept.txt']);
			expect(get(session.filesError)).toBeNull();
			session.dispose();
		});

		test('search preserves partial results with an honest warning', async () => {
			const harness = makeHarness();
			harness.listHandler(async (_t, id) => {
				harness.calls.lists += 1;
				if (id === 2) throw new Error('space Beta unavailable');
				return [{ path: 'Report.md', size: 4 }];
			});
			const session = createFilesWorkspaceSession(harness.deps);
			await session.searchSpaces('report', [
				{ channelId: 1, repoName: 'a', createdBy: 7, createdAt: 1, channelKey: 'ch_1', channelName: 'Alpha' },
				{ channelId: 2, repoName: 'b', createdBy: 7, createdAt: 1, channelKey: 'ch_2', channelName: 'Beta' }
			]);
			expect(get(session.searchResults).map((r) => r.path)).toEqual(['Report.md']);
			expect(get(session.searchError)).toBeNull();
			expect(String(get(session.searchWarning) || '')).toMatch(/partial|Beta/i);
			expect(get(session.searchLoading)).toBe(false);
			session.dispose();
		});

		test('search distinguishes no-match from failure without rejecting', async () => {
			const harness = makeHarness();
			harness.listHandler(async () => {
				harness.calls.lists += 1;
				return [{ path: 'unrelated.txt', size: 1 }];
			});
			const session = createFilesWorkspaceSession(harness.deps);
			await expect(
				session.searchSpaces('zzz-no-match', [
					{ channelId: 1, repoName: 'a', createdBy: 7, createdAt: 1, channelKey: 'ch_1', channelName: 'Alpha' }
				])
			).resolves.toBeUndefined();
			expect(get(session.searchResults)).toEqual([]);
			expect(get(session.searchError)).toBeNull();
			expect(get(session.searchWarning)).toBeNull();

			harness.listHandler(async () => {
				throw new Error('all spaces down');
			});
			await expect(
				session.searchSpaces('anything', [
					{ channelId: 1, repoName: 'a', createdBy: 7, createdAt: 1, channelKey: 'ch_1', channelName: 'Alpha' }
				])
			).resolves.toBeUndefined();
			expect(String(get(session.searchError) || '')).toMatch(/failed|down/i);
			session.dispose();
		});

		test('closing preview invalidates pending bytes and revokes the URL', async () => {
			const harness = makeHarness();
			const gate = deferred<Blob>();
			harness.downloadHandler(async () => gate.promise);
			const session = createFilesWorkspaceSession(harness.deps);
			const pending = session.openPreview(1, 'photo.png', [{ path: 'photo.png', size: 9 }]);
			session.closePreview();
			expect(get(session.previewPath)).toBeNull();
			gate.resolve(new Blob(['img'], { type: 'image/png' }));
			await pending;
			expect(get(session.previewPath)).toBeNull();
			expect(get(session.previewUrl)).toBeNull();

			await session.openPreview(1, 'second.png', [{ path: 'second.png', size: 9 }]);
			expect(harness.createdUrls()).toHaveLength(1);
			session.closePreview();
			expect(harness.revokedUrls()).toEqual(harness.createdUrls());
			session.dispose();
		});

		test('revoking membership clears the owned view and fences late bytes', async () => {
			const harness = makeHarness();
			harness.listHandler(async () => [{ path: 'kept.txt', size: 1 }]);
			const session = createFilesWorkspaceSession(harness.deps);
			await session.loadFiles(1);
			expect(get(session.files)).toHaveLength(1);
			const gate = deferred<Array<{ path: string; size: number }>>();
			harness.listHandler(() => gate.promise);
			const pending = session.loadFiles(1);
			harness.revoke('ch_1');
			expect(get(session.files)).toEqual([]);
			gate.resolve([{ path: 'resurrected.txt', size: 1 }]);
			await pending;
			expect(get(session.files)).toEqual([]);
			session.dispose();
		});

		test('retired downloads never save or toast into the new scope', async () => {
			const harness = makeHarness();
			const gate = deferred<Blob>();
			harness.downloadHandler(async () => gate.promise);
			const session = createFilesWorkspaceSession(harness.deps);
			const pending = session.download(1, 'a.txt');
			harness.token(null);
			harness.account(null);
			harness.generation(5);
			harness.fireSessionCleared('https://one.test');
			gate.resolve(new Blob(['late'], { type: 'text/plain' }));
			expect(await pending).toBe(false);
			expect(harness.saved()).toEqual([]);
			expect(harness.notifies()).toEqual([]);
			session.dispose();
		});

		test('repeated upload names stay distinct and failures persist for retry/dismiss', async () => {
			const harness = makeHarness();
			let attempt = 0;
			harness.uploadHandler(async () => {
				attempt += 1;
				if (attempt === 1) throw new Error('network down');
				return {};
			});
			harness.listHandler(async () => []);
			const session = createFilesWorkspaceSession(harness.deps);
			await session.startUploads(1, '', [blobFile('a.txt', 'one'), blobFile('a.txt', 'two')]);
			const jobs = get(session.uploadJobs);
			expect(jobs).toHaveLength(2);
			expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
			expect(jobs.map((j) => j.dest)).toEqual(['a.txt', 'a.txt']);
			// One failed, one done; the failure is retained (no 4s auto-prune).
			expect(jobs.filter((j) => j.status === 'error')).toHaveLength(1);
			expect(jobs.filter((j) => j.status === 'done')).toHaveLength(1);
			await new Promise((r) => setTimeout(r, 25));
			expect(get(session.uploadJobs)).toHaveLength(2);

			const failed = get(session.uploadJobs).find((j) => j.status === 'error')!;
			await session.retryUpload(failed.id);
			expect(get(session.uploadJobs).find((j) => j.id === failed.id)?.status).toBe('done');
			const counts = summarizeUploads(get(session.uploadJobs));
			expect(counts.done).toBe(2);
			session.dismissCompleted();
			expect(get(session.uploadJobs)).toEqual([]);
			session.dispose();
		});

		test('conflicts surface without overwriting the server copy', async () => {
			const harness = makeHarness();
			harness.uploadHandler(async () => {
				harness.calls.uploads += 1;
				throw Object.assign(new Error('File changed on the server since you loaded it'), { name: 'LoreConflictError' });
			});
			harness.listHandler(async () => {
				harness.calls.lists += 1;
				return [];
			});
			const session = createFilesWorkspaceSession(harness.deps);
			await session.startUploads(1, '', [blobFile('notes.txt')]);
			const [job] = get(session.uploadJobs);
			expect(job.status).toBe('conflict');
			expect(String(job.error || '')).toMatch(/server copy|rename/i);
			expect(harness.calls.uploads).toBe(1);
			expect(harness.calls.lists).toBe(1);
			session.dispose();
		});

		test('mirror uploads are no-ops and queued work stops after retirement', async () => {
			const harness = makeHarness();
			const session = createFilesWorkspaceSession(harness.deps);
			await session.startUploads(1, '', [blobFile('a.txt')], { readOnly: true });
			expect(get(session.uploadJobs)).toEqual([]);
			expect(harness.calls.uploads).toBe(0);

			const gate = deferred<{ pending_review?: boolean }>();
			harness.uploadHandler(async () => {
				harness.calls.uploads += 1;
				return gate.promise;
			});
			harness.listHandler(async () => {
				harness.calls.lists += 1;
				return [];
			});
			// More files than the worker pool (3) so some are still queued
			// when retirement hits; every issued request is gated too.
			const pending = session.startUploads(1, '', [
				blobFile('one.txt'),
				blobFile('two.txt'),
				blobFile('three.txt'),
				blobFile('four.txt'),
				blobFile('five.txt')
			]);
			await new Promise((r) => setTimeout(r, 10));
			harness.contextChanged();
			gate.resolve({});
			await pending;
			// Already-issued completion was fenced: no toast/download into the
			// new scope and no silent done mutation.
			expect(harness.notifies()).toEqual([]);
			expect(get(session.uploadJobs).filter((j) => j.status === 'done')).toEqual([]);
			expect(get(session.uploadJobs).every((j) => j.status === 'cancelled')).toBe(true);
			session.dispose();
		});

		test('two mounted instances never share mutable state', async () => {
			const harness = makeHarness();
			harness.listHandler(async (_t, id) => [{ path: id === 1 ? 'one.txt' : 'two.txt', size: 1 }]);
			const a = createFilesWorkspaceSession(harness.deps);
			const b = createFilesWorkspaceSession(harness.deps);
			await a.loadFiles(1);
			expect(get(b.files)).toEqual([]);
			await b.loadFiles(2);
			expect(get(a.files).map((f) => f.path)).toEqual(['one.txt']);
			expect(get(b.files).map((f) => f.path)).toEqual(['two.txt']);
			a.dispose();
			b.dispose();
		});

		test('disposal clears sensitive display and ignores late completions', async () => {
			const harness = makeHarness();
			const gate = deferred<Array<{ path: string; size: number }>>();
			harness.listHandler(() => gate.promise);
			const session = createFilesWorkspaceSession(harness.deps);
			const pending = session.loadFiles(1);
			session.dispose();
			gate.resolve([{ path: 'late.txt', size: 1 }]);
			await pending;
			expect(get(session.files)).toEqual([]);
			expect(get(session.previewPath)).toBeNull();
			expect(get(session.searchResults)).toEqual([]);
			session.dispose();
		});

		test('component wires the session instead of snapshotting stores', async () => {
			const path = fileURLToPath(new URL('./components/FilesWorkspace.svelte', import.meta.url));
			const source = await Bun.file(path).text();
			expect(source).not.toContain('$derived(get(currentChannel))');
			expect(source).not.toContain('$derived(get(channels))');
			expect(source).toContain('currentChannel.subscribe');
			expect(source).toContain('channels.subscribe');
			expect(source).toContain('createFilesWorkspaceSession');
			expect(source).toContain('session.dispose');
			expect(source).toContain('session.closePreview');
			expect(source).toContain('readOnly: isMirror');
			expect(source).toContain('(job.id)');
			expect(source).not.toContain('(job.dest)');
			expect(source).toContain('Retry');
			expect(source).toContain('session.retryUpload');
			expect(source).toContain('session.dismissUpload');
		});
	});
}
