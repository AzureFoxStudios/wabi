import { expect, test } from 'bun:test';
import { namePresetStyle, safeNameStyle } from './nameStyles';

test('unknown and disabled name presets remain plain', () => {
	expect(namePresetStyle('other')).toBe('');
	expect(namePresetStyle('ember', false)).toBe('');
	expect(namePresetStyle('ember')).toContain('background-clip:text');
});

test('stored font values are allowlisted before becoming CSS', () => {
	expect(safeNameStyle({ family: 'Arial', size: '1em', weight: '700', preset: 'mint' })).toContain('font-family:Arial;');
	expect(safeNameStyle({ family: 'Arial', size: '1em', weight: '700', preset: 'mint' }, false)).toBe('');
	expect(safeNameStyle({ family: 'Arial;position:absolute', size: '99em', preset: 'unknown' })).toBe('');
});
