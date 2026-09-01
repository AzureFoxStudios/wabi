import type { BoardDocument } from './boardStore';
import type { BoardElement, StrokeElement } from './elementTypes';
import { getSelectionBBox } from './coords';
import { preloadImage, renderLayersWithBlend } from './boardRenderer';
import { sortWhiteboardLayers } from './layers';
import { CODE_CARD_METRICS, CODE_FONT_STACK, TEXT_LINE_HEIGHT_FACTOR } from './textMetrics';
import { CODE_CARD_BG, CODE_CARD_BORDER, CODE_LANGUAGE_TAG_COLOR, highlightCodeLines, tokenColor } from './codeHighlight';

function sanitizeExportBaseName(boardId: string): string {
	const normalized = (boardId || 'whiteboard')
		.replace(/[^a-z0-9]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
	return normalized || 'whiteboard';
}

function downloadBlob(blob: Blob, fileName: string): void {
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = objectUrl;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function waitForImage(img: HTMLImageElement): Promise<void> {
	if (img.complete) return Promise.resolve();
	return new Promise((resolve) => {
		const cleanup = () => {
			img.removeEventListener('load', onLoad);
			img.removeEventListener('error', onError);
		};
		const onLoad = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			resolve();
		};
		img.addEventListener('load', onLoad, { once: true });
		img.addEventListener('error', onError, { once: true });
		setTimeout(() => {
			cleanup();
			resolve();
		}, 5000);
	});
}

async function ensureImagesReady(elements: BoardElement[]): Promise<void> {
	const imageElements = elements.filter((element): element is Extract<BoardElement, { type: 'image' }> => element.type === 'image');
	await Promise.allSettled(imageElements.map((element) => waitForImage(preloadImage(element.src))));
}

function resolveExportBounds(boardDocument: BoardDocument): { x: number; y: number; width: number; height: number } {
	const bbox = getSelectionBBox(boardDocument.elements);
	if (bbox && bbox.width > 0 && bbox.height > 0) {
		return bbox;
	}

	const visibleWidth = Math.max(640, Math.round(1280 / Math.max(boardDocument.viewport.zoom, 0.1)));
	const visibleHeight = Math.max(360, Math.round(720 / Math.max(boardDocument.viewport.zoom, 0.1)));
	return {
		x: boardDocument.viewport.x,
		y: boardDocument.viewport.y,
		width: visibleWidth,
		height: visibleHeight
	};
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error('Failed to serialize whiteboard export.'));
		}, type);
	});
}

export async function exportBoardAsPng(boardDocument: BoardDocument): Promise<void> {
	await ensureImagesReady(boardDocument.elements);

	const bounds = resolveExportBounds(boardDocument);
	const padding = 32;
	const width = Math.max(1, Math.ceil(Math.abs(bounds.width) + padding * 2));
	const height = Math.max(1, Math.ceil(Math.abs(bounds.height) + padding * 2));

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error('Whiteboard export canvas is unavailable.');
	}

	ctx.fillStyle = '#f8fafc';
	ctx.fillRect(0, 0, width, height);
	// Canonical path: per-layer blend modes + per-layer opacity appear in the
	// export, matching the live render loop. The export canvas is sized at full
	// export resolution (no dpr downscaling) and rendered at dpr = 1.
	renderLayersWithBlend(
		ctx,
		boardDocument.elements,
		{
			x: bounds.x - padding,
			y: bounds.y - padding,
			zoom: 1
		},
		boardDocument.layers || [],
		width,
		height,
		1
	);

	const blob = await canvasToBlob(canvas, 'image/png');
	downloadBlob(blob, `${sanitizeExportBaseName(boardDocument.boardId)}.png`);
}

export function exportBoardAsJson(boardDocument: BoardDocument): void {
	const blob = new Blob([JSON.stringify(boardDocument, null, 2)], {
		type: 'application/json'
	});
	downloadBlob(blob, `${sanitizeExportBaseName(boardDocument.boardId)}.json`);
}

