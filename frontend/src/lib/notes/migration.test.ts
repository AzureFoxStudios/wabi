import { describe, test, expect } from 'bun:test';
import { previewLegacyNotes, legacyNotesFingerprint } from './migration';

describe('legacy note recovery preview', () => {
	test('keeps exact original bytes and recovers valid rows from partial corruption', () => {
		const raw = String.raw` [ {"text":"# First\nBody","createdAt":123}, null, {"text":42}, {"text":""} ] `;
		const preview = previewLegacyNotes('wabi:keep-notes:v1:3', raw);
		expect(preview.raw).toBe(raw);
		expect(preview.rows.map(row => row.text)).toEqual(['# First\nBody', '']);
		expect(preview.rows[0].title).toBe('First');
		expect(preview.issues).toHaveLength(2);
	});
	test('wrong containers and broken JSON are visible recovery issues', () => {
		for (const raw of ['{}', 'null', '"text"', '{']) {
			const preview = previewLegacyNotes('wabi:keep-notes:v1:anon', raw);
			expect(preview.rows).toHaveLength(0);
			expect(preview.issues.length).toBeGreaterThan(0);
			expect(preview.raw).toBe(raw);
		}
	});
	test('conversation ownership is not inferred from matching numbers', () => {
		const row = previewLegacyNotes('wabi:dm-notes:v1:1:1', '[{"text":"personal"}]').rows[0];
		expect(row).not.toHaveProperty('contextChannelId');
		expect(row).not.toHaveProperty('scopeId');
	});
	test('scratchpad text stays exact and profile annotations remain separate', () => {
		expect(previewLegacyNotes('wabi:quick-scratchpad:v1:anon', '"  hello\\n"').rows[0].text).toBe('  hello\n');
		expect(previewLegacyNotes('wabi.userNotes.byUserId', '{"1":"annotation"}').rows).toHaveLength(0);
	});
	test('source identity includes the key as well as exact bytes', async () => {
		const first = await legacyNotesFingerprint('one', '[]');
		expect(await legacyNotesFingerprint('one', '[]')).toBe(first);
		expect(await legacyNotesFingerprint('two', '[]')).not.toBe(first);
		expect(await legacyNotesFingerprint('one', ' []')).not.toBe(first);
	});
});
