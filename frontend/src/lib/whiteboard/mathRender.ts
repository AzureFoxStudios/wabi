import katex from 'katex';
import katexCss from 'katex/dist/katex.min.css?raw';
import KaTeX_AMS_Regular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?url';
import KaTeX_Caligraphic_Bold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?url';
import KaTeX_Caligraphic_Regular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?url';
import KaTeX_Fraktur_Bold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?url';
import KaTeX_Fraktur_Regular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?url';
import KaTeX_Main_BoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?url';
import KaTeX_Main_Bold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?url';
import KaTeX_Main_Italic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?url';
import KaTeX_Main_Regular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import KaTeX_Math_BoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?url';
import KaTeX_Math_Italic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?url';
import KaTeX_SansSerif_Bold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?url';
import KaTeX_SansSerif_Italic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?url';
import KaTeX_SansSerif_Regular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?url';
import KaTeX_Script_Regular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?url';
import KaTeX_Size1_Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?url';
import KaTeX_Size2_Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?url';
import KaTeX_Size3_Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?url';
import KaTeX_Size4_Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?url';
import KaTeX_Typewriter_Regular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?url';
import { boardStore } from './boardStore';

// ---------------------------------------------------------------------------
// KaTeX → canvas bridge for whiteboard math elements.
//
// KaTeX's renderToString has no native `output: 'svg'` mode (0.18.x supports
// only html/mathml/htmlAndMathml), so we serialize the HTML output into a
// standalone SVG via a <foreignObject>, embedding:
//   - the KaTeX stylesheet (imported as text) in a <style> node, and
//   - the KaTeX web fonts as bundled asset URLs (rewritten @font-face).
// The SVG is loaded into an <img> from a data: URL and drawn with drawImage.
//
// Width/height come from measuring the rendered HTML in a hidden host div, so
// element bboxes (selection, hit-testing, export) match what's drawn.
// ---------------------------------------------------------------------------

/** Extra px of padding around the math glyph (avoids sub-pixel clipping). */
const GLYPH_PAD = 2;
const CACHE_LIMIT = 50;
const FALLBACK_ASPECT = 0.5;
const FALLBACK_HEIGHT_MULT = 1.4;
const PRELOAD_COLOR = '#000000';

const FONT_URLS: Record<string, string> = {
	'KaTeX_AMS-Regular': KaTeX_AMS_Regular,
	'KaTeX_Caligraphic-Bold': KaTeX_Caligraphic_Bold,
	'KaTeX_Caligraphic-Regular': KaTeX_Caligraphic_Regular,
	'KaTeX_Fraktur-Bold': KaTeX_Fraktur_Bold,
	'KaTeX_Fraktur-Regular': KaTeX_Fraktur_Regular,
	'KaTeX_Main-BoldItalic': KaTeX_Main_BoldItalic,
	'KaTeX_Main-Bold': KaTeX_Main_Bold,
	'KaTeX_Main-Italic': KaTeX_Main_Italic,
	'KaTeX_Main-Regular': KaTeX_Main_Regular,
	'KaTeX_Math-BoldItalic': KaTeX_Math_BoldItalic,
	'KaTeX_Math-Italic': KaTeX_Math_Italic,
	'KaTeX_SansSerif-Bold': KaTeX_SansSerif_Bold,
	'KaTeX_SansSerif-Italic': KaTeX_SansSerif_Italic,
	'KaTeX_SansSerif-Regular': KaTeX_SansSerif_Regular,
	'KaTeX_Script-Regular': KaTeX_Script_Regular,
	'KaTeX_Size1-Regular': KaTeX_Size1_Regular,
	'KaTeX_Size2-Regular': KaTeX_Size2_Regular,
	'KaTeX_Size3-Regular': KaTeX_Size3_Regular,
	'KaTeX_Size4-Regular': KaTeX_Size4_Regular,
	'KaTeX_Typewriter-Regular': KaTeX_Typewriter_Regular
};

/**
 * KaTeX stylesheet with @font-face URLs rewritten to Vite-bundled asset URLs
 * (all three formats collapse to the woff2 build), XML-escaped so it is safe
 * to embed inside an SVG <style> node. Computed once at module load.
 */
const KATEX_CSS = (() => {
	const rewritten = katexCss.replace(/url\(fonts\/([^)]+)\)/g, (_match, name: string) => {
		const base = name.replace(/\.(woff2|woff|ttf)$/, '');
		const url = FONT_URLS[base];
		return url ? `url(${url})` : _match;
	});
	return rewritten.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
})();

interface RenderInfo {
	/** KaTeX HTML output (output: 'html'). */
	html: string;
	/** Measured rendered size in px (including GLYPH_PAD), at `fontSize`. */
	width: number;
	height: number;
	/** True when KaTeX reported a parse error (fallback text rendering). */
	hasError: boolean;
}

/** Raw KaTeX output keyed by `latex\0fontSize`. Producing it (parse + layout
 *  measure) is the expensive part; it is color-neutral, so any color can be
 *  injected without re-doing it. */
const renderInfoCache = new Map<string, RenderInfo>();

/** Loaded <img> elements keyed by `latex\0fontSize\0color`. Color is baked
 *  into the SVG (CSS `color`), so distinct colors need distinct images. */
const imageCache = new Map<string, HTMLImageElement>();

let measureHost: HTMLDivElement | null = null;

function cacheKey(parts: Array<string | number>): string {
	return parts.join('\u0000');
}

function trimCache<K, V>(cache: Map<K, V>): void {
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) return;
		cache.delete(oldest);
	}
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getMeasureHost(): HTMLDivElement {
	if (!measureHost) {
		measureHost = document.createElement('div');
		measureHost.style.cssText =
			'position:fixed;left:-9999px;top:0;width:auto;height:auto;visibility:hidden;pointer-events:none;';
		document.body.appendChild(measureHost);
	}
	return measureHost;
}

