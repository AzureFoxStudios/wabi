import { describe, expect, test, afterAll } from 'bun:test';
import { loadChatBackdropSettings } from './chatBackdrop';
const original = globalThis.localStorage;
let saved: string | null = null;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => saved } });
afterAll(() => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original }));
describe('chat scene preferences', () => {
 test('keeps an existing uploaded image visible until a scene is selected', () => { saved = null; expect(loadChatBackdropSettings(true).scene).toBe('image'); expect(loadChatBackdropSettings(false).scene).toBe('none'); });
 test('explicit none wins over an uploaded image', () => { saved = JSON.stringify({scene:'none',version:2}); expect(loadChatBackdropSettings(true).scene).toBe('none'); });
 test('restores image and koi choices without changing their controls', () => { for (const scene of ['image','koi'] as const) { saved=JSON.stringify({scene,motion:.5,dim:.2,frost:.3}); expect(loadChatBackdropSettings().scene).toBe(scene); expect(loadChatBackdropSettings().motion).toBe(.5); } });
 test('migrates a legacy image plus None without hiding the image', () => { saved=JSON.stringify({scene:'none'}); expect(loadChatBackdropSettings(true).scene).toBe('image'); });
 test('rejects invalid values', () => { saved=JSON.stringify({scene:'unknown',motion:4,dim:-1,frost:'bad'}); expect(loadChatBackdropSettings()).toEqual({scene:'none',motion:1,dim:0,frost:.32}); });
});
