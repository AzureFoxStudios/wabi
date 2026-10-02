import { expect, test } from 'bun:test';
import { renderPaperPattern } from './paperPattern';
function canvas() {
 const calls: string[] = [];
 const ctx = Object.fromEntries(['save','restore','beginPath','arc','fill','moveTo','lineTo','stroke'].map(name => [name, (...args: number[]) => calls.push(`${name}:${args.join(',')}`)])) as unknown as CanvasRenderingContext2D;
 return { ctx, calls };
}
const view = { x: 0, y: 0, zoom: 1 };
test('ruled paper draws only horizontal guides', () => {
 const { ctx, calls } = canvas(); renderPaperPattern(ctx, view, 48, 48, 'lines');
 expect(calls.filter(c => c.startsWith('lineTo:'))).toEqual(['lineTo:48,0','lineTo:48,24']);
 expect(calls.at(-1)).toBe('restore:');
});
test('dots draw points instead of strokes', () => {
 const { ctx, calls } = canvas(); renderPaperPattern(ctx, view, 48, 48, 'dots', true);
 expect(calls.filter(c => c.startsWith('arc:'))).toHaveLength(4);
 expect(calls).not.toContain('stroke:');
 expect(ctx.fillStyle).toBe('rgba(255,255,255,.2)');
});
test('none and zoomed-out guides do no canvas work', () => {
 const { ctx, calls } = canvas(); renderPaperPattern(ctx, view, 48, 48, 'none'); renderPaperPattern(ctx, {...view, zoom: .1}, 48, 48, 'dots'); expect(calls).toHaveLength(0);
});
test('custom guides retain board anchoring and apply spacing, color and opacity', () => {
 const { ctx, calls } = canvas();
 renderPaperPattern(ctx, {...view, x: 8, y: 4}, 80, 80, 'lines', false, {spacing:40, color:'#aabbcc', opacity:.4});
 expect(calls.filter(c => c.startsWith('moveTo:'))).toEqual(['moveTo:0,-4','moveTo:0,36','moveTo:0,76']);
 expect(ctx.strokeStyle).toBe('#aabbcc'); expect(ctx.globalAlpha).toBe(.4);
});
