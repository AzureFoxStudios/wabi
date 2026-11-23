import { expect, test } from 'bun:test';
import { requestPersistence, savedPrivatelyMessage } from './persistentStorage';

test('already persistent storage is kept without asking again', async () => {
	let asked = false;
	expect(await requestPersistence({ persisted: async () => true, persist: async () => { asked = true; return true; } })).toBe('kept');
	expect(asked).toBe(false);
});

test('asks once when not yet persistent, and reports the answer honestly', async () => {
	expect(await requestPersistence({ persisted: async () => false, persist: async () => true })).toBe('kept');
	expect(await requestPersistence({ persisted: async () => false, persist: async () => false })).toBe('not-guaranteed');
	expect(await requestPersistence({ persist: async () => true })).toBe('kept');
});

test('a browser without the API, or one that throws, is unknown, never an error', async () => {
	expect(await requestPersistence(null)).toBe('unknown');
	expect(await requestPersistence({})).toBe('unknown');
	expect(await requestPersistence({ persist: async () => { throw new Error('denied'); } })).toBe('unknown');
});

test('the message never claims more than was learned', () => {
	expect(savedPrivatelyMessage('kept')).toContain('agreed to keep it');
	expect(savedPrivatelyMessage('not-guaranteed')).toContain('may clear it');
	expect(savedPrivatelyMessage('unknown')).not.toContain('agreed');
	for (const result of ['kept', 'not-guaranteed', 'unknown'] as const) expect(savedPrivatelyMessage(result).startsWith('Saved in this browser on this device only.')).toBe(true);
});
