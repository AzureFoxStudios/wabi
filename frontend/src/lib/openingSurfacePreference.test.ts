import { expect, test } from 'bun:test';
import { accountPreferenceKey, parseOpeningSurface } from './openingSurfacePreference';
test('startup defaults to the last channel and preserves explicit choices', () => {
 expect(parseOpeningSurface(null)).toBe('last-channel');
 expect(parseOpeningSurface('unknown')).toBe('last-channel');
 expect(parseOpeningSurface('server')).toBe('server');
 expect(parseOpeningSurface('messages')).toBe('messages');
});
test('a saved channel is isolated from other accounts and servers', () => {
 const saved = new Map<string, string>();
 saved.set(accountPreferenceKey('last-channel', 'https://one.example', 12), 'private-channel');
 expect(saved.get(accountPreferenceKey('last-channel', 'https://two.example', 12))).toBeUndefined();
 expect(saved.get(accountPreferenceKey('last-channel', 'https://one.example', 13))).toBeUndefined();
 expect(saved.get(accountPreferenceKey('opening-surface', 'https://one.example', 12))).toBeUndefined();
 expect(saved.get(accountPreferenceKey('last-channel', 'https://one.example', 12))).toBe('private-channel');
});
