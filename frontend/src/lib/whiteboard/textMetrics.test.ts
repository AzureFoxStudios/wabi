import { describe, expect, test } from 'bun:test';
import {
	measureTextLines,
	buildTextElement,
	measureCodeCard,
	buildCodeElement,
	TEXT_LINE_HEIGHT_FACTOR,
	type LineMeasurer
} from './textMetrics';

/** Deterministic stand-in for canvas measureText (bun has no DOM). */
const fakeMeasurer: LineMeasurer = (line, font) => {
	const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] || 16);
	return line.length * size * 0.5;
};

describe('measureTextLines', () => {
	test('width is the widest line, height scales with line count', () => {
		const lines = ['aaaa', 'aaaaaaaaaa', 'cc'];
		const size = measureTextLines(lines, 20, 'sans-serif', fakeMeasurer);
		// 10 chars * 20px * 0.5
		expect(size.width).toBe(100);
		expect(size.height).toBe(3 * 20 * TEXT_LINE_HEIGHT_FACTOR);
	});

	test('empty text gets a minimal box', () => {
		const size = measureTextLines([''], 16, 'sans-serif', fakeMeasurer);
		expect(size.width).toBe(0);
		expect(size.height).toBe(Math.ceil(16 * TEXT_LINE_HEIGHT_FACTOR));
	});
});

describe('buildTextElement', () => {
	test('carries text + font fields and measured box', () => {
		const el = buildTextElement({
			id: 't1', x: 5, y: 6, zIndex: 2, layerId: 'layer-default',
			text: 'hello\nworld!!', fontSize: 10, fontFamily: 'serif', fontId: 'fnt-1',
			strokeColor: '#111111', strokeWidth: 1, fillColor: 'transparent',
			measurer: fakeMeasurer
		});
		expect(el.type).toBe('text');
		expect(el.text).toBe('hello\nworld!!');
		expect(el.fontFamily).toBe('serif');
		expect(el.fontId).toBe('fnt-1');
		// 7 chars * 10 * 0.5 = 35 wide; 2 lines tall
		expect(el.width).toBe(35);
		expect(el.height).toBe(Math.ceil(2 * 10 * TEXT_LINE_HEIGHT_FACTOR));
	});
});

describe('measureCodeCard / buildCodeElement', () => {
	test('card box pads the text box', () => {
		const code = 'aaaa\nbbbbbbbb';
		const size = measureCodeCard(code, 10, fakeMeasurer);
		// widest line: 8 chars * 10 * 0.5 = 40, plus padding on both axes
		expect(size.width).toBe(40 + 24);
		expect(size.height).toBe(Math.ceil(2 * 10 * TEXT_LINE_HEIGHT_FACTOR) + 24);
	});

	test('element carries code + language', () => {
		const el = buildCodeElement({
			id: 'c1', x: 0, y: 0, zIndex: 1, layerId: 'layer-default',
			code: 'let x = 1;', language: 'javascript', fontSize: 13
		});
		expect(el.type).toBe('code');
		expect(el.code).toBe('let x = 1;');
		expect(el.language).toBe('javascript');
		expect(el.width).toBeGreaterThan(0);
		expect(el.height).toBeGreaterThan(0);
	});
});
