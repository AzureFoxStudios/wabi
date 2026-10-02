import { describe, expect, test } from 'bun:test';
import { normalizeWhiteboardLayer } from './layers';
import { layerAllowsNewContent, layerAllowsUpdate } from './layerEditingLocks';
const layer = normalizeWhiteboardLayer({ id: 'paint', mode: 'raster' }, 0)!;
describe('layer editing locks', () => {
 test('old documents remain editable', () => { expect(layerAllowsNewContent(layer)).toBe(true); expect(layerAllowsUpdate(layer, { x: 10 })).toBe(true); });
 test('position lock permits styling but rejects transforms', () => { const locked = {...layer, lockPosition: true}; expect(layerAllowsUpdate(locked, { strokeColor: '#ffffff' })).toBe(true); expect(layerAllowsUpdate(locked, { x: 10 })).toBe(false); expect(layerAllowsUpdate(locked, { points: [] })).toBe(false); });
 test('content lock permits transforms but rejects drawing and styling', () => { const locked = {...layer, lockPixels: true}; expect(layerAllowsNewContent(locked)).toBe(false); expect(layerAllowsUpdate(locked, { x: 10, points: [] })).toBe(true); expect(layerAllowsUpdate(locked, { strokeColor: '#ffffff' })).toBe(false); });
 test('normalization retains strict boolean lock flags', () => { const normalized = normalizeWhiteboardLayer({...layer, lockAlpha: true, lockPosition: true, lockPixels: true},0)!; expect(normalized.lockAlpha).toBe(true); expect(normalized.lockPosition).toBe(true); expect(normalized.lockPixels).toBe(true); expect(layerAllowsUpdate({...normalized,locked:true},{x:1})).toBe(false); });
});
