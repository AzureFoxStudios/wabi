import { test, expect } from 'bun:test';
import { sketchfabSource, modelLinkError } from './modelSource';
const id = '2cffad40b3e6410f8ac362733bb4852b';
test('Sketchfab page and embed URLs converge on the trusted viewer', () => {
 for (const url of [`https://sketchfab.com/3d-models/rafale-${id}`, `https://sketchfab.com/models/${id}/embed`]) expect(sketchfabSource(url)?.embedUrl).toBe(`https://sketchfab.com/models/${id}/embed`);
});
test('untrusted host, credentials and injected paths are never embedded', () => {
 for (const url of [`https://sketchfab.com.evil.test/models/${id}`, `https://user@sketchfab.com/models/${id}`, `javascript:alert(1)`, `https://sketchfab.com/models/${id}/anything`]) expect(sketchfabSource(url)).toBeNull();
});
test('direct files work and ordinary pages receive actionable guidance', () => {
 expect(modelLinkError('https://example.com/model.glb?download=1')).toBeNull();
 expect(modelLinkError('https://example.com/gallery')).toContain('webpage');
 expect(modelLinkError('https://skfb.ly/pO7DO')).toContain('full model page');
});