function renderHtml(latex: string): { html: string; hasError: boolean } {
	let html: string;
	try {
		html = katex.renderToString(latex, {
			displayMode: false,
			output: 'html',
			throwOnError: false,
			strict: 'ignore'
		});
	} catch {
		return { html: '', hasError: true };
	}
	const hasError = /class="katex-error"/.test(html);
	return { html, hasError };
}

/** Measure the rendered KaTeX HTML at the target font size (px). */
function measureHtml(html: string, fontSize: number): { width: number; height: number } | null {
	const host = getMeasureHost();
	host.style.fontSize = `${fontSize}px`;
	host.innerHTML = html;
	const rect = host.getBoundingClientRect();
	if (rect.width > 0 && rect.height > 0) {
		return {
			width: Math.ceil(rect.width + GLYPH_PAD * 2),
			height: Math.ceil(rect.height + GLYPH_PAD * 2)
		};
	}
	return null;
}

function getRenderInfo(latex: string, fontSize: number): RenderInfo | null {
	const key = cacheKey([latex, fontSize]);
	const cached = renderInfoCache.get(key);
	if (cached) return cached;

	const { html, hasError } = renderHtml(latex);
	let info: RenderInfo | null = null;
	if (html) {
		const size = hasError ? null : measureHtml(html, fontSize);
		info = {
			html,
			hasError,
			width: size ? size.width : 0,
			height: size ? size.height : 0
		};
	}
	if (info) {
		renderInfoCache.set(key, info);
		trimCache(renderInfoCache);
	}
	return info;
}

/** Build a standalone, self-contained SVG embedding the KaTeX HTML output. */
function buildSvg(html: string, width: number, height: number, fontSize: number, color: string): string {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" width="' +
		w +
		'" height="' +
		h +
		'" viewBox="0 0 ' +
		w +
		' ' +
		h +
		'">' +
		'<style>' +
		KATEX_CSS +
		'</style>' +
		'<foreignObject x="0" y="0" width="' +
		w +
		'" height="' +
		h +
		'">' +
		'<div xmlns="http://www.w3.org/1999/xhtml" style="color:' +
		escapeAttr(color) +
		';display:inline-block;font-size:' +
		fontSize +
		'px;margin:' +
		GLYPH_PAD +
		'px;">' +
		html +
		'</div>' +
		'</foreignObject>' +
		'</svg>'
	);
}

function getImage(latex: string, fontSize: number, color: string): HTMLImageElement | null {
	const key = cacheKey([latex, fontSize, color]);
	const cached = imageCache.get(key);
	if (cached) return cached;

	const info = getRenderInfo(latex, fontSize);
	if (!info || info.hasError) return null;

	const svg = buildSvg(info.html, info.width, info.height, fontSize, color);
	const img = new Image();
	// The <img> decodes asynchronously (even for data: URLs); re-request a
	// canvas render once it's ready so the first frame never sticks on the
	// monospace fallback.
	img.onload = () => boardStore.bumpVersion();
	img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	imageCache.set(key, img);
	trimCache(imageCache);
	return img;
}

function drawFallback(
	ctx: CanvasRenderingContext2D,
	latex: string,
	x: number,
	y: number,
	fontSize: number,
	color: string
): void {
	ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
	ctx.fillStyle = color;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';
	ctx.fillText(latex, x, y);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Draw a math element's LaTeX onto a canvas context. `opacity` is multiplied
 * into the context's current globalAlpha (the caller pre-applies element/layer
 * alpha via ctx.globalAlpha; passing element.opacity here composes correctly).
 * Falls back to monospace LaTeX text when KaTeX cannot render the input.
 */
export function renderMathToCanvas(
	ctx: CanvasRenderingContext2D,
	latex: string,
	x: number,
	y: number,
	fontSize: number,
	color: string,
	opacity: number
): void {
	const trimmed = (latex || '').trim();
	if (!trimmed || fontSize <= 0) return;

	const prevAlpha = ctx.globalAlpha;
	ctx.globalAlpha = Math.max(0, Math.min(1, prevAlpha * opacity));

	const img = getImage(trimmed, fontSize, color);
	if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
		ctx.drawImage(img, x, y, img.naturalWidth, img.naturalHeight);
	} else {
		drawFallback(ctx, trimmed, x, y, fontSize, color);
	}

	ctx.globalAlpha = prevAlpha;
}

/**
 * Synchronous estimate of the rendered size of a math element at `fontSize`.
 * Uses the measured KaTeX output when available; otherwise falls back to a
 * rough text-based estimate. Keeps element x/y/width/height correct for
 * hit-testing, selection and export.
 */
export function measureMathElement(latex: string, fontSize: number): { width: number; height: number } {
	const trimmed = (latex || '').trim();
	if (!trimmed) return { width: 0, height: fontSize * FALLBACK_HEIGHT_MULT };

	const info = getRenderInfo(trimmed, fontSize);
	if (info && !info.hasError && info.width > 0 && info.height > 0) {
		return { width: info.width, height: info.height };
	}
	return {
		width: trimmed.length * fontSize * FALLBACK_ASPECT,
		height: fontSize * FALLBACK_HEIGHT_MULT
	};
}

/**
 * Warm the render + image caches for a formula so the next draw/measure is
 * instant. Call after committing a math element.
 */
export function preloadMathElement(latex: string, fontSize: number): void {
	const trimmed = (latex || '').trim();
	if (!trimmed || fontSize <= 0) return;
	getRenderInfo(trimmed, fontSize);
	getImage(trimmed, fontSize, PRELOAD_COLOR);
}
