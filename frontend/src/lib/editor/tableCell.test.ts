import { describe, expect, test } from 'bun:test';
import { escapeCellPipes } from './tableCell';

describe('escapeCellPipes', () => {
	test('a bare pipe is escaped', () => {
		expect(escapeCellPipes('a|b|c')).toBe('a\\|b\\|c');
	});
	test('an escaped pipe is left alone', () => {
		expect(escapeCellPipes('a\\|b')).toBe('a\\|b');
	});
	test('a pipe after an escaped backslash is still escaped', () => {
		expect(escapeCellPipes('a\\\\|b')).toBe('a\\\\\\|b');
	});
	test('other escapes and a trailing backslash pass through', () => {
		expect(escapeCellPipes('\\*x\\* \\')).toBe('\\*x\\* \\');
	});
});