// ---------------------------------------------------------------------------
// SVG export (dependency-free, deterministic)
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
	const rounded = Math.round(n * 1000) / 1000;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

interface SvgContext {
	vx: number;
	vy: number;
}

function elementToSvg(el: BoardElement, ctx: SvgContext): string {
	const elType = el.type;
	const dx = (v: number) => v - ctx.vx;
	const dy = (v: number) => v - ctx.vy;
	const attrs: string[] = [];
	if (el.opacity !== undefined && el.opacity < 0.999) {
		attrs.push(`opacity="${fmtNum(el.opacity)}"`);
	}
	const gOpen = attrs.length > 0 ? `<g ${attrs.join(' ')}>` : '';
	const gClose = attrs.length > 0 ? '</g>' : '';

	let body = '';
	switch (el.type) {
		case 'stroke': {
			const s = el as StrokeElement;
			if (s.points.length === 1) {
				const p = s.points[0];
				const r = Math.max(0.5, (s.strokeWidth || 1) / 2);
				body = `<circle cx="${fmtNum(dx(p.x))}" cy="${fmtNum(dy(p.y))}" r="${fmtNum(r)}" fill="${s.strokeColor}"/>`;
			} else {
				const points = s.points.map((p) => `${fmtNum(dx(p.x))},${fmtNum(dy(p.y))}`).join(' ');
				body = `<polyline points="${points}" fill="none" stroke="${s.strokeColor}" stroke-width="${fmtNum(s.strokeWidth || 1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
			}
			break;
		}
		case 'line': {
			body = `<line x1="${fmtNum(dx(el.x))}" y1="${fmtNum(dy(el.y))}" x2="${fmtNum(dx(el.x + el.width))}" y2="${fmtNum(dy(el.y + el.height))}" stroke="${el.strokeColor}" stroke-width="${fmtNum(el.strokeWidth)}" stroke-linecap="round"/>`;
			break;
		}
		case 'rect': {
			const fill = el.fillColor && el.fillColor !== 'transparent' ? el.fillColor : 'none';
			const rx = (el as BoardElement & { borderRadius?: number }).borderRadius || 0;
			body = `<rect x="${fmtNum(dx(el.x))}" y="${fmtNum(dy(el.y))}" width="${fmtNum(el.width)}" height="${fmtNum(el.height)}" rx="${fmtNum(rx)}" fill="${fill}"${el.strokeWidth > 0 ? ` stroke="${el.strokeColor}" stroke-width="${fmtNum(el.strokeWidth)}"` : ''}/>`;
			break;
		}
		case 'ellipse': {
			const fill = el.fillColor && el.fillColor !== 'transparent' ? el.fillColor : 'none';
			body = `<ellipse cx="${fmtNum(dx(el.x + el.width / 2))}" cy="${fmtNum(dy(el.y + el.height / 2))}" rx="${fmtNum(Math.abs(el.width) / 2)}" ry="${fmtNum(Math.abs(el.height) / 2)}" fill="${fill}"${el.strokeWidth > 0 ? ` stroke="${el.strokeColor}" stroke-width="${fmtNum(el.strokeWidth)}"` : ''}/>`;
			break;
		}
		case 'arrow': {
			const x1 = el.x, y1 = el.y;
			const x2 = el.x + el.width, y2 = el.y + el.height;
			const headLen = Math.max(10, el.strokeWidth * 4);
			const angle = Math.atan2(y2 - y1, x2 - x1);
			const parts: string[] = [];
			parts.push(`<line x1="${fmtNum(dx(x1))}" y1="${fmtNum(dy(y1))}" x2="${fmtNum(dx(x2))}" y2="${fmtNum(dy(y2))}" stroke="${el.strokeColor}" stroke-width="${fmtNum(el.strokeWidth)}" stroke-linecap="round"/>`);
			const arrowHead = (el as BoardElement & { arrowHead?: string }).arrowHead || 'end';
			const headAt = (cx: number, cy: number, a: number) => {
				const tip = [cx, cy];
				const b1 = [cx - headLen * Math.cos(a - Math.PI / 6), cy - headLen * Math.sin(a - Math.PI / 6)];
				const b2 = [cx - headLen * Math.cos(a + Math.PI / 6), cy - headLen * Math.sin(a + Math.PI / 6)];
				return `${fmtNum(dx(tip[0]))},${fmtNum(dy(tip[1]))} ${fmtNum(dx(b1[0]))},${fmtNum(dy(b1[1]))} ${fmtNum(dx(b2[0]))},${fmtNum(dy(b2[1]))}`;
			};
			if (arrowHead === 'end' || arrowHead === 'both') {
				parts.push(`<polygon points="${headAt(x2, y2, angle)}" fill="${el.strokeColor}"/>`);
			}
			if (arrowHead === 'both') {
				parts.push(`<polygon points="${headAt(x1, y1, angle + Math.PI)}" fill="${el.strokeColor}"/>`);
			}
			body = parts.join('\n');
			break;
		}
		case 'text': {
			const te = el as BoardElement & { text?: string; fontSize?: number; fontFamily?: string; textAlign?: string };
			const fontSize = te.fontSize || 16;
			const fontFamily = te.fontFamily || 'sans-serif';
			const textAlign = te.textAlign || 'left';
			const anchor = textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start';
			const tx = textAlign === 'center' ? el.x + el.width / 2 : textAlign === 'right' ? el.x + el.width : el.x;
			const lines = (te.text || '').split('\n');
			const lineHeight = fontSize * 1.3;
			const tspans = lines
				.map((line, i) => `<tspan x="${fmtNum(dx(tx))}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
				.join('');
			body = `<text x="${fmtNum(dx(tx))}" y="${fmtNum(dy(el.y))}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" fill="${el.strokeColor}" text-anchor="${anchor}">${tspans}</text>`;
			break;
		}
		case 'code': {
			const ce = el as BoardElement & { code?: string; language?: string; fontSize?: number };
			const fontSize = ce.fontSize || 13;
			const pad = CODE_CARD_METRICS.padding;
			const parts: string[] = [];
			parts.push(`<rect x="${fmtNum(dx(el.x))}" y="${fmtNum(dy(el.y))}" width="${fmtNum(el.width)}" height="${fmtNum(el.height)}" rx="${CODE_CARD_METRICS.borderRadius}" fill="${CODE_CARD_BG}"${el.strokeWidth > 0 ? ` stroke="${CODE_CARD_BORDER}" stroke-width="${fmtNum(el.strokeWidth)}"` : ''}/>`);
			if (ce.language) {
				const tagSize = Math.max(9, Math.round(fontSize * 0.62));
				parts.push(`<text x="${fmtNum(dx(el.x + el.width - pad))}" y="${fmtNum(dy(el.y + Math.round(pad * 0.35)))}" font-family="${escapeXml(CODE_FONT_STACK)}" font-size="${tagSize}" fill="${CODE_LANGUAGE_TAG_COLOR}" text-anchor="end">${escapeXml(ce.language)}</text>`);
			}
			const lines = highlightCodeLines(String(ce.code || ''), String(ce.language || ''));
			const lineHeight = fontSize * TEXT_LINE_HEIGHT_FACTOR;
			const tspans = lines
				.map((line, i) => {
					const runs = line
						.map((run) => `<tspan fill="${tokenColor(run.type)}">${escapeXml(run.text)}</tspan>`)
						.join('');
					return `<text x="${fmtNum(dx(el.x + pad))}" y="${fmtNum(dy(el.y + pad + i * lineHeight))}" font-family="${escapeXml(CODE_FONT_STACK)}" font-size="${fontSize}">${runs}</text>`;
				})
				.join('\n');
			parts.push(tspans);
			body = parts.join('\n');
			break;
		}
		case 'image': {
			const ie = el as BoardElement & { src?: string };
			body = `<!-- image may require auth; href is best-effort -->\n<image href="${escapeXml(ie.src || '')}" x="${fmtNum(dx(el.x))}" y="${fmtNum(dy(el.y))}" width="${fmtNum(el.width)}" height="${fmtNum(el.height)}"/>`;
			break;
		}
		case 'math': {
			const me = el as BoardElement & { latex?: string; fontSize?: number; strokeColor?: string };
			const latex = (me.latex || '').replace(/--/g, '- -');
			const fontSize = fmtNum((me.fontSize || 16) * 0.8);
			const color = me.strokeColor || '#94a3b8';
			body = `<text x="${fmtNum(dx(el.x))}" y="${fmtNum(dy(el.y + (me.fontSize || 16) * 0.8))}" font-size="${fontSize}" fill="${escapeXml(color)}" font-family="serif">${escapeXml(latex)}</text>`;
			break;
		}
		default:
			body = `<!-- unsupported element type: ${elType} -->`;
			break;
	}

	return `${gOpen}${body}${gClose}`;
}

function sortElementsForExport(boardDocument: BoardDocument): BoardElement[] {
	const layerOrder = new Map<string, number>();
	const layerOpacity = new Map<string, number>();
	const visibleLayerIds = new Set<string>();
	for (const layer of sortWhiteboardLayers(boardDocument.layers || [])) {
		layerOrder.set(layer.id, layer.order);
		layerOpacity.set(layer.id, layer.opacity);
		if (layer.visible !== false) visibleLayerIds.add(layer.id);
	}
	return [...boardDocument.elements]
		.filter((el) => {
			if (!el.layerId) return true;
			if (!layerOrder.has(el.layerId)) return true; // orphaned → drawn bottom
			return visibleLayerIds.has(el.layerId);
		})
		.sort((a, b) => {
			const aLayer = layerOrder.get(a.layerId || '') ?? 0;
			const bLayer = layerOrder.get(b.layerId || '') ?? 0;
			if (aLayer !== bLayer) return aLayer - bLayer;
			return a.zIndex - b.zIndex;
		});
}

export function exportBoardAsSvg(boardDocument: BoardDocument): void {
	const bounds = resolveExportBounds(boardDocument);
	const padding = 32;
	const vx = bounds.x - padding;
	const vy = bounds.y - padding;
	const width = Math.max(1, Math.ceil(Math.abs(bounds.width) + padding * 2));
	const height = Math.max(1, Math.ceil(Math.abs(bounds.height) + padding * 2));

	const ctx: SvgContext = { vx, vy };

	const groups: string[] = [];
	const layerOrder = new Map<string, number>();
	const layerOpacity = new Map<string, number>();
	const layers = sortWhiteboardLayers(boardDocument.layers || []);
	for (const layer of layers) {
		layerOrder.set(layer.id, layer.order);
		layerOpacity.set(layer.id, layer.opacity);
	}
	const sorted = sortElementsForExport(boardDocument);

	let currentLayerOrder: number | null = null;
	const closeGroup = () => {
		if (currentLayerOrder !== null) groups.push('</g>');
		currentLayerOrder = null;
	};

	for (const el of sorted) {
		const order = layerOrder.get(el.layerId || '');
		const resolvedOrder = order ?? -1;
		const opacity = order !== undefined ? layerOpacity.get(el.layerId || '') ?? 1 : 1;
		if (resolvedOrder !== currentLayerOrder) {
			closeGroup();
			currentLayerOrder = resolvedOrder;
			if (resolvedOrder !== -1) {
				groups.push(opacity < 0.999 ? `<g opacity="${fmtNum(opacity)}">` : '<g>');
			}
		}
		groups.push(elementToSvg(el, ctx));
	}
	closeGroup();

	const body = groups.join('\n');
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
		`<rect width="${width}" height="${height}" fill="#f8fafc"/>\n` +
		body +
		'\n</svg>';

	const blob = new Blob([svg], { type: 'image/svg+xml' });
	downloadBlob(blob, `${sanitizeExportBaseName(boardDocument.boardId)}.svg`);
}
