import { expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

if (process.env.WABI_NOTIFICATION_FIXTURE !== '1') {
  test('desktop notifications run in isolation', () => {
    const result = Bun.spawnSync([process.execPath, 'test', fileURLToPath(import.meta.url)], {
      env: { ...process.env, WABI_NOTIFICATION_FIXTURE: '1' }, stdout: 'pipe', stderr: 'pipe'
    });
    expect(new TextDecoder().decode(result.stderr)).not.toContain('(fail)');
    expect(result.exitCode).toBe(0);
  });
} else {
  let desktop = true;
  const sent: Array<[string, string]> = [];
  mock.module('$app/environment', () => ({ browser: true }));
  mock.module('$lib/branding', () => ({ brandName: 'Wabi' }));
  mock.module('$lib/tauri-platform', () => ({
    isDesktopTauri: () => desktop, isMobileTauri: () => false, isTauriRuntime: () => desktop
  }));
  const sendNativeNotification = async (title: string, body: string) => { sent.push([title, body]); return true; };
  mock.module('$lib/tauri-notifications', () => ({
    sendTauriDesktopNotification: sendNativeNotification, sendTauriNotification: sendNativeNotification
  }));
  mock.module('./notificationSettings', () => ({
    getNotificationSound: () => '', getNotificationVolume: () => 0,
    getNotificationSquelchSettings: () => ({}), areNotificationsEnabled: () => true,
    isNotificationPreviewEnabled: () => true, getCallRingtoneMode: () => '',
    getCallRingtoneCustomAudio: () => '', getStoredCustomSynthRingtonePreset: () => null,
    getCallRingtoneVolume: () => 0
  }));
  mock.module('./notificationAudio', () => ({ playNotificationSound: () => {}, playCallRingtone: () => {} }));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: true } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get Notification() { return globalThis.Notification; }
  } });
  const { showNotification, showCallNotification } = await import('./notificationDisplay');
  test('native messages and calls work without the browser Notification object', () => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: undefined });
    showNotification({ title: 'DM', body: 'Hello' }, false);
    showCallNotification('Caller', false);
    expect(sent).toEqual([['DM', 'Hello'], ['Incoming Voice Call', 'Caller is calling...']]);
  });
  test('denied browser permission cannot block native notifications', () => {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'denied' } });
    showNotification({ title: 'Message', body: 'Native' }, false);
    expect(sent.at(-1)).toEqual(['Message', 'Native']);
  });
  test('browser notifications still respect browser permission', () => {
    desktop = false;
    const before = sent.length;
    showNotification({ title: 'Message', body: 'Browser' }, false);
    showCallNotification('Caller', false);
    expect(sent.length).toBe(before);
  });
}
