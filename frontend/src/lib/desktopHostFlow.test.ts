import { describe, expect, test } from 'bun:test';
import { checkCommunityForJoin, createHostedCommunity, hostStateLabel, shouldOpenHosting, type HostCommand, type HostStatus } from './desktopHostFlow';

const fresh: HostStatus = {
	running: false, ready: false, setupRequired: null, localUrl: null, sharing: 'local', error: null,
	dataDirectory: '/profile/community', logDirectory: '/profile/logs', backupIds: [], binaryAvailable: true,
	buildRevision: 'test', testBuild: true, communityName: '', hasCommunity: false, serverId: null
};
const ready = { ...fresh, running: true, ready: true, setupRequired: true, localUrl: 'http://127.0.0.1:3001', hasCommunity: true };
const input = { communityName: '  Our community  ', username: '  owner  ', password: 'unique-password', confirmation: 'unique-password' };

describe('desktop owner onboarding', () => {
	test('validates owner input before starting any process', async () => {
		const calls: string[] = [];
		const command: HostCommand = async name => { calls.push(name); throw new Error('must not start'); };
		for (const bad of [{ ...input, communityName: '' }, { ...input, username: 'a' }, { ...input, confirmation: 'different' }]) {
			await expect(createHostedCommunity(command, bad)).rejects.toThrow();
		}
		expect(calls).toEqual([]);
	});
	test('only registers after real ready status; passes name and credentials to native', async () => {
		const calls: Array<[string, Record<string, unknown> | undefined]> = [];
		const account = { accessToken: 'access', refreshToken: 'refresh', user: { id: 1, username: 'owner' } };
		const command: HostCommand = async <T>(name: string, args?: Record<string, unknown>) => { calls.push([name, args]); return (name === 'host_start' ? ready : account) as T; };
		const result = await createHostedCommunity(command, input);
		expect(calls).toEqual([['host_start', undefined], ['host_account', { communityName: 'Our community', username: 'owner', password: input.password, register: true }]]);
		expect(result).toEqual({ host: ready, account });
	});
	test('not ready, failed, unknown setup and existing owner never reach registration', async () => {
		for (const status of [{ ...ready, ready: false }, { ...ready, ready: false, error: 'Port in use' }, { ...ready, setupRequired: null }, { ...ready, setupRequired: false }]) {
			const calls: string[] = [];
			const command: HostCommand = async <T>(name: string) => { calls.push(name); return status as T; };
			await expect(createHostedCommunity(command, input)).rejects.toThrow();
			expect(calls).toEqual(['host_start']);
		}
	});
	test('native startup failure does not retry, stop, reset or claim owner', async () => {
		const calls: string[] = [];
		const command: HostCommand = async name => { calls.push(name); throw new Error('Storage incomplete; files preserved'); };
		await expect(createHostedCommunity(command, input)).rejects.toThrow('files preserved');
		expect(calls).toEqual(['host_start']);
	});
});

describe('desktop existing navigation and status', () => {
	test('fresh install and selected stopped local profile show community chooser', () => {
		expect(shouldOpenHosting(null, fresh)).toBe(true);
		expect(shouldOpenHosting(ready.localUrl, { ...ready, running: false, ready: false, setupRequired: null })).toBe(true);
		expect(shouldOpenHosting(ready.localUrl, ready)).toBe(true);
	});
	test('ready configured community and unrelated saved server preserve normal scoped navigation', () => {
		expect(shouldOpenHosting(ready.localUrl, { ...ready, setupRequired: false })).toBe(false);
		expect(shouldOpenHosting('https://another.example', { ...ready, running: false, ready: false })).toBe(false);
	});
	test('exposes four honest lifecycle states', () => {
		expect(hostStateLabel(fresh)).toBe('Stopped');
		expect(hostStateLabel(fresh, true)).toBe('Starting');
		expect(hostStateLabel({ ...ready, ready: false })).toBe('Starting');
		expect(hostStateLabel(ready)).toBe('Ready');
		expect(hostStateLabel({ ...fresh, error: 'Cannot open storage' })).toBe('Failed');
	});
});

describe('joining requires an existing community without starting a server', () => {
	test('checks exact intended server with no ambient account credentials or redirects', async () => {
		const calls: unknown[] = [];
		const request = async (url: string, options: RequestInit) => { calls.push([url, options.credentials, options.redirect]); return Response.json({ setupRequired: false }); };
		await checkCommunityForJoin('https://community.example', request);
		expect(calls).toEqual([['https://community.example/api/setup/status', 'omit', 'error']]);
	});
	test('rejects unowned, unreachable or non-Wabi targets before changing server', async () => {
		for (const response of [Response.json({ setupRequired: true }), Response.json({}), new Response('offline', { status: 503 })]) {
			await expect(checkCommunityForJoin('https://community.example', async () => response)).rejects.toThrow();
		}
		await expect(checkCommunityForJoin('https://community.example', async () => { throw new TypeError('Failed to fetch'); })).rejects.toThrow('ask the host to start it');
	});
});
