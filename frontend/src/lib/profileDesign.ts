/** Portable, declarative cosmetics. Design files contain no identity, URLs or executable CSS. */
import type { NameStyleDesign, UsernameFont } from '../../../packages/wabi-protocol/src/index';
export type { NameStyleDesign };
export type EditableUsernameFont = UsernameFont;

export const DEFAULT_NAME_DESIGN: NameStyleDesign = {
	effect: 'gradient', color: '#A78BFA', color2: '#F0ABFC', angle: 95,
	glow: 0, animationSeconds: 8, plate: 'none',
	plateColor: '#4C1D95', plateColor2: '#831843', plateOpacity: 0.3
};

export const CREATOR_PRESETS = [
	{ id: 'aurora', label: 'Aurora', description: 'A violet and rose gradient.', design: { ...DEFAULT_NAME_DESIGN } },
	{ id: 'ember', label: 'Ember', description: 'Warm lettering with a subtle plate.', design: { ...DEFAULT_NAME_DESIGN, color: '#FBBF24', color2: '#FB7185', plate: 'gradient' as const, plateColor: '#78350F', plateColor2: '#881337' } },
	{ id: 'lagoon', label: 'Lagoon', description: 'Cool colors and an outlined plate.', design: { ...DEFAULT_NAME_DESIGN, color: '#67E8F9', color2: '#86EFAC', plate: 'outline' as const, plateColor: '#06B6D4' } },
	{ id: 'neon', label: 'Neon', description: 'Editable neon glow.', design: { ...DEFAULT_NAME_DESIGN, effect: 'glow' as const, color: '#C4B5FD', glow: 6 } },
	{ id: 'prism', label: 'Prism', description: 'A slow moving gradient.', design: { ...DEFAULT_NAME_DESIGN, effect: 'shimmer' as const, color: '#93C5FD', color2: '#F9A8D4', angle: 115 } }
] as const;

export const NAME_FONT_FAMILIES = ['inherit', 'Arial', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New', 'Trebuchet MS', 'Verdana', 'Impact', 'Palatino', 'Helvetica'] as const;
export const NAME_FONT_SIZES = ['0.9em', '1em', '1.2em', '1.4em'] as const;
export const NAME_FONT_WEIGHTS = ['400', '500', '600', '700'] as const;
export const NAME_FONT_STYLES = ['normal', 'italic'] as const;
export const LEGACY_NAME_PRESETS = ['none', 'ember', 'ocean', 'mint', 'violet'] as const;

export function isDesignColor(value: unknown): value is string {
	return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function bounded(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Invalid incoming definitions render plainly instead of becoming CSS. */
export function normalizeNameDesign(value: unknown): NameStyleDesign | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const d = value as Record<string, unknown>;
	if (typeof d.effect !== 'string' || !['solid', 'gradient', 'glow', 'shimmer'].includes(d.effect) ||
		typeof d.plate !== 'string' || !['none', 'solid', 'gradient', 'outline'].includes(d.plate) ||
		!isDesignColor(d.color) || !isDesignColor(d.color2) ||
		!isDesignColor(d.plateColor) || !isDesignColor(d.plateColor2) ||
		!bounded(d.angle, 0, 360) || !bounded(d.glow, 0, 12) ||
		!bounded(d.animationSeconds, 4, 20) || !bounded(d.plateOpacity, 0, 1)) return null;
	return {
		effect: d.effect as NameStyleDesign['effect'], color: d.color, color2: d.color2,
		angle: d.angle, glow: d.glow, animationSeconds: d.animationSeconds,
		plate: d.plate as NameStyleDesign['plate'], plateColor: d.plateColor,
		plateColor2: d.plateColor2, plateOpacity: d.plateOpacity
	};
}

export function nameDesignTextStyle(d: NameStyleDesign): string {
	const gradient = d.effect === 'gradient' || d.effect === 'shimmer';
	let css = gradient
		? `background-image:linear-gradient(${d.angle}deg,${d.color},${d.color2},${d.color});background-clip:text;-webkit-background-clip:text;color:transparent;`
		: `color:${d.color};`;
	if (d.glow > 0) css += `filter:drop-shadow(0 0 ${d.glow}px ${d.color});`;
	if (d.effect === 'shimmer') css += `--profile-shimmer-seconds:${d.animationSeconds}s;`;
	return css;
}

function rgba(hex: string, opacity: number): string {
	const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
	return `rgba(${rgb.join(',')},${opacity})`;
}

export function nameDesignPlateStyle(d: NameStyleDesign | null): string {
	if (!d || d.plate === 'none') return '';
	if (d.plate === 'outline') return `border:1px solid ${rgba(d.plateColor, d.plateOpacity)};`;
	const first = rgba(d.plateColor, d.plateOpacity);
	return d.plate === 'solid'
		? `background:${first};`
		: `background:linear-gradient(${d.angle}deg,${first},${rgba(d.plateColor2, d.plateOpacity)});`;
}

function portableFont(value: unknown): EditableUsernameFont {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The design needs a name style.');
	const source = value as Record<string, unknown>;
	const result: EditableUsernameFont = {};
	const allowed = { family: NAME_FONT_FAMILIES, size: NAME_FONT_SIZES, weight: NAME_FONT_WEIGHTS, style: NAME_FONT_STYLES, preset: LEGACY_NAME_PRESETS };
	for (const key of Object.keys(allowed) as (keyof typeof allowed)[]) {
		if (source[key] == null) continue;
		if (typeof source[key] !== 'string' || !(allowed[key] as readonly string[]).includes(source[key] as string)) throw new Error(`Unsupported ${key} in this design.`);
		result[key] = source[key] as string;
	}
	if (source.design != null) {
		const design = normalizeNameDesign(source.design);
		if (!design) throw new Error('The design contains an unsupported effect, color or control value.');
		result.design = design;
	}
	if (Object.keys(result).length === 0) throw new Error('This file has no supported name style.');
	return result;
}

export function serializeProfileDesignFile(title: string, font: EditableUsernameFont): string {
	return JSON.stringify({ format: 'wabi-profile-design', version: 1, title: title.trim().slice(0, 80) || 'My Wabi design', usernameFont: portableFont(font) }, null, 2) + '\n';
}

export function parseProfileDesignFile(text: string): { title: string; usernameFont: EditableUsernameFont } {
	if (new TextEncoder().encode(text).length > 16 * 1024) throw new Error('Design files must be 16 KiB or smaller.');
	let source: Record<string, unknown>;
	try { source = JSON.parse(text); } catch { throw new Error('Choose a valid Wabi design JSON file.'); }
	if (!source || source.format !== 'wabi-profile-design' || source.version !== 1) throw new Error('This file is not a supported Wabi profile design (version 1).');
	return { title: typeof source.title === 'string' ? source.title.trim().slice(0, 80) : 'Imported design', usernameFont: portableFont(source.usernameFont) };
}
