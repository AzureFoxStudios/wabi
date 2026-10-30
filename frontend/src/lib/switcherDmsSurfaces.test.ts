import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Server switcher, server rail, DMs hub and DM conversations (design contract §8.1, §8.10, §9.2).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Applies one pattern until the text stops changing (a single pass can leave nested remnants). */
function stripAll(text: string, pattern: RegExp): string {
	let previous: string;
	let current = text;
	do {
		previous = current;
		current = current.replace(pattern, '');
	} while (current !== previous);
	return current;
}

const withoutComments = (css: string) => stripAll(css, /\/\*[^]*?\*\//);
/** The template part of a component: everything after its instance script. */
const markupOf = (svelte: string) => svelte.slice(svelte.lastIndexOf('</script>') + '</script>'.length);
/** A component's <style> block, comments removed. */
const styleOf = (svelte: string) => withoutComments(svelte.slice(svelte.indexOf('<style>')));
/** The template without its <style> block or HTML comments. */
const templateOf = (svelte: string) => {
	const markup = markupOf(svelte);
	const styleAt = markup.indexOf('<style>');
	return stripAll(styleAt >= 0 ? markup.slice(0, styleAt) : markup, /<!--[^]*?-->/);
};

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
const LEGACY_TOKEN = /var\(--(surface-|text-(?!on-)|accent-primary|accent-secondary|border-(rgb|subtle|default)|color-(border|danger|success|warning|info)|font-size-|shadow-(md|lg))/;

describe('switcher and rail stylesheets are on roles', () => {
	for (const file of ['../styles/components/server-switcher.css', '../styles/components/server-rail.css']) {
		test(`${file.split('/').pop()} uses roles only: no raw colours, legacy tokens, glows, !important or transition: all`, () => {
			const css = withoutComments(read(file));
			expect(css).not.toMatch(RAW_COLOR);
			expect(css).not.toMatch(LEGACY_TOKEN);
			expect(css).not.toContain('!important');
			expect(css).not.toMatch(/transition:\s*all/);
			expect(css).not.toMatch(/radial-gradient|linear-gradient|backdrop-filter/);
			// Nothing moves under the pointer.
			expect(css).not.toMatch(/:hover[^{]*\{[^}]*(transform|translate|scale)/);
		});
	}

	test('the switcher overlays only the sidebar and lets the rest of its overlay through', () => {
		const css = withoutComments(read('../styles/components/server-switcher.css'));
		expect(css).toContain('width: calc(100% - var(--switcher-excess, 0px))');
		expect(css).toMatch(/\.server-switcher-overlay:not\(\.mobile\)\s*\{\s*pointer-events: none;/);
		expect(css).toContain('border-right: var(--w-bw) solid var(--w-line-strong)');
		expect(css).toContain('box-shadow: var(--w-shadow)');
	});

	test('the current server row is the selection grammar: raise, ringed in High Contrast, no left bar', () => {
		const css = withoutComments(read('../styles/components/server-switcher.css'));
		expect(css).toMatch(/\.switcher-row\.active > \.switcher-row-main\s*\{\s*background: var\(--w-raise\);/);
		expect(css).toContain("box-shadow: inset 0 0 0 1px var(--w-line-strong)");
		expect(css).not.toMatch(/inset-inline-start:\s*0;\s*width:\s*3px/);
	});

	test('rail unread is an ink dot with a ring in the rail colour, never a count pill', () => {
		const css = withoutComments(read('../styles/components/server-rail.css'));
		expect(css).toMatch(/\.server-unread-dot\s*\{[^}]*width: 8px;[^}]*background: var\(--w-text\);/);
		expect(read('../lib/components/ServerRail.svelte')).not.toContain('server-unread-badge');
	});
});

describe('server switcher', () => {
	const panel = read('../lib/components/ServerSwitcherPanel.svelte');
	const template = templateOf(panel);

	test('says what it is: saved servers, the current host without scheme, one account per server', () => {
		expect(template).toContain('Saved servers');
		expect(template).toContain('Each server keeps its own account.');
		expect(template).toContain('serverHostLabel(showcaseServer.url)');
		expect(panel).not.toContain('#2dd4bf');
	});

	test('remove lives in the row menu and asks first; there is no always-visible red button', () => {
		expect(template).not.toContain('switcher-remove-bubble');
		const remove = panel.slice(panel.indexOf('async function removeServer'), panel.indexOf('function rowMenuItems'));
		expect(remove.indexOf('confirmAction')).toBeGreaterThan(-1);
		expect(remove.indexOf('confirmAction')).toBeLessThan(remove.indexOf('removeSavedServer('));
		expect(panel).toContain("label: 'Remove saved server', icon: 'trash', danger: true");
	});

	test('"Add server" is a default kit button; Esc closes the desktop overlay', () => {
		expect(template).toMatch(/class="w-btn switcher-add-btn"/);
		expect(panel).toContain("event.key !== 'Escape'");
		expect(template).toContain('use:sheetFocus={mobile}');
	});
});

describe('DMs hub', () => {
	const hub = read('../lib/components/DmHub.svelte');
	const template = templateOf(hub);

	test('is titled DMs with a Conversations | Friends segment and no Server home pseudo-tab', () => {
		expect(template).toContain("$_('places.dms')");
		expect(template).toContain("$_('places.conversations')");
		expect(template).toContain("$_('places.friends')");
		expect(template).toContain('class="w-seg dm-hub-seg"');
		expect(template).not.toContain('Server home');
		expect(template).not.toContain("dispatch('serverHome')");
	});

	test('row B is the hub search and the New message primary', () => {
		expect(template).toContain('placeholder="Search DMs"');
		expect(template).toContain('class="w-btn w-btn--primary dm-hub-new-btn"');
		expect(template).toContain('>New message</button>');
	});

	test('the hub never words an envelope as a privacy claim', () => {
		expect(hub).not.toContain("'Encrypted message'");
		expect(styleOf(hub)).not.toMatch(RAW_COLOR);
		expect(styleOf(hub)).not.toMatch(LEGACY_TOKEN);
	});
});

describe('DM conversations: truthful privacy, no raw errors, no jargon', () => {
	for (const file of ['../lib/components/DmConversationView.svelte', '../lib/components/DMMessageView.svelte']) {
		const source = read(file);
		const template = templateOf(source);
		const name = file.split('/').pop();

		test(`${name} never shows a raw Error.message`, () => {
			expect(source).not.toMatch(/e2eeError\s*=\s*error instanceof Error \? error\.message/);
			expect(source).toContain('dmEncryptionError(action, error)');
		});

		test(`${name} has no E2EE wording, legacy privacy pills or left-barred gate`, () => {
			expect(template).not.toMatch(/E2EE/);
			expect(template).not.toContain('dm-tool-encryption-status');
			expect(template).not.toContain('Encrypted · experimental');
			expect(template).not.toContain('New messages encrypted');
			expect(source).toContain('dmSendGate(e2eeStatus, missingDeviceLabel)');
			expect(template).toContain('sendGate.title');
		});

		test(`${name} styles only with roles`, () => {
			const css = styleOf(source);
			expect(css).not.toMatch(RAW_COLOR);
			expect(css).not.toMatch(LEGACY_TOKEN);
			expect(css).not.toMatch(/inset 2px 0 0/);
		});
	}

	test('the center-stage header carries the seal chip from PrivacyBadge, with call actions', () => {
		const view = templateOf(read('../lib/components/DmConversationView.svelte'));
		expect(view).toMatch(/<PrivacyBadge\s+variant="popover-trigger"\s+input=\{\{ channelType: isGroup \? 'group' : 'dm', policy: e2eeStatus \}\}/);
		expect(view).toContain('startConversationCall(false)');
		expect(view).toContain('startConversationCall(true)');
		expect(view).not.toContain('<details');
	});

	test('panel.css no longer holds the legacy DM protection pills or the barred gate', () => {
		const css = withoutComments(read('../styles/surfaces/panel.css'));
		expect(css).not.toContain('.dm-tool-encryption-status');
		expect(css).not.toContain('.dm-encryption-gate');
	});
});
