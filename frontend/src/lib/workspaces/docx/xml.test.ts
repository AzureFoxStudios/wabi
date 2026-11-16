import { expect, test } from 'bun:test';
import { elements, firstElement, parseXml, textOf, XmlError } from './xml';

test('elements, attributes, text and nesting', () => {
	const root = parseXml('<?xml version="1.0"?><w:p w:a="1" b=\'two\'><w:r><w:t>Hi</w:t></w:r><w:r/></w:p>');
	expect(root.name).toBe('w:p');
	expect(root.attrs).toEqual({ 'w:a': '1', b: 'two' });
	expect(elements(root, 'w:r')).toHaveLength(2);
	expect(textOf(root)).toBe('Hi');
	expect(firstElement(root, 'w:r')?.name).toBe('w:r');
});

test('the five entities and numeric references decode, in text and attributes', () => {
	const root = parseXml('<a x="&quot;q&quot; &amp; &#65;"><t>&lt;&gt;&amp;&apos;&#x42;&#x1F600;</t></a>');
	expect(root.attrs.x).toBe('"q" & A');
	expect(textOf(root)).toBe("<>&'B😀");
});

test('comments, processing instructions and CDATA', () => {
	const root = parseXml('<a><!-- gone --><?pi data?><![CDATA[<b> & raw]]>x</a>');
	expect(textOf(root)).toBe('<b> & raw' + 'x');
});

test('a DOCTYPE or an ENTITY declaration is refused: no external entities, no expansion', () => {
	expect(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>')).toThrow(XmlError);
	expect(() => parseXml('<!DOCTYPE a><a/>')).toThrow(XmlError);
	expect(() => parseXml('<a><!ENTITY y "z"></a>')).toThrow(XmlError);
	// an entity that was never declared is also refused rather than passed through
	expect(() => parseXml('<a>&custom;</a>')).toThrow('entity');
});

test('invalid references and malformed documents are refused', () => {
	for (const bad of ['<a>&#xD800;</a>', '<a>&#99999999;</a>', '<a>', '<a></b>', '</a>', '<a b=1/>', '<a b></a>', '<a b="x', '<a><!-- x', '', 'text', '<a/>junk', '<a><![CDATA[x</a>'])
		expect(() => parseXml(bad)).toThrow(XmlError);
});

test('size and depth limits stop abusive files', () => {
	expect(() => parseXml('<a>' + '<b>'.repeat(300) + '</b>'.repeat(300) + '</a>')).toThrow('nested too deeply');
	expect(() => parseXml('<a>' + 'x'.repeat(25 * 1024 * 1024) + '</a>')).toThrow('too large');
});

test('a missing node has no children, so optional parts can be read without checks', () => {
	expect(elements(undefined)).toEqual([]);
	expect(elements(undefined, 'a')).toEqual([]);
	expect(firstElement(undefined, 'a')).toBeUndefined();
});
