import { beforeEach, expect, mock, test } from 'bun:test';
import type { SignedCommunityRoster } from './communityRoster';
import type { ReconnectDependencies } from './socketConnectionReconnect';

mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));

const first = 'https://roof.example';
const second = 'https://materials.example';
const third = 'https://equipment.example';
const privateUrl = 'http://100.64.1.3:3001';
let activeUrl = first;
let rosterAvailable = true;
let afterRosterRead: (() => void) | null = null;
const tokens = new Map<string, string>();
const accounts = new Map<string, number>();
const usernames = new Map<string, string>();
const generations = new Map<string, number>();

const roster: SignedCommunityRoster = {
	body: {
		schemaVersion: 1,
		communityId: 'a'.repeat(64),
		version: 1,
		issuedAt: 1,
		expiresAt: 2,
		entries: [
			{ nodeId: 'equipment', role: 'anchor', url: third },
			{ nodeId: 'materials', role: 'anchor', url: second },
			{ nodeId: 'roof', role: 'authority', url: first },
			{ nodeId: 'tailcat', role: 'anchor', url: privateUrl }
		]
	},
	publicKey: 'verified-by-injected-roster-source',
	signature: 'verified-by-injected-roster-source'
};

const dependencies: ReconnectDependencies = {
	getServerUrl: () => activeUrl,
	setConfiguredServerUrl: (url) => { activeUrl = url; return url; },
	getConfiguredServerRememberPreference: () => true,
	authSessionGeneration: (url) => generations.get(url ?? activeUrl) ?? 0,
	getAuthToken: (url) => tokens.get(url ?? activeUrl) ?? null,
	getStoredDbUserId: (url) => accounts.get(url ?? activeUrl) ?? null,
	getStoredUsername: (url) => usernames.get(url ?? activeUrl) ?? null,
	setAuthToken: (value, url) => {
		if (value) tokens.set(url ?? activeUrl, value);
		else tokens.delete(url ?? activeUrl);
	},
	setStoredDbUserId: (value, url) => {
		if (value !== null && value !== undefined) accounts.set(url ?? activeUrl, Number(value));
		else accounts.delete(url ?? activeUrl);
	},
	setStoredUsername: (value, url) => {
		if (value) usernames.set(url ?? activeUrl, value);
		else usernames.delete(url ?? activeUrl);
	},
	getPinnedCommunityRoster: async () => {
		afterRosterRead?.();
		return rosterAvailable ? roster : null;
	},
	refreshCommunityRoster: async () => roster,
	canCarrySessionTo: (value, url) =>
		url.startsWith('https://') && value.body.entries.some((entry) => entry.url === url)
};

const { SocketReconnectionManager } = await import('./socketConnectionReconnect');

beforeEach(() => {
	activeUrl = first;
	rosterAvailable = true;
	afterRosterRead = null;
	tokens.clear();
	accounts.clear();
	usernames.clear();
	generations.clear();
	tokens.set(first, 'member-token');
	accounts.set(first, 7);
	usernames.set(first, 'member');
});

test('rotates across approved HTTPS entries and skips private HTTP credential carry', async () => {
	const reconnect = new SocketReconnectionManager(dependencies);
	expect(await reconnect.rotateToNextFailoverCandidate(first)).toEqual({ rotated: true, nextUrl: third });
	expect(activeUrl).toBe(third);
	expect(tokens.get(third)).toBe('member-token');
	expect(accounts.get(third)).toBe(7);
	expect(usernames.get(third)).toBe('member');
	expect(await reconnect.rotateToNextFailoverCandidate(third)).toEqual({ rotated: true, nextUrl: second });
	expect(await reconnect.rotateToNextFailoverCandidate(second)).toEqual({ rotated: true, nextUrl: first });
	expect(tokens.has(privateUrl)).toBe(false);
});

test('keeps the current endpoint when the roster is unavailable or another account owns the destination', async () => {
	const reconnect = new SocketReconnectionManager(dependencies);
	rosterAvailable = false;
	expect(await reconnect.rotateToNextFailoverCandidate(first)).toEqual({ rotated: false, nextUrl: null });
	rosterAvailable = true;
	tokens.set(third, 'another-account-token');
	tokens.set(second, 'another-account-token');
	expect(await reconnect.rotateToNextFailoverCandidate(first)).toEqual({ rotated: false, nextUrl: null });
	expect(activeUrl).toBe(first);
	expect(tokens.get(third)).toBe('another-account-token');
});

test('does not carry a token after logout or endpoint change during roster lookup', async () => {
	const reconnect = new SocketReconnectionManager(dependencies);
	afterRosterRead = () => { tokens.delete(first); };
	expect(await reconnect.rotateToNextFailoverCandidate(first)).toEqual({ rotated: false, nextUrl: null });
	expect(tokens.has(third)).toBe(false);
	tokens.set(first, 'member-token');
	afterRosterRead = () => { activeUrl = second; };
	expect(await reconnect.rotateToNextFailoverCandidate(first)).toEqual({ rotated: false, nextUrl: null });
	expect(tokens.has(third)).toBe(false);
});
