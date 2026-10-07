import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: true }));
mock.module('./branding', () => ({ brandName: 'Wabi' }));
mock.module('./tauri-platform', () => ({ isTauriRuntime: () => false }));
mock.module('./tauri-notifications', () => ({ sendTauriNotification: async () => true, requestTauriNotificationPermission: async () => true }));
mock.module('./notificationSettings', () => ({
	getNotificationSound: () => 'none', getNotificationVolume: () => 0,
	getNotificationSquelchSettings: () => ({ suppressEveryoneHere: false, suppressRoleMentions: false }),
	areNotificationsEnabled: () => true, isNotificationPreviewEnabled: () => true,
	getCallRingtoneMode: () => 'none', getCallRingtoneCustomAudio: () => null,
	getStoredCustomSynthRingtonePreset: () => null, getCallRingtoneVolume: () => 0
}));
mock.module('./notificationAudio', () => ({ playNotificationSound: () => {}, playCallRingtone: () => {} }));

type Shown = { title: string; options: Record<string, unknown> };
const constructed: Shown[] = [];
const viaWorker: Shown[] = [];
const closed: string[] = [];
let constructorThrows = false;

class FakeNotification {
	static permission = 'granted';
	onclick: (() => void) | null = null;
	constructor(public title: string, public options: Record<string, unknown>) {
		if (constructorThrows) throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
		constructed.push({ title, options });
	}
	addEventListener() {}
	close() { closed.push(this.title); }
}
Object.defineProperty(globalThis, 'Notification', { value: FakeNotification, configurable: true });
Object.defineProperty(globalThis, 'window', { value: { Notification: FakeNotification, focus() {} }, configurable: true });
Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
	serviceWorker: { ready: Promise.resolve({ showNotification: async (title: string, options: Record<string, unknown>) => { viaWorker.push({ title, options }); } }) }
} });
const { showNotification, showCallNotification } = await import('./notificationDisplay');

const message = { id: 'm1', channelId: 'c1', user: 'Ada', text: 'hello @me', type: 'text' } as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => { constructed.length = 0; viaWorker.length = 0; closed.length = 0; constructorThrows = false; });

test('a notification is never auto-closed after a few seconds', async () => {
	const realSetTimeout = globalThis.setTimeout; const timers: number[] = [];
	globalThis.setTimeout = ((fn: () => void, ms?: number) => { timers.push(ms ?? 0); return realSetTimeout(fn, ms); }) as typeof setTimeout;
	try {
		showNotification(message, false, 'general', { isMention: true });
		showNotification({ title: 'T', body: 'B' }, false);
	} finally { globalThis.setTimeout = realSetTimeout; }
	await settle();
	expect(constructed.length).toBe(2);
	expect(timers.filter((ms) => ms === 5000)).toEqual([]);
	expect(closed).toEqual([]);
});

test('mentions persist, ordinary messages collapse per conversation', () => {
	showNotification(message, false, 'general', { isMention: true });
	showNotification({ ...(message as object), id: 'm2' } as never, false, 'general', { isMention: false });
	const [mention, ordinary] = constructed;
	expect(mention.options.requireInteraction).toBe(true);
	expect(ordinary.options.requireInteraction).toBe(false);
	expect(mention.options.tag).toBe('message-c1');
	expect(ordinary.options.tag).toBe('message-c1');
	expect(ordinary.options.renotify).toBe(true);
	expect(mention.options.data).toEqual({ wabiNav: 'channel', channelId: 'c1', messageId: 'm1' });
});

test('a ringing call stays up until answered or declined', () => {
	expect(showCallNotification('Ada', false)).not.toBeNull();
	expect(constructed[0].options.requireInteraction).toBe(true);
});

test('Android Chrome: when the constructor throws the service worker shows the notification', async () => {
	constructorThrows = true;
	expect(() => showNotification(message, false, 'general', { isMention: true })).not.toThrow();
	await settle();
	expect(constructed).toEqual([]);
	expect(viaWorker.length).toBe(1);
	expect(viaWorker[0].title).toContain('Mention from Ada');
	expect(viaWorker[0].options.data).toEqual({ wabiNav: 'channel', channelId: 'c1', messageId: 'm1' });
});

test('Android Chrome: a call notification falls back safely too', async () => {
	constructorThrows = true;
	expect(showCallNotification('Ada', true)).toBeNull();
	await settle();
	expect(viaWorker.length).toBe(1);
	expect(viaWorker[0].options.requireInteraction).toBe(true);
});
