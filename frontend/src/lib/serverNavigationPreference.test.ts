import { describe, expect, test } from 'bun:test';
import type { SavedServerView } from './savedServers';
import { recentSavedServers } from './serverNavigationPreference';

const server = (url: string, lastConnectedAt: number, order: number) =>
	({ url, lastConnectedAt, order } as SavedServerView);

describe('desktop Wabi menu server shortcuts', () => {
	test('shows the most recently visited servers without changing the saved list', () => {
		const saved = [server('older', 10, 0), server('newest', 30, 1), server('middle', 20, 2)];
		expect(recentSavedServers(saved, 2).map(({ url }) => url)).toEqual(['newest', 'middle']);
		expect(saved.map(({ url }) => url)).toEqual(['older', 'newest', 'middle']);
	});

	test('preserves saved order for servers visited at the same time', () => {
		const saved = [server('second', 10, 2), server('first', 10, 1)];
		expect(recentSavedServers(saved).map(({ url }) => url)).toEqual(['first', 'second']);
	});
});
