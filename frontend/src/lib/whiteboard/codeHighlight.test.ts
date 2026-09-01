import { describe, expect, test } from 'bun:test';
import { highlightCodeLines, normalizeCodeLanguage, tokenColor, CODE_TEXT_COLOR } from './codeHighlight';

describe('normalizeCodeLanguage', () => {
	test('maps aliases', () => {
		expect(normalizeCodeLanguage('ts')).toBe('typescript');
		expect(normalizeCodeLanguage('py')).toBe('python');
		expect(normalizeCodeLanguage('sh')).toBe('bash');
		expect(normalizeCodeLanguage('golang')).toBe('go');
	});

	test('passes registered names through', () => {
		expect(normalizeCodeLanguage('rust')).toBe('rust');
		expect(normalizeCodeLanguage('Rust')).toBe('rust');
	});

	test('unknown languages resolve to empty (plain rendering)', () => {
		expect(normalizeCodeLanguage('cobol')).toBe('');
		expect(normalizeCodeLanguage('')).toBe('');
	});
});

describe('highlightCodeLines', () => {
	test('lines reassemble to the original text', () => {
		const code = 'fn main() {\n    let x = 1;\n}\n';
		const lines = highlightCodeLines(code, 'rust');
		// A trailing newline yields a trailing empty line, so join('') round-trips.
		expect(lines.map((line) => line.map((run) => run.text).join('')).join('\n')).toBe(code);
	});

	test('multi-line strings and comments split into separate lines', () => {
		const code = '// comment\nlet x = 1;';
		const lines = highlightCodeLines(code, 'rust');
		expect(lines.length).toBe(2);
		expect(lines[0].some((run) => run.type === 'comment')).toBe(true);
	});

	test('unknown language renders plain runs', () => {
		const lines = highlightCodeLines('dim x as integer', 'vb6');
		expect(lines.length).toBe(1);
		expect(lines[0]).toEqual([{ text: 'dim x as integer', type: '' }]);
	});

	test('tokenized keywords get a non-plain type', () => {
		const lines = highlightCodeLines('let x = 1;', 'rust');
		expect(lines[0].some((run) => run.type !== '')).toBe(true);
	});

	test('cache returns identical structure for repeated input', () => {
		const first = highlightCodeLines('const a = 1;', 'javascript');
		const second = highlightCodeLines('const a = 1;', 'javascript');
		expect(second).toBe(first);
	});
});

describe('tokenColor', () => {
	test('every produced run type maps to a color', () => {
		const lines = highlightCodeLines('fn main() { /* x */ let s = "hi"; }', 'rust');
		for (const line of lines) {
			for (const run of line) {
				expect(tokenColor(run.type)).toMatch(/^#[0-9a-f]{6}$/i);
			}
		}
	});

	test('unknown types fall back to plain text color', () => {
		expect(tokenColor('definitely-not-a-type')).toBe(CODE_TEXT_COLOR);
	});
});
