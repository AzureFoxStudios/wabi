import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Report message (design contract §7.13 dialog, §9 truth words, golden rule 14). Read as text: a
// regression that brings back the private blurred backdrop, raw colours or the server's raw error
// on screen fails here. Styles are compared with comments removed by a loop that repeats one
// pattern until nothing changes (never a single-pass replace).
const source = readFileSync(new URL('./components/ReportMessageDialog.svelte', import.meta.url), 'utf8');
const stripComments = (text: string) => {
	let previous = '';
	let current = text;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
};
const style = stripComments(source.slice(source.indexOf('<style>')));

describe('the report dialog', () => {
	test('is the kit dialog with kit fields and buttons', () => {
		expect(source).toContain('<BaseModal');
		expect(source).toContain('size="sm"');
		expect(source).toContain('<span class="w-field"><select id="report-reason"');
		expect(source).toContain('class="w-btn w-btn--primary"');
		expect(source).not.toContain('class="backdrop"');
	});

	test('a failure is a notice with its own sentence; the server error goes to the console only', () => {
		expect(source).toContain('<Notice title={failure.title} text={failure.text} error={failure.cause} />');
		expect(source).not.toContain('data.error ||');
		expect(source).not.toContain('{error}</div>');
	});

	test('keeps the truthful evidence and audience words; draws only with roles', () => {
		expect(source).toContain('This report preserves evidence');
		expect(source).toContain('Wabi does not send it to a central moderation service.');
		expect(source).toContain('Your report does not automatically punish anyone.');
		expect(style).toContain('color: var(--w-seal);');
		expect(style).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|backdrop-filter|--surface-|--text-|--border-default/i);
	});
});
