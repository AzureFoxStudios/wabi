import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';

// Bun's mock.module registry is process-wide: other suites' slim
// `./groupAccess` mocks (e.g. messageStore.scoped) break this file's
// transitive `captureGroupAccess` import when the full `bun test src/lib`
// suite runs in one process. Established repo pattern
// (messageStore.e2ee-boundary.test.ts) isolates via a separate bun process.
// This task forbids new fixture files, so this file is both wrapper and
// fixture: without the env flag it registers no mocks and only spawns
// itself with the flag; with the flag it runs the real GF06 session suite
// (mock-free, dependency-injected harness against the actual
// galleryFeedbackStore) fully isolated. No test is skipped and no assertion
// is weakened.
const GALLERY_FEEDBACK_FIXTURE = 'WABI_GALLERY_FEEDBACK_FIXTURE';

if (process.env[GALLERY_FEEDBACK_FIXTURE] !== '1') {
	test(
		'gallery feedback session runs in an isolated fixture process',
		() => {
			const self = fileURLToPath(import.meta.url);
			const result = Bun.spawnSync([process.execPath, 'test', self], {
				cwd: fileURLToPath(new URL('../../', import.meta.url)),
				env: { ...process.env, [GALLERY_FEEDBACK_FIXTURE]: '1' },
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
	// GF06 regression suite: gallery feedback must be scoped per lightbox
	// instance (server/account/channel/work/session), fence stale loads and
	// mutation follow-ups, retire on session changes, survive legitimate token
	// refresh, and report truthful errors. Drafts stay independent: an old save
	// must never clear a newer draft.
	//
	// RED baseline: ./galleryFeedbackStore has no createGalleryFeedbackSession
	// export, so this import fails before the fix.

	const { createGalleryFeedbackSession, shouldClearFeedbackDraft } = await import(
		'./galleryFeedbackStore'
	);

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

	type FetchHandler = (
		channelId: string,
		url: string,
		options?: RequestInit
	) => Promise<Response>;

	interface Harness {
		deps: Parameters<typeof createGalleryFeedbackSession>[0];
		server(value?: string): string;
		token(value?: string | null): string | null;
		account(value?: string | null): string | null;
		generation(value?: number): number;
		handler(value?: FetchHandler): FetchHandler;
		refreshes(): number;
		fireSessionCleared(server: string): void;
		requests(): Array<{ channelId: string; url: string; options?: RequestInit }>;
	}

	function makeHarness(): Harness {
		let server = 'https://one.test';
		let token: string | null = jwt('7');
		let account: string | null = '7';
		let generation = 0;
		let refreshCount = 0;
		const cleared = new Set<(server: string) => void>();
		const seen: Array<{ channelId: string; url: string; options?: RequestInit }> = [];
		let handler: FetchHandler = async () => Response.json({ feedback: [] });
		return {
			deps: {
				server: () => server,
				token: () => token,
				accountId: () => account,
				generation: () => generation,
				fetchChannel: (channelId, url, options) => {
					seen.push({ channelId, url, options });
					return handler(channelId, url, options);
				},
				refresh: async () => {
					refreshCount += 1;
					return true;
				},
				onSessionCleared: (fn) => {
					cleared.add(fn);
					return () => {
						cleared.delete(fn);
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
			handler(value?: FetchHandler): FetchHandler {
				if (value !== undefined) handler = value;
				return handler;
			},
			refreshes: () => refreshCount,
			fireSessionCleared: (value: string) => {
				for (const fn of [...cleared]) fn(value);
			},
			requests: () => seen
		};
	}

	function feedbackRow(overrides: Record<string, unknown> = {}) {
		return {
			feedback_id: 'feedback_1',
			work_id: 'album-alb_1-item-item_2',
			channel_id: 'ch-a',
			author_user_id: 7,
			comment: 'Nice light',
			x_percent: 12.5,
			y_percent: 40,
			created_at_micros: 1_700_000_000_000_000,
			is_deleted: false,
			...overrides
		};
	}

	describe('gallery feedback session lifecycle (GF06)', () => {
		test('identical ids on two servers stay independent', async () => {
			const first = makeHarness();
			const second = makeHarness();
			second.server('https://two.test');
			const a = createGalleryFeedbackSession(first.deps);
			const b = createGalleryFeedbackSession(second.deps);
			first.handler(async () => Response.json({ feedback: [feedbackRow({ comment: 'one' })] }));
			second.handler(async () => Response.json({ feedback: [feedbackRow({ comment: 'two' })] }));
			await a.load('ch-a', 'album-alb_1-item-item_2');
			await b.load('ch-a', 'album-alb_1-item-item_2');
			expect(get(a.feedbackItems).map((f) => f.comment)).toEqual(['one']);
			expect(get(b.feedbackItems).map((f) => f.comment)).toEqual(['two']);
			a.dispose();
			b.dispose();
		});

		test('two simultaneous instances never share mutable state', async () => {
			const harness = makeHarness();
			let calls = 0;
			harness.handler(async () => {
				calls += 1;
				return Response.json({ feedback: [feedbackRow({ comment: `v${calls}` })] });
			});
			const a = createGalleryFeedbackSession(harness.deps);
			const b = createGalleryFeedbackSession(harness.deps);
			await a.load('ch-a', 'work-1');
			expect(get(b.feedbackItems)).toEqual([]);
			await b.load('ch-a', 'work-1');
			expect(get(a.feedbackItems).map((f) => f.comment)).toEqual(['v1']);
			expect(get(b.feedbackItems).map((f) => f.comment)).toEqual(['v2']);
			a.dispose();
			b.dispose();
		});

		test('stale load cannot overwrite a newer view (A-B-A)', async () => {
			const harness = makeHarness();
			const gateA = deferred<Response>();
			harness.handler(async (channelId, url) =>
				url.includes('work-a') ? gateA.promise : Response.json({ feedback: [feedbackRow({ comment: 'b' })] })
			);
			const session = createGalleryFeedbackSession(harness.deps);
			const slow = session.load('ch-a', 'work-a');
			await session.load('ch-a', 'work-b');
			expect(get(session.feedbackItems).map((f) => f.comment)).toEqual(['b']);
			gateA.resolve(Response.json({ feedback: [feedbackRow({ comment: 'stale-a' })] }));
			await slow;
			expect(get(session.feedbackItems).map((f) => f.comment)).toEqual(['b']);
			expect(get(session.feedbackLoading)).toBe(false);
			expect(get(session.feedbackError)).toBeNull();
			session.dispose();
		});

		test('stale save follow-up never touches the new view', async () => {
			const harness = makeHarness();
			const postGate = deferred<Response>();
			let loads = 0;
			harness.handler(async (channelId, url, options) => {
				if (options?.method === 'POST') return postGate.promise;
				loads += 1;
				return Response.json({ feedback: [feedbackRow({ comment: `list-${loads}` })] });
			});
			const session = createGalleryFeedbackSession(harness.deps);
			const saving = session.add('ch-a', 'work-a', 'first', 10, 20);
			await session.load('ch-a', 'work-b');
			const before = get(session.feedbackItems).map((f) => f.comment);
			postGate.resolve(Response.json({ feedbackId: 'feedback_9', feedback: [] }));
			expect(await saving).toBe('feedback_9');
			expect(get(session.feedbackItems).map((f) => f.comment)).toEqual(before);
			expect(loads).toBe(1);
			session.dispose();
		});

		test('logout retires scope and fences late writes', async () => {
			const harness = makeHarness();
			const gate = deferred<Response>();
			harness.handler(() => gate.promise);
			const session = createGalleryFeedbackSession(harness.deps);
			const pending = session.load('ch-a', 'work-a');
			harness.token(null);
			harness.account(null);
			harness.generation(1);
			harness.fireSessionCleared('https://one.test');
			gate.resolve(Response.json({ feedback: [feedbackRow({ comment: 'late' })] }));
			await pending;
			expect(get(session.feedbackItems)).toEqual([]);
			expect(get(session.feedbackLoading)).toBe(false);
			expect(String(get(session.feedbackError) || '')).toMatch(/session|sign in/i);
			session.dispose();
		});

		test('account switch fences late results without leaking them', async () => {
			const harness = makeHarness();
			const gate = deferred<Response>();
			harness.handler(() => gate.promise);
			const session = createGalleryFeedbackSession(harness.deps);
			const pending = session.load('ch-a', 'work-a');
			harness.token(jwt('9'));
			harness.account('9');
			gate.resolve(Response.json({ feedback: [feedbackRow({ comment: 'other-account' })] }));
			await pending;
			expect(get(session.feedbackItems)).toEqual([]);
			expect(get(session.feedbackLoading)).toBe(false);
			session.dispose();
		});

		test('context retirement immediately clears loaded feedback and fences an A-B-A response', async () => {
			const harness = makeHarness();
			let contextChanged = () => {};
			const session = createGalleryFeedbackSession({
				...harness.deps,
				onContextChanged: (listener) => { contextChanged = listener; return () => {}; }
			});
			harness.handler(async () => Response.json({ feedback: [feedbackRow()] }));
			await session.load('ch-a', 'work-a');
			expect(get(session.feedbackItems)).toHaveLength(1);
			const gate = deferred<Response>();
			harness.handler(() => gate.promise);
			const pending = session.load('ch-a', 'work-a');
			harness.server('https://two.test');
			contextChanged();
			expect(get(session.feedbackItems)).toEqual([]);
			harness.server('https://one.test');
			contextChanged();
			gate.resolve(Response.json({ feedback: [feedbackRow({ comment: 'retired' })] }));
			await pending;
			expect(get(session.feedbackItems)).toEqual([]);
			session.dispose();
		});

		test('only matching revocation retires loaded content and notifies draft owners', async () => {
			const harness = makeHarness();
			let revoke = (_event: { channelId: string }) => {};
			const session = createGalleryFeedbackSession({ ...harness.deps,
				onRevoked: (listener) => { revoke = listener; return () => {}; }
			});
			let retired = 0;
			session.onRetired(() => retired++);
			harness.handler(async () => Response.json({ feedback: [feedbackRow()] }));
			await session.load('ch-a', 'work-a');
			revoke({ channelId: 'other' });
			expect(get(session.feedbackItems)).toHaveLength(1);
			expect(retired).toBe(0);
			revoke({ channelId: 'ch-a' });
			expect(get(session.feedbackItems)).toEqual([]);
			expect(retired).toBe(1);
			session.dispose();
		});

		test('disposal clears loaded feedback and removes event subscriptions', async () => {
			const harness = makeHarness();
			let stopped = 0;
			const session = createGalleryFeedbackSession({ ...harness.deps,
				onContextChanged: () => () => { stopped++; },
				onRevoked: () => () => { stopped++; }
			});
			harness.handler(async () => Response.json({ feedback: [feedbackRow()] }));
			await session.load('ch-a', 'work-a');
			session.dispose();
			expect(get(session.feedbackItems)).toEqual([]);
			expect(stopped).toBe(2);
		});

		test('retirement while parsing save acknowledgement prevents follow-up and receipt', async () => {
			const harness = makeHarness();
			let change = () => {};
			const session = createGalleryFeedbackSession({ ...harness.deps,
				onContextChanged: (listener) => { change = listener; return () => {}; }
			});
			await session.load('ch-a', 'work-a');
			const body = deferred<{ feedbackId: string }>();
			const parsing = deferred<void>();
			harness.handler(async () => ({ ok: true, status: 200,
				json: () => { parsing.resolve(); return body.promise; }
			}) as Response);
			const pending = session.add('ch-a', 'work-a', 'text', 1, 2);
			await parsing.promise;
			change();
			body.resolve({ feedbackId: 'accepted-before-retirement' });
			expect(await pending).toBeNull();
			expect(harness.requests()).toHaveLength(2);
			session.dispose();
		});

		test('same-account token refresh keeps recoverable results', async () => {
			const harness = makeHarness();
			const gate = deferred<Response>();
			harness.handler(() => gate.promise);
			const session = createGalleryFeedbackSession(harness.deps);
			const pending = session.load('ch-a', 'work-a');
			harness.token(jwt('7', 'refreshed'));
			gate.resolve(Response.json({ feedback: [feedbackRow({ comment: 'kept' })] }));
			await pending;
			expect(get(session.feedbackItems).map((f) => f.comment)).toEqual(['kept']);
			expect(get(session.feedbackError)).toBeNull();
			session.dispose();
		});

		test('a 401 refreshes once and retries without losing the view', async () => {
			const harness = makeHarness();
			let calls = 0;
			harness.handler(async () => {
				calls += 1;
				if (calls === 1) return new Response('unauthorized', { status: 401 });
				return Response.json({ feedback: [feedbackRow({ comment: 'after-refresh' })] });
			});
			const session = createGalleryFeedbackSession(harness.deps);
			await session.load('ch-a', 'work-a');
			expect(calls).toBe(2);
			expect(harness.refreshes()).toBe(1);
			expect(get(session.feedbackItems).map((f) => f.comment)).toEqual(['after-refresh']);
			expect(get(session.feedbackError)).toBeNull();
			session.dispose();
		});

		test('load failures are truthful errors, never empty-success', async () => {
			const harness = makeHarness();
			harness.handler(async () => new Response('boom', { status: 500 }));
			const session = createGalleryFeedbackSession(harness.deps);
			await session.load('ch-a', 'work-a');
			expect(get(session.feedbackItems)).toEqual([]);
			expect(String(get(session.feedbackError) || '')).toMatch(/500|load/i);
			expect(get(session.feedbackLoading)).toBe(false);
			session.dispose();
		});

		test('save failures surface and resolve to null', async () => {
			const harness = makeHarness();
			harness.handler(async (channelId, url, options) =>
				options?.method === 'POST' || options?.method === 'DELETE'
					? new Response('denied', { status: 403 })
					: Response.json({ feedback: [] })
			);
			const session = createGalleryFeedbackSession(harness.deps);
			expect(await session.add('ch-a', 'work-a', 'nope', 1, 2)).toBeNull();
			expect(String(get(session.feedbackError) || '')).toMatch(/403|denied|add/i);
			expect(await session.remove('ch-a', 'work-a', 'feedback_1')).toBe(false);
			session.dispose();
		});

		test('disposed sessions ignore late completions', async () => {
			const harness = makeHarness();
			const gate = deferred<Response>();
			harness.handler(() => gate.promise);
			const session = createGalleryFeedbackSession(harness.deps);
			const pending = session.load('ch-a', 'work-a');
			session.dispose();
			gate.resolve(Response.json({ feedback: [feedbackRow()] }));
			await pending;
			expect(get(session.feedbackItems)).toEqual([]);
			expect(get(session.feedbackLoading)).toBe(false);
			await session.load('ch-a', 'work-a');
			expect(harness.requests()).toHaveLength(1);
			session.dispose();
		});

		test('album-derived work ids reach the endpoint unchanged', async () => {
			const harness = makeHarness();
			const session = createGalleryFeedbackSession(harness.deps);
			await session.load('ch-a', 'album-alb_1-item-item_2');
			expect(harness.requests()).toHaveLength(1);
			expect(harness.requests()[0].url).toContain(
				'/api/gallery/ch-a/works/album-alb_1-item-item_2/feedback'
			);
			session.dispose();
		});

		test('snake_case wire payloads map to client fields', async () => {
			const harness = makeHarness();
			harness.handler(async () => Response.json({ feedback: [feedbackRow()] }));
			const session = createGalleryFeedbackSession(harness.deps);
			await session.load('ch-a', 'album-alb_1-item-item_2');
			const [item] = get(session.feedbackItems);
			expect(item.feedbackId).toBe('feedback_1');
			expect(item.workId).toBe('album-alb_1-item-item_2');
			expect(item.channelId).toBe('ch-a');
			expect(item.authorUserId).toBe(7);
			expect(item.comment).toBe('Nice light');
			expect(item.xPercent).toBeCloseTo(12.5);
			expect(item.yPercent).toBeCloseTo(40);
			session.dispose();
		});

		test('old save completions never clear a newer draft', () => {
			const saved = { marker: { x: 10, y: 20 }, text: 'first' };
			expect(shouldClearFeedbackDraft(saved, { marker: { x: 10, y: 20 }, text: 'first' })).toBe(true);
			expect(shouldClearFeedbackDraft(saved, { marker: { x: 10, y: 20 }, text: 'edited after save' })).toBe(
				false
			);
			expect(shouldClearFeedbackDraft(saved, { marker: { x: 1, y: 2 }, text: 'first' })).toBe(false);
			expect(shouldClearFeedbackDraft(saved, null)).toBe(false);
		});
	});
}
