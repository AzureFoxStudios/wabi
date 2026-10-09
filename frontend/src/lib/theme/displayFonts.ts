/**
 * Community display font.
 *
 * An operator picks one of these for their community's titles (room names, server name, headings). It is a
 * curated list, not free text: every face is self-hosted or a system stack, because the desktop CSP forbids
 * remote fonts. The value is stored as a plain string (`displayFont`) in the server's JSON branding metadata.
 * A theme with its own typographic character (Joker's pixel type) keeps its own face — the theme wins.
 */

export interface DisplayFont {
	id: string;
	label: string;
	stack: string;
}

export const DISPLAY_FONTS: DisplayFont[] = [
	{ id: 'default', label: 'Wabi serif (default)', stack: '' },
	{
		id: 'classic',
		label: 'Classic serif',
		stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif'
	},
	{
		id: 'sans',
		label: 'Clean sans',
		stack: '"Zen Kaku Gothic New", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
	},
	{
		id: 'mono',
		label: 'Monospace',
		stack: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
	}
];

/** The CSS font stack for a stored id, or null to keep the theme's own title face. */
export function displayFontStack(id: string | null | undefined): string | null {
	const font = DISPLAY_FONTS.find((candidate) => candidate.id === id);
	return font && font.stack ? font.stack : null;
}

/** A community font applies unless the active theme has its own typographic character. */
export function communityDisplayFont(id: string | null | undefined, character: string | undefined): string | null {
	return character === 'pixel' ? null : displayFontStack(id);
}
