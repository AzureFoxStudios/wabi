import { expect, mock, test } from 'bun:test';
import { writable } from 'svelte/store';

mock.module('./callAudioGraph', () => ({ resumeCallAudioGraph: async () => true }));
const { installCallBackgroundSupport } = await import('./callBackgroundSupport');

function harness(opts: { visibility?: 'visible' | 'hidden'; wakeLock?: boolean; mediaSession?: boolean } = {}) {
	const listeners = new Map<string, Set<() => void>>();
	const doc = {
		visibilityState: opts.visibility ?? 'visible',
		addEventListener: (type: string, cb: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(cb); },
		removeEventListener: (type: string, cb: () => void) => { listeners.get(type)?.delete(cb); },
	};
	const locks: Array<{ released: boolean; release(): Promise<void> }> = [];
	const session: { playbackState: string; metadata: unknown } = { playbackState: 'none', metadata: null };
	const nav: Record<string, unknown> = {};
	if (opts.wakeLock !== false) nav.wakeLock = { request: async () => {
		const sentinel = { released: false, release: async () => { sentinel.released = true; } };
		locks.push(sentinel); return sentinel;
	} };
	if (opts.mediaSession !== false) nav.mediaSession = session;
	const resumes = { count: 0 };
	const active = writable(false);
	const stop = installCallBackgroundSupport({
		doc: doc as unknown as Document, nav: nav as unknown as Navigator, active,
		resumeAudio: async () => { resumes.count++; return true; }, title: () => 'Test call',
	});
	const fire = (type: string) => listeners.get(type)?.forEach((cb) => cb());
	return { doc, locks, session, resumes, active, stop, fire, listeners };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('joining a call takes a wake lock and marks the media session playing', async () => {
	const h = harness(); h.active.set(true); await settle();
	expect(h.locks.length).toBe(1);
	expect(h.locks[0].released).toBe(false);
	expect(h.session.playbackState).toBe('playing');
});

test('leaving the call releases the lock and clears the media session', async () => {
	const h = harness(); h.active.set(true); await settle(); h.active.set(false); await settle();
	expect(h.locks[0].released).toBe(true);
	expect(h.session.playbackState).toBe('none');
});

test('returning to the app resumes call audio and re-acquires a released lock', async () => {
	const h = harness(); h.active.set(true); await settle();
	h.doc.visibilityState = 'hidden'; h.fire('visibilitychange');
	expect(h.resumes.count).toBe(0);
	// The browser drops the lock when hidden; model that.
	h.locks[0].released = true;
	h.doc.visibilityState = 'visible'; h.fire('visibilitychange'); await settle();
	expect(h.resumes.count).toBe(1);
});

test('no audio resume or lock work happens outside a call', async () => {
	const h = harness(); h.fire('visibilitychange'); await settle();
	expect(h.resumes.count).toBe(0);
	expect(h.locks.length).toBe(0);
});

test('a hidden page never requests a wake lock', async () => {
	const h = harness({ visibility: 'hidden' }); h.active.set(true); await settle();
	expect(h.locks.length).toBe(0);
	expect(h.session.playbackState).toBe('playing');
});

test('missing wake lock and media session APIs degrade silently', async () => {
	const h = harness({ wakeLock: false, mediaSession: false });
	h.active.set(true); await settle();
	h.doc.visibilityState = 'visible'; h.fire('visibilitychange'); await settle();
	expect(h.resumes.count).toBe(1);
});

test('uninstalling releases everything and detaches listeners', async () => {
	const h = harness(); h.active.set(true); await settle(); h.stop(); await settle();
	expect(h.locks[0].released).toBe(true);
	expect(h.session.playbackState).toBe('none');
	expect(h.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
});
