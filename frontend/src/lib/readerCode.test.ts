import { describe, expect, test } from 'bun:test';
import {
	countReaderCodeLines,
	extractReaderFenceLanguages,
	inferReaderCodeLanguage,
	isReaderCodeFile,
	normalizeReaderCodeLanguage,
	readerCodePreview
} from './readerCode';

describe('Reader code helpers', () => {
	test('normalizes common language aliases', () => {
		expect(normalizeReaderCodeLanguage('ts')).toBe('typescript');
		expect(normalizeReaderCodeLanguage('c++')).toBe('cpp');
		expect(normalizeReaderCodeLanguage('language-rs')).toBe('rust');
		expect(normalizeReaderCodeLanguage('tsx')).toBe('tsx');
	});

	test('recognizes source files without classifying normal Reader documents as code', () => {
		expect(isReaderCodeFile('src/module.ts')).toBe(true);
		expect(isReaderCodeFile('main.rs')).toBe(true);
		expect(isReaderCodeFile('Cargo.toml')).toBe(true);
		expect(isReaderCodeFile('README.md')).toBe(false);
		expect(isReaderCodeFile('article.html')).toBe(false);
		expect(isReaderCodeFile('notes.txt')).toBe(false);
	});

	test('infers useful languages from source filenames', () => {
		expect(inferReaderCodeLanguage('component.tsx')).toBe('tsx');
		expect(inferReaderCodeLanguage('include/header.hpp')).toBe('cpp');
		expect(inferReaderCodeLanguage('scripts/run.py')).toBe('python');
		expect(inferReaderCodeLanguage('package.json')).toBe('json');
	});

	test('extracts opening fenced-code languages without counting closing fences', () => {
		const source = [
			'# Example',
			'```ts',
			'const answer = 42;',
			'```',
			'',
			'~~~python',
			'print("hello")',
			'~~~'
		].join('\n');
		expect(extractReaderFenceLanguages(source)).toEqual(['typescript', 'python']);
	});

	test('counts lines without treating a trailing newline as an extra line', () => {
		expect(countReaderCodeLines('one\ntwo\nthree\n')).toBe(3);
		expect(countReaderCodeLines('')).toBe(0);
	});

	test('uses the first useful code line for navigation previews', () => {
		expect(readerCodePreview('\n\n  export function hello() {}\nreturn hello();')).toBe('export function hello() {}');
		expect(readerCodePreview('abcdefghij', 6)).toBe('abcde…');
	});
});
