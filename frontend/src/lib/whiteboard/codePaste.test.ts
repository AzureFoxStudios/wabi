import { describe, expect, test } from 'bun:test';
import {
	looksLikeCode,
	detectLanguage,
	planPaste,
	suggestPasteLayerName,
	stripDangerousClipboardText,
	MAX_CODE_PASTE_CHARS
} from './codePaste';

const RUST_SNIPPET = `fn main() {
    let mut count = 0;
    for i in 0..10 {
        count += i;
    }
    println!("{}", count);
}`;

const JS_SNIPPET = `import { thing } from './mod';

export function run(input) {
  const out = input.map((x) => x * 2);
  return out;
}`;

const PY_SNIPPET = `def add(a, b):
    return a + b

class Greeter:
    def greet(self, name):
        print(f"hello {name}")`;

const PROSE = `This is just a normal paragraph of text that someone might paste.
It has sentences, commas, and no structure that looks like code at all.
The quick brown fox jumps over the lazy dog again and again here.`;

describe('looksLikeCode', () => {
	test('detects rust', () => {
		const result = looksLikeCode(RUST_SNIPPET);
		expect(result.isCode).toBe(true);
		expect(result.language).toBe('rust');
	});

	test('detects javascript', () => {
		const result = looksLikeCode(JS_SNIPPET);
		expect(result.isCode).toBe(true);
		expect(['javascript', 'typescript']).toContain(result.language);
	});

	test('detects python', () => {
		const result = looksLikeCode(PY_SNIPPET);
		expect(result.isCode).toBe(true);
		expect(result.language).toBe('python');
	});

	test('prose is not code', () => {
		expect(looksLikeCode(PROSE).isCode).toBe(false);
	});

	test('single word is not code', () => {
		expect(looksLikeCode('hello').isCode).toBe(false);
	});

	test('empty input is not code', () => {
		expect(looksLikeCode('').isCode).toBe(false);
		expect(looksLikeCode('   \n  ').isCode).toBe(false);
	});

	test('raw JSON object is code', () => {
		const json = '{"name": "wabi", "version": 2, "layers": [], "elements": []}';
		expect(looksLikeCode(json).isCode).toBe(true);
	});
});

describe('detectLanguage', () => {
	test('empty when nothing matches twice', () => {
		expect(detectLanguage('just some words here')).toBe('');
	});

	test('shebang implies bash', () => {
		expect(detectLanguage('#!/bin/bash\necho hi\n')).toBe('bash');
	});
});

describe('planPaste', () => {
	test('code plan carries language', () => {
		const { plan } = planPaste(RUST_SNIPPET);
		expect(plan).toEqual({ kind: 'code', language: 'rust' });
	});

	test('text plan for prose', () => {
		const { plan } = planPaste(PROSE);
		expect(plan).toEqual({ kind: 'text' });
	});

	test('empty clipboard is a no-op plan', () => {
		expect(planPaste('   ').plan).toBeNull();
	});

	test('oversized paste is rejected with an error', () => {
		const big = 'fn main() {\n' + '    let x = 1;\n'.repeat(12000) + '}';
		const { plan, error } = planPaste(big);
		expect(plan).toBeNull();
		expect(error).toContain('too large');
		expect(big.length).toBeGreaterThan(MAX_CODE_PASTE_CHARS);
	});

	test('crlf is normalized', () => {
		const { plan } = planPaste('let x = 1;\r\nlet y = 2;\r\n');
		expect(plan?.kind).toBe('code');
	});
});

describe('suggestPasteLayerName', () => {
	test('code layer names include the language', () => {
		expect(suggestPasteLayerName({ kind: 'code', language: 'rust' }, 1)).toBe('Code — rust');
	});

	test('unknown language falls back to plain code label', () => {
		expect(suggestPasteLayerName({ kind: 'code', language: '' }, 1)).toBe('Code — code');
	});

	test('text layer names are numbered', () => {
		expect(suggestPasteLayerName({ kind: 'text' }, 3)).toBe('Text 3');
	});
});

describe('stripDangerousClipboardText', () => {
	test('removes zero-width and bidi control characters', () => {
		const dirty = 'hello\u200Bworld\u202Eevil\ttab\nline';
		expect(stripDangerousClipboardText(dirty)).toBe('helloworldevil\ttab\nline');
	});

	test('keeps normal text intact', () => {
		expect(stripDangerousClipboardText('fn main() {}')).toBe('fn main() {}');
	});
});
