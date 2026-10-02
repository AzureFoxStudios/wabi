import type { WhiteboardViewport } from './boardTypes';

/** View-only paper guides, anchored to board coordinates while panning. */
export function renderPaperPattern(ctx: CanvasRenderingContext2D, viewport: WhiteboardViewport, width: number, height: number, pattern: string, dark = false, options: { spacing?: number; color?: string; opacity?: number } = {}): void {
	const spacing = Math.max(8, Math.min(160, options.spacing || 24)) * viewport.zoom;
	if (pattern === 'none' || spacing < 6) return;
	const x0 = -(viewport.x * viewport.zoom) % spacing;
	const y0 = -(viewport.y * viewport.zoom) % spacing;
	ctx.save();
	ctx.strokeStyle = dark ? 'rgba(255,255,255,.2)' : 'rgba(30,41,59,.18)';
	ctx.fillStyle = ctx.strokeStyle;
	ctx.lineWidth = 1;
	if (options.color && /^#[0-9a-f]{6}$/i.test(options.color)) { ctx.strokeStyle = options.color; ctx.fillStyle = options.color; }
	ctx.globalAlpha = Math.max(0, Math.min(1, options.opacity ?? 1));
	if (pattern === 'dots') {
		for (let x = x0; x < width; x += spacing) for (let y = y0; y < height; y += spacing) { ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill(); }
	} else {
		ctx.beginPath();
		if (pattern === 'grid') for (let x = x0; x < width; x += spacing) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
		for (let y = y0; y < height; y += spacing) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
		ctx.stroke();
	}
	ctx.restore();
}
