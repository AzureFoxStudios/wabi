import { describe, expect, test } from 'bun:test';
import { communityDisplayFont, displayFontStack, DISPLAY_FONTS } from './displayFonts';

describe('community display font', () => {
	test('unknown, empty and default ids keep the theme face', () => {
		expect(displayFontStack(undefined)).toBeNull();
		expect(displayFontStack('')).toBeNull();
		expect(displayFontStack('default')).toBeNull();
		expect(displayFontStack('Comic Sans')).toBeNull();
	});
	test('every non-default entry resolves to a stack', () => {
		for (const font of DISPLAY_FONTS.filter((f) => f.id !== 'default')) expect(displayFontStack(font.id)).toBe(font.stack);
	});
	test('a theme with its own character wins over the community font', () => {
		expect(communityDisplayFont('classic', 'pixel')).toBeNull();
		expect(communityDisplayFont('classic', 'soft')).toContain('Georgia');
	});
});
