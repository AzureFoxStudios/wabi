/**
 * parseMessage(..., { remoteImages: false }) for messages under experimental encryption: images
 * written in the message text become links (imagesToLinks) before sanitizing. DOMPurify needs a
 * DOM, so this drives the rewrite on marked's real output; parseMessage applies it right after
 * marked.parse and before the emote pass.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { imagesToLinks } from './markdown';

describe('imagesToLinks (experimental encryption)', () => {
	test('a markdown image becomes a link, so its host is not contacted', () => {
		const html = imagesToLinks(String(marked.parse('look ![cat](https://img.example.net/cat.png?a=1&b=2)', { async: false })));
		expect(html).not.toContain('<img');
		expect(html).toContain('href="https://img.example.net/cat.png?a=1&amp;b=2"');
		expect(html).toContain('cat (image)</a>');
	});

	test('raw <img> in the text is rewritten, with its handlers dropped', () => {
		const html = imagesToLinks(String(marked.parse("<img src='https://t.example.net/p.gif' onerror=\"alert(1)\">", { async: false })));
		expect(html).not.toContain('<img');
		expect(html).not.toContain('onerror');
		expect(html).toContain('href="https://t.example.net/p.gif"');
	});

	test('an image without a source keeps only its alt text', () => {
		expect(imagesToLinks('<img alt="x">')).toBe('x');
	});

	test('parseMessage applies it only when asked, before custom emoji are inserted', () => {
		const source = readFileSync(new URL('./markdown.ts', import.meta.url), 'utf8');
		const rewrite = source.indexOf('if (!remoteImages) html = imagesToLinks(html);');
		expect(rewrite).toBeGreaterThan(source.indexOf('marked.parse(text'));
		expect(rewrite).toBeLessThan(source.indexOf('// Replace emote codes with images'));
		expect(source).toContain("${remoteImages ? 'img' : 'noimg'}");
	});
});
