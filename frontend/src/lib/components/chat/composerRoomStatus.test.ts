import { describe, expect, test } from 'bun:test';
import { privacyStateFor } from '../../privacy/privacyState';
import { composerPrivacyInput } from './composerPrivacy';
import { roomStatusSettled, watchComposerRoomStatus, type ComposerRoomStatus, type RoomStatusSocket } from './composerRoomStatus';

// Contract: design spec §7.20 and §9.2, AGENTS.md rule 13: an explicit plaintext fallback is
// labelled server-readable. Review finding (w1-composer r1, major): a DM opened in the channel
// stream kept "Encryption pending" after the member chose "send server-readable instead" on
// another surface, while the send path already sent plaintext.

type Status = ComposerRoomStatus & { serverReadableAllowedByMe?: boolean; tag?: string };

const PENDING: Status = { enabled: false, pendingDefault: true, serverReadableSelected: false, tag: 'pending' };
const BY_CHOICE: Status = { enabled: false, pendingDefault: false, serverReadableSelected: true, serverReadableAllowedByMe: true, tag: 'by-choice' };
const ENCRYPTED: Status = { enabled: true, pendingDefault: false, serverReadableSelected: false, tag: 'encrypted' };

/** Manual clock: timers fire only when the test advances time. */
function fakeTimers() {
	let clock = 0;
	let seq = 0;
	const timeouts = new Map<number, { at: number; fn: () => void }>();
	const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
	return {
		now: () => clock,
		timers: {
			setTimeout: (fn: () => void, ms: number) => {
				const handle = ++seq;
				timeouts.set(handle, { at: clock + ms, fn });
				return handle;
			},
			clearTimeout: (handle: unknown) => void timeouts.delete(handle as number),
			setInterval: (fn: () => void, ms: number) => {
				const handle = ++seq;
				intervals.set(handle, { every: ms, next: clock + ms, fn });
				return handle;
			},
			clearInterval: (handle: unknown) => void intervals.delete(handle as number)
		},
		async advance(ms: number) {
			const end = clock + ms;
			for (;;) {
				let nextAt = Infinity;
				let run: (() => void) | null = null;
				for (const [handle, t] of timeouts) if (t.at <= end && t.at < nextAt) { nextAt = t.at; run = () => { timeouts.delete(handle); t.fn(); }; }
				for (const t of intervals.values()) if (t.next <= end && t.next < nextAt) { nextAt = t.next; run = () => { t.next += t.every; t.fn(); }; }
				if (!run) break;
				clock = nextAt;
				run();
				await flush();
			}
			clock = end;
			await flush();
		},
		pending: () => ({ timeouts: timeouts.size, intervals: intervals.size })
	};
}

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function fakeSocket() {
	const handlers = new Map<string, Set<(payload?: { channelId?: string }) => void>>();
	const socket: RoomStatusSocket & { emit(event: string, payload?: { channelId?: string }): void; count(event: string): number } = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(handler);
		},
		off(event, handler) {
			handlers.get(event)?.delete(handler);
		},
		emit(event, payload) {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
		count: (event) => handlers.get(event)?.size ?? 0
	};
	return socket;
}

function fakeWindow() {
	const listeners = new Set<() => void>();
	return {
		addEventListener: (_type: 'focus', fn: () => void) => void listeners.add(fn),
		removeEventListener: (_type: 'focus', fn: () => void) => void listeners.delete(fn),
		focus: () => listeners.forEach((fn) => fn()),
		size: () => listeners.size
	};
}

/** A server whose answer the test changes; every request is counted. */
function fakeServer(initial: Status | Error) {
	let answer: Status | Error = initial;
	const server = {
		requests: 0,
		set(next: Status | Error) { answer = next; },
		refresh: async (_id: string) => {
			server.requests += 1;
			if (answer instanceof Error) throw answer;
			return { ...answer };
		}
	};
	return server;
}

function setup(initial: Status | Error, extra: { cached?: () => Status | null } = {}) {
	const clock = fakeTimers();
	const server = fakeServer(initial);
	let socket: ReturnType<typeof fakeSocket> | null = fakeSocket();
	const win = fakeWindow();
	const seen: Status[] = [];
	const watch = watchComposerRoomStatus<Status>({
		channelId: 'dm-1',
		refresh: server.refresh,
		cached: extra.cached,
		socket: () => socket,
		onStatus: (status) => seen.push(status),
		focusTarget: win,
		timers: clock.timers,
		now: clock.now
	});
	return {
		clock, server, win, seen, watch,
		get socket() { return socket; },
		swapSocket(next: ReturnType<typeof fakeSocket> | null) { socket = next; },
		latest: () => seen.at(-1)?.tag
	};
}

/** What the colophon says for the latest status the watcher delivered. */
function colophonFor(status: Status | undefined) {
	return privacyStateFor(composerPrivacyInput({ channelType: 'dm', hostGaveStatus: false, ownStatus: status ?? null }));
}

