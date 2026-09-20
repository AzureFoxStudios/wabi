import { describe, expect, test } from 'bun:test';
import { buildTheme } from './buildTokens';
import { ALL_PALETTES } from './palettes';

function luminance(hex: string): number {
	const rgb = hex.replace('#', '').match(/.{2}/g)!.map(value => parseInt(value, 16) / 255);
	return rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
		.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

describe('solid accent text readability', () => {
	for (const palette of ALL_PALETTES) {
		test(`${palette.name} primary controls meet normal-text contrast`, () => {
			const { colors } = buildTheme(palette);
			const levels = [luminance(colors.accentHex), luminance(colors.textOnAccent)].sort((a, b) => a - b);
			expect((levels[1] + 0.05) / (levels[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
		});
	}
});
