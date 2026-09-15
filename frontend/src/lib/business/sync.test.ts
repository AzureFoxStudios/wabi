import { expect, test, afterEach } from 'bun:test';
import {
	businessSyncAvailable,
	probeBusinessSyncCapability,
	getBusinessSyncMode,
	setBusinessSyncMode,
	hasPendingRemoteBusinessUpdate,
	pullFromServer,
	pushToServer,
	sync,
	triggerSync,
	initSync,
	cleanupSync
} from './sync';

const originalFetch = globalThis.fetch;
let networkCalls = 0;
afterEach(() => { globalThis.fetch = originalFetch; expect(networkCalls).toBe(0); });

function mockNoNetwork(): void {
	networkCalls = 0;
	globalThis.fetch = Object.assign(async () => {
		networkCalls++;
		throw new Error('Network should not be accessed');
	}, { preconnect: originalFetch.preconnect });
}

function restoreFetch(): void {
	globalThis.fetch = originalFetch;
}

test('businessSyncAvailable defaults to false', async () => {
	const value = await new Promise<boolean>((resolve) => {
		businessSyncAvailable.subscribe((v) => resolve(v ?? false))();
	});
	expect(value).toBe(false);
});

test('probeBusinessSyncCapability returns false without network access', async () => {
	mockNoNetwork();
	const result = await probeBusinessSyncCapability();
	expect(result).toBe(false);
	restoreFetch();
});

test('getBusinessSyncMode returns manual', () => {
	expect(getBusinessSyncMode()).toBe('manual');
});

test('setBusinessSyncMode is a no-op', () => {
	expect(() => setBusinessSyncMode('auto')).not.toThrow();
	expect(getBusinessSyncMode()).toBe('manual');
});

test('hasPendingRemoteBusinessUpdate returns false', () => {
	expect(hasPendingRemoteBusinessUpdate()).toBe(false);
});

test('pullFromServer returns false without network access', async () => {
	mockNoNetwork();
	const result = await pullFromServer();
	expect(result).toBe(false);
	restoreFetch();
});

test('pushToServer returns false without network access', async () => {
	mockNoNetwork();
	const result = await pushToServer();
	expect(result).toBe(false);
	restoreFetch();
});

test('sync returns false without network access', async () => {
	mockNoNetwork();
	const result = await sync(true);
	expect(result).toBe(false);
	restoreFetch();
});

test('sync returns false without network access (pullFirst=false)', async () => {
	mockNoNetwork();
	const result = await sync(false);
	expect(result).toBe(false);
	restoreFetch();
});

test('triggerSync is a no-op', () => {
	expect(() => triggerSync()).not.toThrow();
});

test('initSync is a no-op', () => {
	expect(() => initSync()).not.toThrow();
});

test('cleanupSync is a no-op', () => {
	expect(() => cleanupSync()).not.toThrow();
});

test('all async sync paths assert no network and return false', async () => {
	mockNoNetwork();
	const [probe, pull, push, syncResult] = await Promise.all([
		probeBusinessSyncCapability(),
		pullFromServer(),
		pushToServer(),
		sync(true)
	]);
	restoreFetch();
	expect(probe).toBe(false);
	expect(pull).toBe(false);
	expect(push).toBe(false);
	expect(syncResult).toBe(false);
});
