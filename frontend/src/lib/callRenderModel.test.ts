import { describe, expect, test } from 'bun:test';
import { mergeScreenShareEntries } from './callRenderModel';

function streamOf(label: string): MediaStream {
	return { __label: label, getTracks: () => [] } as unknown as MediaStream;
}

describe('mergeScreenShareEntries — cross-transport screen tiles', () => {
	test('wabidb screen streams map to stable-owner entries with roster labels', () => {
		const wabidb = new Map([
			['user-2:screen', streamOf('wabidb-2')],
			['user-3:camera', streamOf('cam-3')] // camera keys are not screen tiles
		]);
		const entries = mergeScreenShareEntries(wabidb, [], null, { 'user-2': 'Alice' });
		expect(entries.length).toBe(1);
		expect(entries[0].ownerId).toBe('user-2');
		expect(entries[0].label).toBe("Alice's Screen");
		expect(entries[0].isLocal).toBe(false);
		expect(entries[0].stream).toBe(wabidb.get('user-2:screen'));
	});

	test('P2P shares merge in with raw numeric ids normalized to stable form', () => {
		const p2pStream = streamOf('p2p-3');
		const entries = mergeScreenShareEntries(new Map(), [
			{ userId: '3', username: 'Bob', stream: p2pStream }
		], null);
		expect(entries.length).toBe(1);
		expect(entries[0].ownerId).toBe('user-3');
		expect(entries[0].label).toBe("Bob's Screen");
	});

	test('duplicate owner: the wabidb entry wins over the P2P entry', () => {
		const wabidbStream = streamOf('wabidb-2');
		const entries = mergeScreenShareEntries(
			new Map([['user-2:screen', wabidbStream]]),
			[{ userId: 'user-2', username: 'Alice', stream: streamOf('p2p-2') }],
			null
		);
		expect(entries.length).toBe(1);
		expect(entries[0].stream).toBe(wabidbStream);
	});

	test('local preview becomes a single "Your Screen" tile', () => {
		const local = streamOf('own');
		const entries = mergeScreenShareEntries(new Map(), [], local);
		expect(entries.length).toBe(1);
		expect(entries[0].isLocal).toBe(true);
		expect(entries[0].label).toBe('Your Screen');
		expect(entries[0].ownerId).toBe('local');
	});

	test('no local preview → no local tile', () => {
		expect(mergeScreenShareEntries(new Map(), [], null).length).toBe(0);
	});
});
