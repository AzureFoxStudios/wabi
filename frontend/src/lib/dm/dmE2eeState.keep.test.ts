/**
 * The room half of "does this content stay on the device" (privacy/contentEgress.ts): the shared
 * derivation every gate uses, the seed from this device's stored status (no "checking" flash for
 * a known server-readable DM), and the shared, bounded status retry.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { get } from 'svelte/store';

const token = `x.${btoa(JSON.stringify({ sub: 12 })).replace(/=+$/, '')}.y`;
const store = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key)
};

mock.module('$lib/authSession', () => ({
	getAuthToken: () => token,
	authSessionGeneration: () => 1,
	onAuthSessionCleared: () => () => {}
}));
mock.module('$lib/api/authRefresh', () => ({ tryRefresh: async () => false }));

let statusAnswers: Array<() => Response> = [];
const statusRequests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	statusRequests.push(url);
	const next = statusAnswers.shift();
	return next ? next() : new Response('{}', { status: 503 });
}) as typeof fetch;

const { getServerUrl } = await import('$lib/serverUrl');
const SERVER_KEY = getServerUrl().replace(/\/+$/, '');
const state = await import('./dmE2eeState');
const readable = { enabled: false, pendingDefault: false, serverReadableSelected: false, epoch: 0, membershipRevision: '', currentMembershipRevision: '', needsRekey: false, devices: [], missingUserIds: [], keyEnvelopes: [], downgradeAllowed: false };

beforeEach(() => {
	store.clear();
	statusAnswers = [];
	statusRequests.length = 0;
	state.clearE2eeCache();
	state._setStatusRetryDelaysForTest([5, 5, 5]);
});

describe('roomContentKeepReason', () => {
	test('a DM with no known status fails closed as checking', () => {
		expect(state.roomContentKeepReason('dm-1', 'dm')).toBe('checking');
	});

	test('a DM this device saw as server-readable is not checking on the next load', () => {
		store.set(`wabi:e2ee-room-status:v1:${SERVER_KEY}|12:dm-2`, JSON.stringify(readable));
		expect(state.roomContentKeepReason('dm-2', 'dm')).toBeNull();
		store.set(`wabi:e2ee-room-status:v1:${SERVER_KEY}|12:dm-3`, JSON.stringify({ ...readable, enabled: true }));
		expect(state.roomContentKeepReason('dm-3', 'group')).toBe('experimental-encryption');
	});

	test('unlisted channels: DM/group ids fail closed, any other id is a shared channel', () => {
		expect(state.roomContentKeepReason('dm-9', null)).toBe('checking');
		expect(state.roomContentKeepReason('group-9', null)).toBe('checking');
		expect(state.roomContentKeepReason('general', null)).toBeNull();
		expect(state.roomContentKeepReason('general', 'text')).toBeNull();
	});
});

describe('ensureE2eeStatus', () => {
	test('a failed status request is retried on the shared schedule, then the gate opens', async () => {
		expect(state.roomContentKeepReason('dm-4', 'dm')).toBe('checking');
		const before = get(state.e2eeStatusRevision);
		statusAnswers = [() => new Response('{}', { status: 503 }), () => new Response('{}', { status: 503 }), () => new Response(JSON.stringify(readable))];
		state.ensureE2eeStatus('dm-4');
		state.ensureE2eeStatus('dm-4'); // a second consumer shares the same schedule
		for (let i = 0; i < 50 && state.roomContentKeepReason('dm-4', 'dm') !== null; i += 1) await Bun.sleep(5);
		expect(state.roomContentKeepReason('dm-4', 'dm')).toBeNull();
		expect(statusRequests.filter((url) => url.endsWith('/api/e2ee/channels/dm-4')).length).toBe(3);
		expect(get(state.e2eeStatusRevision)).toBeGreaterThan(before);
	});

	test('after the last retry it stops until the window regains focus', async () => {
		state.ensureE2eeStatus('dm-5');
		await Bun.sleep(80);
		const attempts = statusRequests.length;
		expect(attempts).toBe(4);
		state.ensureE2eeStatus('dm-5');
		await Bun.sleep(20);
		expect(statusRequests.length).toBe(attempts);
		expect(state.roomContentKeepReason('dm-5', 'dm')).toBe('checking');
	});
});