describe('a pending room is asked again until it settles', () => {
	test('a server-readable choice made elsewhere reaches the colophon within one poll', async () => {
		const s = setup(PENDING);
		await flush();
		expect(s.latest()).toBe('pending');
		expect(colophonFor(s.seen.at(-1))).toBe('encryption-pending');
		// The member picks "send server-readable instead" in the DM panel or on their phone. The
		// server emits nothing for that choice.
		s.server.set(BY_CHOICE);
		await s.clock.advance(5000);
		expect(s.latest()).toBe('by-choice');
		expect(colophonFor(s.seen.at(-1))).toBe('server-readable-by-choice');
		s.watch.dispose();
	});

	test('a settled room is not polled (encrypted or explicitly server-readable)', async () => {
		for (const settled of [ENCRYPTED, BY_CHOICE]) {
			const s = setup(settled);
			await flush();
			const before = s.server.requests;
			await s.clock.advance(30_000);
			expect(s.server.requests).toBe(before);
			s.watch.dispose();
		}
		expect(roomStatusSettled(PENDING)).toBe(false);
		expect(roomStatusSettled(null)).toBe(false);
	});

	test('server-readable chosen by another member keeps asking until this member confirms', async () => {
		// Recheck finding (w1-composer r1): the room read as settled, so a confirmation made on
		// this member's phone never reached the colophon.
		const CHOSEN_BY_OTHER: Status = { enabled: false, pendingDefault: false, serverReadableSelected: true, serverReadableAllowedByMe: false, tag: 'held' };
		expect(roomStatusSettled(CHOSEN_BY_OTHER)).toBe(false);
		const s = setup(CHOSEN_BY_OTHER);
		await flush();
		expect(colophonFor(s.seen.at(-1))).toBe('server-readable');
		s.server.set(BY_CHOICE);
		await s.clock.advance(5_000);
		expect(colophonFor(s.seen.at(-1))).toBe('server-readable-by-choice');
		const before = s.server.requests;
		await s.clock.advance(30_000);
		expect(s.server.requests).toBe(before);
		s.watch.dispose();
	});

	test('a newer answer another surface put in the shared cache is adopted without a request', async () => {
		let cache: Status | null = null;
		const s = setup(PENDING, { cached: () => cache });
		await flush();
		expect(s.latest()).toBe('pending');
		cache = { ...BY_CHOICE };
		s.server.set(new Error('offline'));
		s.watch.refresh();
		expect(s.latest()).toBe('by-choice');
		s.watch.dispose();
	});
});

describe('the server and the window prompt a fresh read', () => {
	test('e2ee-room-updated for this room, privacy-policy-updated and window focus each ask again', async () => {
		const s = setup(BY_CHOICE);
		await flush();
		s.server.set(ENCRYPTED);
		s.socket!.emit('e2ee-room-updated', { channelId: 'another-room' });
		await flush();
		expect(s.latest()).toBe('by-choice');
		s.socket!.emit('e2ee-room-updated', { channelId: 'dm-1' });
		await flush();
		expect(s.latest()).toBe('encrypted');
		s.server.set(PENDING);
		s.socket!.emit('privacy-policy-updated');
		await flush();
		expect(s.latest()).toBe('pending');
		s.server.set(BY_CHOICE);
		s.win.focus();
		await flush();
		expect(s.latest()).toBe('by-choice');
		s.watch.dispose();
	});

	test('a new socket (reconnect, server switch) is rebound on the next poll and asked at once', async () => {
		const s = setup(ENCRYPTED);
		await flush();
		const old = s.socket!;
		const next = fakeSocket();
		s.swapSocket(next);
		s.server.set(BY_CHOICE);
		await s.clock.advance(5000);
		expect(old.count('e2ee-room-updated')).toBe(0);
		expect(old.count('privacy-policy-updated')).toBe(0);
		expect(next.count('e2ee-room-updated')).toBe(1);
		expect(s.latest()).toBe('by-choice');
		s.server.set(ENCRYPTED);
		next.emit('e2ee-room-updated', { channelId: 'dm-1' });
		await flush();
		expect(s.latest()).toBe('encrypted');
		s.watch.dispose();
	});

	test('the composer asks on field focus and after a send while pending, not while settled, and not twice at once', async () => {
		const s = setup(PENDING);
		await flush();
		await s.clock.advance(2000);
		const before = s.server.requests;
		s.server.set(BY_CHOICE);
		s.watch.refresh();
		await flush();
		expect(s.server.requests).toBe(before + 1);
		expect(s.latest()).toBe('by-choice');
		await s.clock.advance(2000);
		s.watch.refresh();
		await flush();
		expect(s.server.requests).toBe(before + 1);
		s.watch.dispose();
	});
});

describe('failures fail closed', () => {
	test('no answer leaves the colophon Checking; retries at 2, 4 and 8 s, then waits for a trigger', async () => {
		const s = setup(new Error('offline'));
		await flush();
		expect(s.seen).toEqual([]);
		expect(colophonFor(undefined)).toBe('checking');
		await s.clock.advance(2000 + 4000 + 8000);
		expect(s.server.requests).toBe(4);
		await s.clock.advance(60_000);
		expect(s.server.requests).toBe(4);
		s.server.set(PENDING);
		s.win.focus();
		await flush();
		expect(s.latest()).toBe('pending');
		s.watch.dispose();
	});

	test('a failed re-read keeps the last answer rather than guessing', async () => {
		const s = setup(PENDING);
		await flush();
		s.server.set(new Error('offline'));
		await s.clock.advance(5000);
		expect(s.latest()).toBe('pending');
		expect(colophonFor(s.seen.at(-1))).toBe('encryption-pending');
		s.watch.dispose();
	});
});

describe('dispose', () => {
	test('stops polling, drops every listener and ignores an answer still in flight', async () => {
		const s = setup(PENDING);
		const socket = s.socket!;
		s.watch.dispose();
		await flush();
		expect(s.seen).toEqual([]);
		expect(socket.count('e2ee-room-updated')).toBe(0);
		expect(socket.count('privacy-policy-updated')).toBe(0);
		expect(s.win.size()).toBe(0);
		expect(s.clock.pending()).toEqual({ timeouts: 0, intervals: 0 });
		const requests = s.server.requests;
		await s.clock.advance(30_000);
		s.watch.refresh();
		expect(s.server.requests).toBe(requests);
	});
});
