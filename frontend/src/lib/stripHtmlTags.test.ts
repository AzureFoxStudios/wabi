import { describe, expect, test } from 'bun:test';
import { stripHtmlTags } from './stripHtmlTags';

describe('stripHtmlTags', () => {
	test('removes ordinary tags and keeps text', () => {
		expect(stripHtmlTags('a <b>bold</b> word')).toBe('a bold word');
	});

	test('removes a tag that only forms after an inner tag is removed', () => {
		expect(stripHtmlTags('<scr<b>ipt>alert(1)</scr<b>ipt>')).not.toContain('<script');
		expect(stripHtmlTags('<<b>script>x')).not.toContain('<script');
	});

	test('leaves a lone angle bracket alone', () => {
		expect(stripHtmlTags('1 < 2')).toBe('1 < 2');
	});
});
