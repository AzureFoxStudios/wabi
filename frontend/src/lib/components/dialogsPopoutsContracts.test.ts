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

	test('New group says why Create group is disabled, and its footer rule follows the scroll', () => {
		const group = read('./CreateGroupModal.svelte');
		expect(group).toContain("'Name the group to create it'");
		expect(group).toContain("'Pick at least one person'");
		expect(group).toContain('aria-describedby="{uid}-foot"');
		expect(group).toContain('class:w-dialog__foot--rule={bodyScrolls}');
		expect(group).not.toContain('class="w-dialog__foot w-dialog__foot--rule"');
		expect(group).toMatch(/\.cg-count \{[^}]*white-space: nowrap;/);
		expect(group).toMatch(/<input\s+id="\{uid\}-name"[^>]*\srequired\b/);
	});

	test('Board settings draws its buttons in DOM order (no CSS reorder)', () => {
		const panel = read('../../styles/surfaces/panel.css');
		const block = panel.slice(panel.indexOf('HELD FOR w1-dialogs-popouts'), panel.indexOf('w1-switcher-dms, wave 1b'));
		expect(block).toContain('.wb-settings-save');
		expect(block).not.toMatch(/\border:\s*\d/);
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

	test('one login stylesheet on roles: no glows, rem sizes, unloaded weights or negative tracking', () => {
		const skin = read('../../styles/login-skin.css');
		expect(login).not.toContain("import './login.css'");
		expect(skin).not.toMatch(/radial-gradient/);
		// The only gradient is the operator's own two-colour launch palette.
		expect(skin.match(/linear-gradient\([^;]*/g) ?? []).toEqual(['linear-gradient(180deg, transparent, var(--launch-bg-bottom, transparent))']);
		expect(skin).not.toMatch(/font-size:\s*[\d.]+rem/);
		expect(skin).not.toMatch(/font-weight:\s*(550|600|650)\b/);
		expect(skin).not.toMatch(/font:\s*(550|600|650)\s+[^;]*var\(--w-sans\)/);
		expect(skin).not.toMatch(/letter-spacing:\s*-/);
		expect(skin).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
		// Form fields are 38px, 44px only under a coarse pointer (§7.3).
		expect(skin).toMatch(/\.login-container \.w-field \{\s*height: 38px;/);
		expect(skin).toMatch(/@media \(pointer: coarse\) \{\s*\.login-container \.w-field \{\s*height: 44px;/);
	});

	test('the sign-in card hangs from the top and errors sit under the action that failed', () => {
		const skin = read('../../styles/login-skin.css');
		expect(skin).toMatch(/\.login-container \.login-shell \{[^}]*margin: 0 auto;/);
		expect(skin).toMatch(/\.login-container \.login-box-default \{[^}]*align-items: start;/);
		const signIn = login.slice(login.indexOf("{#if authMode === 'login'}"), login.indexOf('{:else}', login.indexOf("{#if authMode === 'login'}")));
		expect(signIn.indexOf('</form>')).toBeLessThan(signIn.indexOf('error-message'));
		const heading = login.slice(login.indexOf('<header class="login-auth-heading">'), login.indexOf('</header>'));
		expect(heading).not.toContain('error-message');
	});

	test('the server line carries Change server, and each glyph has one meaning', () => {
		const heading = login.slice(login.indexOf('<header class="login-auth-heading">'), login.indexOf('</header>'));
		expect(heading).toContain('<Icon name="server" size={14} />');
		expect(heading).toContain("$_('login.auth.change_server_button')");
		const footer = login.slice(login.indexOf('<footer class="login-footer">'), login.indexOf('</footer>'));
		expect(footer).not.toContain('change_server_button');
		// The globe means language here, as it does for Translate in the message menu.
		expect(footer).toContain('<Icon name="globe" size={14} />');
		expect(login.match(/name="globe"/g)?.length).toBe(1);
	});

	test('the change-server prompt shows a danger edge with an icon, and a way back', () => {
		const prompt = read('./login/LoginConnectionPrompt.svelte');
		expect(prompt).toContain("aria-invalid={connectionError ? 'true' : undefined}");
		expect(prompt).toMatch(/class="w-field-error connection-error"[^>]*><Icon name="alert" size=\{14\} \/>/);
		expect(prompt).toContain('Back to sign in');
		expect(login).toContain('cancellable={promptReturnDomain !== null}');
		const skin = read('../../styles/login-skin.css');
		expect(skin).toMatch(/\[aria-invalid='true'\][^{]*\):focus-within \{\s*border-color: var\(--w-danger\)/);
	});

	test('no "mesh" setup option in any locale or in the login markup', () => {
		expect(login).not.toMatch(/\bmesh\b/i);
		for (const code of ['en', 'es', 'th']) {
			expect(String(locale(code).login?.wizard?.advanced_setup_note ?? '')).not.toMatch(/\bmesh\b/i);
		}
	});
});
