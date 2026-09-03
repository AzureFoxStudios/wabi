import { expect, test } from 'bun:test';
import { findReadmePath, isMarkdownPath } from './readmeDefault';

test('finds the canonical root README.md', () => {
	expect(findReadmePath([{ path: 'src/main.rs' }, { path: 'README.md' }])).toBe('README.md');
});

test('case-insensitive, prefers README.md over variants', () => {
	expect(findReadmePath([{ path: 'readme.md' }])).toBe('readme.md');
	expect(findReadmePath([{ path: 'Readme.Markdown' }, { path: 'readme.md' }])).toBe('readme.md');
	expect(findReadmePath([{ path: 'README.md' }, { path: 'readme.md' }])).toBe('README.md');
});

test('ignores folder READMEs and non-readme files', () => {
	expect(findReadmePath([{ path: 'docs/README.md' }, { path: 'main.rs' }])).toBeNull();
	expect(findReadmePath([{ path: 'README.txt' }])).toBeNull();
	expect(findReadmePath([])).toBeNull();
});

test('isMarkdownPath matches md and markdown, case-insensitive', () => {
	expect(isMarkdownPath('README.md')).toBe(true);
	expect(isMarkdownPath('docs/guide.MARKDOWN')).toBe(true);
	expect(isMarkdownPath('src/main.rs')).toBe(false);
	expect(isMarkdownPath('readme.md.bak')).toBe(false);
});
