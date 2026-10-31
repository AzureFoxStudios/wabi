/**
 * Source contracts for the wave-1 dialogs: every remaining dialog sits on the BaseModal kit frame,
 * close buttons are labelled, the login says "Sign in", never echoes its labels as placeholders and
 * never offers "mesh" (design contract §7.13, §8.9, §9.6; frontend AGENTS audit #11).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const locale = (code: string) => JSON.parse(read(`../i18n/locales/${code}.json`)) as Record<string, any>;

describe('dialogs on the kit frame', () => {
	for (const file of ['./CreateDMModal.svelte', './CreateGroupModal.svelte', './PinnedMessagesModal.svelte', './login/LoginQRModal.svelte']) {
		test(`${file} renders through BaseModal with no hand-made overlay`, () => {
			const source = read(file);
			expect(source).toContain('<BaseModal');
			expect(source).not.toMatch(/class="(modal-overlay|qr-overlay|modal)"/);
			expect(source).not.toMatch(/&times;|>x<\/button>|>×</);
			expect(source).not.toMatch(/svelte:window[^>]*keydown/);
		});
	}

	test('BaseModal gives the frame role=dialog, aria-modal and a labelled close button', () => {
		const base = read('./BaseModal.svelte');
		expect(base).toContain('aria-modal="true"');
		expect(base).toContain('aria-label="Close dialog"');
		expect(base).toMatch(/\{role\}/);
	});

	test('New group says the encryption state in the §9.2 words, never more', () => {
		const group = read('./CreateGroupModal.svelte');
		expect(group).toContain("New groups start encryption-pending and use experimental encryption once everyone's devices are ready.");
		expect(read('./CreateDMModal.svelte')).toContain('New conversations start encryption-pending');
		for (const source of [group, read('./CreateDMModal.svelte')]) {
			expect(source).not.toMatch(/end-to-end|E2EE|\bsecure\b|operator-blind|\bverified\b/i);
		}
	});

	test('dialog titles are sentence case', () => {
		expect(read('./CreateGroupModal.svelte')).toContain('title="New group"');
		expect(read('./CreateDMModal.svelte')).toContain('title="New message"');
		expect(read('./CreateGroupModal.svelte')).not.toContain('Create Group');
		expect(read('./CreateDMModal.svelte')).not.toContain('Start a Direct Message');
	});
});

describe('sign in (§8.9, settings#17, beta-sweep#20)', () => {
	const login = read('./Login.svelte');
	const en = locale('en');

	test('verbs match: the button and the switch link both say Sign in', () => {
		expect(en.login.auth.login_button).toBe('Sign in');
		expect(login).not.toMatch(/>\s*Log ?in\s*</i);
		expect(login).toContain("$_('login.tabs.login')");
	});

	test('no placeholder echoes its label', () => {
		for (const key of [
			'username_or_handle_placeholder',
			'password_placeholder',
			'display_name_placeholder',
			'password_rules_placeholder',
			'confirm_password_placeholder'
		]) {
			expect(login).not.toContain(`login.auth.${key}`);
		}
		expect(login).not.toContain('login.guest.name_placeholder');
		// The handle keeps an example, which is allowed (§7.3).
		expect(login).toContain("placeholder={$_('login.auth.handle_placeholder')}");
	});

	test('every owner-wizard field has a visible label', () => {
		const wizard = login.slice(login.indexOf('wizardMode && wizardStep === 1'), login.indexOf('wizardMode && wizardStep === 2'));
		for (const caption of ['Display name', 'Permanent handle', 'Password', 'Confirm password']) {
			expect(wizard).toContain(`<span class="field-caption">${caption}</span>`);
		}
	});

	test('fields, buttons and checks are the kit', () => {
		expect(login).toContain('class="w-field"');
		expect(login).toContain('w-btn w-btn--primary w-btn--lg login-submit');
		expect(login).toContain('class="w-check"');
		expect(login).not.toMatch(/auth-btn|ui-check|ui-radio|guest-expand/);
	});

	test('no "mesh" setup option in any locale or in the login markup', () => {
		expect(login).not.toMatch(/\bmesh\b/i);
		for (const code of ['en', 'es', 'th']) {
			expect(String(locale(code).login?.wizard?.advanced_setup_note ?? '')).not.toMatch(/\bmesh\b/i);
		}
	});
});
