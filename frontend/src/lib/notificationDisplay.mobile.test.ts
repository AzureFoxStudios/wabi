import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: true }));
mock.module('./branding', () => ({ brandName: 'Wabi' }));
let native = true;
mock.module('./tauri-platform', () => ({ isTauriRuntime: () => native }));
const notify = mock(async (_title: string, _body: string) => true);
mock.module('./tauri-notifications', () => ({ sendTauriNotification: notify, requestTauriNotificationPermission: async () => true }));
mock.module('./notificationSettings', () => ({
	getNotificationSound: () => 'none', getNotificationVolume: () => 0,
	getNotificationSquelchSettings: () => ({ suppressEveryoneHere: false, suppressRoleMentions: false }),
	areNotificationsEnabled: () => true, isNotificationPreviewEnabled: () => true,
	getCallRingtoneMode: () => 'none', getCallRingtoneCustomAudio: () => null,
	getStoredCustomSynthRingtonePreset: () => null, getCallRingtoneVolume: () => 0
}));
mock.module('./notificationAudio', () => ({ playNotificationSound: () => {}, playCallRingtone: () => {} }));
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true });
const { showNotification, showCallNotification, requestNotificationPermission } = await import('./notificationDisplay');

beforeEach(() => { native = true; notify.mockClear(); delete (globalThis as { Notification?: unknown }).Notification; });

test('mobile WebView sends message and call notifications with no browser Notification global', async () => {
	expect(() => showNotification({ title: 'Message', body: 'New activity' }, false)).not.toThrow();
	expect(() => showCallNotification('Caller', false)).not.toThrow();
	expect(notify.mock.calls).toEqual([['Message', 'New activity'], ['Incoming Voice Call', 'Caller is calling...']]);
	expect(await requestNotificationPermission()).toBe('granted');
});

test('a browser without Notification fails safely', async () => {
	native = false;
	expect(() => showNotification({ title: 'Message', body: 'New activity' }, false)).not.toThrow();
	expect(showCallNotification('Caller', true)).toBeNull();
	expect(notify).not.toHaveBeenCalled();
	expect(await requestNotificationPermission()).toBe('denied');
});
