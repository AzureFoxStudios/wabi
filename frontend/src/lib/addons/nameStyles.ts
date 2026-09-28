import { profileNamesVisible, setProfileAppearance } from '$lib/profileAppearance';
import { normalizeNameDesign, nameDesignTextStyle, type EditableUsernameFont } from '$lib/profileDesign';

export const NAME_STYLE_PRESETS = [
	{ id: 'none', label: 'Plain' },
	{ id: 'ember', label: 'Ember' },
	{ id: 'ocean', label: 'Ocean' },
	{ id: 'mint', label: 'Mint' },
	{ id: 'violet', label: 'Violet' }
] as const;

const gradients: Record<string, string> = {
	ember: 'linear-gradient(95deg,#e77844,#f6c66a)',
	ocean: 'linear-gradient(95deg,#55b3e8,#93d8ec)',
	mint: 'linear-gradient(95deg,#4ec9a3,#b2df76)',
	violet: 'linear-gradient(95deg,#a777e7,#ea9bd7)'
};

export const nameStylesVisible = profileNamesVisible;

export function setNameStylesVisible(visible: boolean): void {
	setProfileAppearance({ names: visible });
}

/** Declarative, bundled visual values only. Unknown presets stay readable. */
export function namePresetStyle(preset: unknown, visible = true): string {
	if (!visible || typeof preset !== 'string' || !Object.hasOwn(gradients, preset)) return '';
	return `background-image:${gradients[preset]};background-clip:text;-webkit-background-clip:text;color:transparent;`;
}

const allowedFamilies = new Set(['inherit', 'Arial', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New', 'Trebuchet MS', 'Verdana', 'Impact', 'Palatino', 'Helvetica']);
const allowedSizes = new Set(['0.9em', '1em', '1.2em', '1.4em', '16px']);
const allowedWeights = new Set(['400', '500', '600', '700']);
const allowedStyles = new Set(['normal', 'italic']);

export function safeNameStyle(font: EditableUsernameFont | null | undefined, visible = true): string {
	if (!font || !visible) return '';
	let style = '';
	if (font.family && font.family !== 'inherit' && allowedFamilies.has(font.family)) style += `font-family:${font.family};`;
	if (font.size && allowedSizes.has(font.size)) style += `font-size:${font.size};`;
	if (font.weight && allowedWeights.has(font.weight)) style += `font-weight:${font.weight};`;
	if (font.style && allowedStyles.has(font.style)) style += `font-style:${font.style};`;
	const design = normalizeNameDesign(font.design);
	return style + (design ? nameDesignTextStyle(design) : namePresetStyle(font.preset, visible));
}
