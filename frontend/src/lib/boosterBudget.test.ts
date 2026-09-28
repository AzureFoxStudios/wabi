import { describe, test, expect } from 'bun:test';
import { BoosterCache, boosterPath, contentHash, CACHE_TTL_MS } from './boosterBudget';
describe('volunteer file cache', () => {
    test('enforces memory quota, entry identity, expiry and revocation', () => {
        let now = 0; const cache = new BoosterCache(8, () => now);
        const file = { path: '/uploads/a.bin', hash: 'a', size: 4 };
        expect(cache.put(file, new ArrayBuffer(5))).toBe(false);
        expect(cache.put(file, new ArrayBuffer(4))).toBe(true);
        cache.put({ ...file, path: '/uploads/b.bin' }, new ArrayBuffer(4));
        cache.put({ ...file, path: '/uploads/c.bin' }, new ArrayBuffer(4));
        expect(cache.get(file)).toBe(null); expect(cache.size).toBe(8);
        expect(cache.get({ ...file, path: '/uploads/c.bin', hash: 'wrong' })).toBe(null);
        cache.retain(['/uploads/c.bin']); expect(cache.size).toBe(4);
        now += CACHE_TTL_MS; expect(cache.files).toEqual([]); expect(cache.size).toBe(0);
    });
    test('only same-server ordinary uploads enter peer routing', () => {
        expect(boosterPath('/uploads/a.bin', 'https://one.test')).toBe('/uploads/a.bin');
        for (const url of ['https://two.test/uploads/a.bin','/uploads/a.bin?token=private','/api/blobs/a','/uploads/a%2Fb','/uploads/../secret']) expect(boosterPath(url, 'https://one.test')).toBe(null);
    });
    test('hash verification detects modified peer payload', async () => {
        const a = new TextEncoder().encode('file').buffer;
        const b = new TextEncoder().encode('evil').buffer;
        expect(await contentHash(a)).not.toBe(await contentHash(b));
        expect((await contentHash(a)).length).toBe(64);
    });
});
