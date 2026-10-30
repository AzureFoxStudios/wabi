import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Contract: design spec §7.10 (folio), §7.23 (stage masthead), §8.2 (one persistent masthead for
// every center-stage workspace), §8.10 (DM header) and critiques header-nav#1-#18, beta-sweep#1,
// office-docs#1. Sources are read as text, like controlsKitCss.test.ts, so a regression fails
// without a browser; the folio's bar logic (the module script of WorkspaceViewBar.svelte) is
// transpiled on its own and run.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const skin = read('../styles/surfaces/stagebar.css');
const chatHeaderCss = read('../styles/components/chat-header.css');
const chatSearchCss = read('../styles/components/chat-search.css');
const chatWorkspaceCss = read('../styles/components/chat-workspace.css');
const stageBar = read('./components/StageBar.svelte');
const folio = read('./components/WorkspaceViewBar.svelte');
const chatHeader = read('./components/chat/ChatHeader.svelte');
const chat = read('./components/Chat.svelte');
const mainLayout = read('./components/MainLayout.svelte');
const relayModule = read('./experimentalWabidbCalls.ts');

interface Rule {
	selectors: string[];
	body: string;
	/** Enclosing at-rule preludes, outermost first. */
	context: string[];
}

/** Comments out, by scanning (no regex replace over markup or styles). */
function withoutComments(source: string): string {
	let out = '';
	let index = 0;
	while (index < source.length) {
		const start = source.indexOf('/*', index);
		if (start < 0) {
			out += source.slice(index);
			break;
		}
		out += source.slice(index, start);
		const end = source.indexOf('*/', start + 2);
		index = end < 0 ? source.length : end + 2;
	}
	return out;
}

function splitSelectors(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of list) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current.trim());
	return parts.filter(Boolean);
}

/** A small rule reader that follows nested at-rule blocks. */
function rules(source: string): Rule[] {
	const css = withoutComments(source);
	const out: Rule[] = [];
	const stack: string[] = [];
	let buffer = '';
	for (const ch of css) {
		if (ch === '{') {
			const prelude = buffer.trim().split(/\s+/).join(' ');
			buffer = '';
			if (prelude.startsWith('@')) {
				stack.push(prelude);
				continue;
			}
			stack.push(`rule:${prelude}`);
			continue;
		}
		if (ch === '}') {
			const top = stack.pop();
			if (top?.startsWith('rule:')) {
				out.push({
					selectors: splitSelectors(top.slice(5)),
					body: buffer.trim(),
					context: stack.filter((entry) => entry.startsWith('@'))
				});
			}
			buffer = '';
			continue;
		}
		if (ch === ';' && !stack.at(-1)?.startsWith('rule:')) {
			buffer = '';
			continue;
		}
		buffer += ch;
	}
	return out;
}

const skinRules = rules(skin);
const declarations = (rule: Rule) =>
	rule.body
		.split(';')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const colon = entry.indexOf(':');
			return { property: entry.slice(0, colon).trim(), value: entry.slice(colon + 1).trim() };
		});
const rulesFor = (needle: string) => skinRules.filter((rule) => rule.selectors.some((selector) => selector.includes(needle)));

/** The text between two markers, found with indexOf (no regex over markup). */
function between(source: string, open: string, close: string): string {
	const start = source.indexOf(open);
	if (start < 0) return '';
	const end = source.indexOf(close, start + open.length);
	return end < 0 ? '' : source.slice(start + open.length, end);
}

describe('stagebar.css: the folio never moves under the pointer', () => {
	test('hover and focus change colour or the ring only, never size, spacing or type', () => {
		const geometry = /^(width|min-width|max-width|height|padding|padding-inline|padding-block|margin|margin-inline|margin-inline-start|gap|font|font-size|font-weight|letter-spacing|transform|scale|translate|inset|inset-inline)$/;
		const interactive = skinRules.filter((rule) =>
			rule.selectors.some((selector) => /w-folio/.test(selector) && /:(hover|focus|focus-visible|focus-within)\b/.test(selector))
		);
		expect(interactive.length).toBeGreaterThan(0);
		for (const rule of interactive) {
			for (const { property } of declarations(rule)) {
				expect(geometry.test(property), `${rule.selectors.join(', ')} sets ${property}`).toBe(false);
			}
		}
	});

	test('labels never expand: no max-width or opacity animation on tab labels', () => {
		for (const rule of rulesFor('w-folio')) {
			expect(rule.body).not.toMatch(/max-width/);
			expect(rule.body).not.toMatch(/transition:[^;]*(max-width|width|margin|padding)/);
		}
		expect(folio).not.toContain('strip-label');
	});

	test('the tab strip never scrolls: no overflow on the folio, its tabs, groups or row B', () => {
		for (const needle of ['.w-folio', '.w-folio__tabs', '.w-folio__group', '.stage-bar__b']) {
			for (const rule of skinRules.filter((entry) => entry.selectors.some((selector) => selector.endsWith(needle)))) {
				expect(rule.body, `${needle} must not set overflow`).not.toMatch(/overflow(-x)?\s*:/);
			}
		}
		expect(folio).not.toMatch(/overflow-x/);
	});

	test('the current view: --w-text plus a 2px --w-sig underline lying on the masthead rule', () => {
		const underline = skinRules.find((rule) => rule.selectors.some((selector) => selector.includes(".w-folio__tab[aria-selected='true']::after")));
		expect(underline).toBeDefined();
		expect(underline!.body).toContain('background: var(--w-sig)');
		expect(underline!.body).toContain('height: 2px');
		expect(underline!.body).toContain('bottom: calc(-1 * var(--w-bw))');
		const current = skinRules.find((rule) => rule.selectors.some((selector) => selector.endsWith(".w-folio__tab[aria-selected='true']")));
		expect(current?.body).toContain('color: var(--w-text)');
		// More carries the underline while the current view lives in it.
		expect(underline!.selectors.some((selector) => selector.includes(".w-folio__more[data-current='true']::after"))).toBe(true);
	});

	test('focus inside the strip is an inset 2px accent ring that nothing can clip', () => {
		const ring = skinRules.find((rule) => rule.selectors.some((selector) => selector.includes('.w-folio__tab:focus-visible')));
		expect(ring?.body).toContain('outline: 2px solid var(--w-accent)');
		expect(ring?.body).toContain('outline-offset: -2px');
	});

	test('groups are divided by a 16px hairline; PREVIEW sits 8px after the office tabs', () => {
		const rule = skinRules.find((entry) => entry.selectors.some((selector) => selector.includes('.w-folio__group + .w-folio__group::before')) && entry.context.length === 0 && !entry.selectors[0].startsWith(':root'));
		expect(rule?.body).toContain('height: 16px');
		expect(rule?.body).toContain('background: var(--w-line)');
		const hc = skinRules.find((entry) => entry.selectors.some((selector) => selector.startsWith(":root[data-char='contrast']") && selector.includes('w-folio__group')));
		expect(hc?.body).toContain('var(--w-line-strong)');
	});
});

describe('stagebar.css: tiers are measured on the stage', () => {
	test('the stage is the query container', () => {
		const container = skinRules.find((rule) => rule.selectors.some((selector) => selector.endsWith('.chat-stack')));
		expect(container?.body).toContain('container: stage / inline-size');
	});

	test('≥1000 all · 880–999 drop tier 1000 · 700–879 drop 880 · <700 drop 700 and the topic', () => {
		const at = (width: string) => skinRules.filter((rule) => rule.context.some((context) => context === `@container stage (max-width: ${width})`));
		expect(at('999.98px').some((rule) => rule.selectors.some((selector) => selector.includes("[data-tier='1000']")) && rule.body.includes('display: none'))).toBe(true);
		expect(at('879.98px').some((rule) => rule.selectors.some((selector) => selector.includes("[data-tier='880']")) && rule.body.includes('display: none'))).toBe(true);
		const narrow = at('699.98px');
		expect(narrow.some((rule) => rule.selectors.some((selector) => selector.includes("[data-tier='700']")))).toBe(true);
		expect(narrow.some((rule) => rule.selectors.some((selector) => selector.includes('.stage-a__topic')) && rule.body.includes('display: none'))).toBe(true);
		expect(at('559.98px').some((rule) => rule.selectors.some((selector) => selector.includes("[data-tier='560']")))).toBe(true);
	});

	test('no viewport switch decides the masthead layout (the 1250px duality is gone)', () => {
		expect(skin).not.toMatch(/@media \(min-width: 1250px\)/);
		expect(skin).not.toContain('header-view-switch');
		expect(skin).not.toContain('workspace-view-bar');
		expect(folio).not.toMatch(/@media \(min-width: 900px\)/);
	});
});

describe('stagebar.css: role-only skin', () => {
	test('colours come only from --w-* roles (no hex, rgb or legacy tokens)', () => {
		const css = withoutComments(skin);
		expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(css).not.toMatch(/\brgba?\(/);
		expect(css).not.toMatch(/var\(--(surface|text|accent-primary|border)-/);
		expect(css).not.toContain('!important');
	});

	test('the masthead is --w-mast tall with one hairline: row A --w-head-a, then the folio', () => {
		const frame = skinRules.find((rule) => rule.selectors.includes('.stage-bar'));
		expect(frame?.body).toContain('height: var(--w-mast)');
		expect(frame?.body).toContain('grid-template-rows: var(--w-head-a) minmax(0, 1fr)');
		expect(frame?.body).toContain('border-bottom: var(--w-bw) solid var(--w-line)');
		expect(frame?.body).toContain('padding: 0 var(--w-gutter)');
	});

	test('every text size respects --w-fs (type tokens or calc(* var(--w-fs)))', () => {
		for (const rule of skinRules) {
			for (const { property, value } of declarations(rule)) {
				if (property === 'font-size') expect(value, rule.selectors.join(', ')).toContain('var(--w-fs)');
				if (property === 'font' && !value.startsWith('var(--w-t-')) expect(value, rule.selectors.join(', ')).toContain('var(--w-fs)');
			}
		}
	});

	test('the legacy header and search sheets keep only what other surfaces still use', () => {
		for (const retired of ['.chat-header', '.channel-title', '.dm-badge', '.spoiler-channel-badge', '.retention-channel-badge', '.header-action-group']) {
			expect(withoutComments(chatHeaderCss)).not.toContain(retired);
		}
		expect(withoutComments(chatHeaderCss)).toContain('.header-actions');
		for (const retired of ['.search-container', '.search-input', '.search-icon', '.search-history-btn', 'ease-bounce']) {
			expect(withoutComments(chatSearchCss)).not.toContain(retired);
		}
		expect(withoutComments(chatSearchCss)).toContain('.search-results-toolbar');
		expect(withoutComments(chatSearchCss)).not.toMatch(/\brgba?\(|var\(--(surface|text|accent-primary|border)-/);
		expect(withoutComments(chatWorkspaceCss)).not.toContain('.surface-return-btn');
		expect(withoutComments(chatWorkspaceCss)).not.toMatch(/var\(--(surface|text|accent-primary|border)-/);
	});
});

describe('one persistent masthead (MainLayout → StageBar → folio)', () => {
	test('MainLayout mounts StageBar once at the top of the stage; the standalone bar is gone', () => {
		const stack = between(mainLayout, '<div class="chat-stack"', '<div class="chat-surface">');
		expect(stack).toContain('<StageBar {activityBadge} onSelectView={handleWorkspaceViewSelect} />');
		expect(mainLayout.split('<StageBar').length - 1).toBe(1);
		expect(mainLayout).not.toContain('<WorkspaceViewBar');
		expect(mainLayout).toContain("const STAGE_PARTS = '.stage-bar, .chat-surface, .voice-live-strip'");
	});

	test('StageBar: row A from stageHeader with channel/DM defaults and a component slot, row B the folio', () => {
		expect(stageBar).toContain("import { stageHeader");
		expect(stageBar).toContain('<ChatHeader channelId={$currentChannel}');
		expect(stageBar).toContain('<HeaderComponent {...header.props} />');
		expect(stageBar).toContain('<WorkspaceViewBar activeView={view}');
		expect(stageBar).toContain('variant="trigger"');
		// A joined presentation is named "Presentation" (OFFICE_TAB_LABEL.audience).
		expect(stageBar).toContain('OFFICE_TAB_LABEL[tool]');
	});

	test('the channel views keep the channel row; ChatHeader no longer hosts the switcher', () => {
		expect(stageBar).toContain("view === 'messages' || view === 'whiteboard'");
		expect(chatHeader).not.toContain('WorkspaceViewBar');
		expect(chatHeader).not.toContain('header-view-switch');
	});
});

describe('the folio markup (WorkspaceViewBar.svelte)', () => {
	test('a real tablist: tabs with aria-selected, aria-current and a roving tabindex', () => {
		expect(folio).toContain('role="tablist"');
		expect(folio).toContain('role="tab"');
		expect(folio).toContain("aria-selected={activeView === view.id}");
		expect(folio).toContain("aria-current={activeView === view.id ? 'page' : undefined}");
		expect(folio).toContain('tabindex={rovingId === view.id ? 0 : -1}');
		for (const key of ["'ArrowRight'", "'ArrowLeft'", "'Home'", "'End'"]) expect(folio).toContain(key);
	});

	test('labelled words, no icons on tabs; one PREVIEW after the office group', () => {
		const tabs = between(folio, 'role="tablist"', '</nav>');
		expect(tabs).not.toContain('<Icon name={');
		expect(tabs).not.toContain('<svg');
		expect(tabs.split("$_('maturity.preview')}").length - 1).toBe(1);
		expect(tabs).toContain("group.id === 'office'");
	});

	test('right-click offers Open, Open beside and Remove from bar; More pins and lists hidden views', () => {
		expect(folio).toContain('oncontextmenu={(event) => openTabMenu(event, view)}');
		expect(folio).toContain("$_('folio.open')");
		expect(folio).toContain("$_('folio.open_beside')");
		expect(folio).toContain("$_('folio.remove_from_bar')");
		expect(folio).toContain("$_('folio.pin_to_bar')");
		expect(folio).toContain("$_('maturity.off_on_device')");
		expect(folio).toContain("role: 'menuitemradio'");
	});

	test('Activity announces its count with the tab (not on a generic span)', () => {
		expect(folio).toContain('<span class="sr-only">, {needsYou}</span>');
		expect(folio).not.toMatch(/activity-badge" aria-label=/);
	});
});

describe('the folio bar logic (module script of WorkspaceViewBar.svelte)', () => {
	type Key = string;
	type View = { id: Key; group: string; tier: number; bar: boolean; preview?: boolean; addon?: string };
	let FOLIO_VIEWS: View[];
	let folioBarIds: (choices: { pinned: Key[]; removed: Key[] }, addons: { sheets: boolean; present: boolean }) => Key[];
	let readFolioChoices: (server: string) => { pinned: Key[]; removed: Key[] };
	let directory = '';
	const store = new Map<string, string>();

	beforeAll(async () => {
		const start = folio.indexOf('<script module lang="ts">');
		const source = between(folio.slice(start), '<script module lang="ts">', '</script>');
		expect(source.length).toBeGreaterThan(0);
		const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
		directory = mkdtempSync(join(tmpdir(), 'wabi-folio-'));
		const path = join(directory, 'folio.mjs');
		writeFileSync(path, js);
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value)
		};
		({ FOLIO_VIEWS, folioBarIds, readFolioChoices } = await import(pathToFileURL(path).href));
	});

	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		delete (globalThis as { localStorage?: unknown }).localStorage;
	});

	const none = { pinned: [], removed: [] };

	test('default bar, in groups: this channel · community · yours · office', () => {
		expect(folioBarIds(none, { sheets: true, present: true })).toEqual([
			'messages', 'files', 'whiteboard', 'voice', 'notifications', 'lore', 'planner', 'notes', 'documents', 'sheets', 'present'
		]);
	});

	test('Sheets and Present join the bar only while their add-on is on for this device', () => {
		expect(folioBarIds(none, { sheets: false, present: false })).not.toContain('sheets');
		expect(folioBarIds(none, { sheets: false, present: false })).not.toContain('present');
		expect(folioBarIds(none, { sheets: true, present: false })).toContain('sheets');
		expect(folioBarIds({ pinned: ['present'], removed: [] }, { sheets: false, present: false })).not.toContain('present');
	});

	test('tiers follow §7.10', () => {
		const tier = (id: Key) => FOLIO_VIEWS.find((view) => view.id === id)?.tier;
		expect(['messages', 'voice', 'planner'].map(tier)).toEqual([0, 0, 0]);
		// Documents stays on the bar in every contract tier; only the narrow-tablet guard moves it.
		expect(tier('documents')).toBe(560);
		expect(['whiteboard', 'lore'].map(tier)).toEqual([1000, 1000]);
		expect(['files', 'sheets', 'present'].map(tier)).toEqual([880, 880, 880]);
		expect(['notifications', 'notes'].map(tier)).toEqual([700, 700]);
		// Media, Reader, 3D viewer and Map live in More until pinned.
		expect(FOLIO_VIEWS.filter((view) => !view.bar).map((view) => view.id).sort()).toEqual(['map', 'media', 'model', 'reader']);
		expect(FOLIO_VIEWS.filter((view) => view.preview).map((view) => view.id)).toEqual(['documents', 'sheets', 'present']);
	});

	test('pins and removals change the bar; Chat can never leave it', () => {
		const ids = folioBarIds({ pinned: ['map'], removed: ['notes', 'messages'] }, { sheets: false, present: false });
		expect(ids).toContain('map');
		expect(ids).not.toContain('notes');
		expect(ids[0]).toBe('messages');
		// A pinned view takes its group's place in bar order.
		expect(ids.indexOf('map')).toBeGreaterThan(ids.indexOf('lore'));
		expect(ids.indexOf('map')).toBeLessThan(ids.indexOf('planner'));
	});

	test('stored choices are read per server and unknown ids or broken JSON are ignored', () => {
		store.set('wabi:folio-bar:v1:https://a.example', JSON.stringify({ pinned: ['map', 'nope', 3], removed: ['files'] }));
		store.set('wabi:folio-bar:v1:https://b.example', '{not json');
		expect(readFolioChoices('https://a.example')).toEqual({ pinned: ['map'], removed: ['files'] });
		expect(readFolioChoices('https://b.example')).toEqual({ pinned: [], removed: [] });
		expect(readFolioChoices('https://c.example')).toEqual({ pinned: [], removed: [] });
	});
});

describe('row A for channels and DMs (chat/ChatHeader.svelte)', () => {
	test('the no-op "wabiDB Relay ON/OFF" toggle and its plumbing are gone', () => {
		expect(chatHeader).not.toMatch(/wabiDB Relay|experimental-wabidb-toggle|onToggleExperimentalWabidbCall/);
		expect(chat).not.toMatch(/ExperimentalWabidbCall(Enabled|Ui)|experimentalWabidbCallsEnabled|experimentalScopeVisible/);
		expect(relayModule).not.toMatch(/export (async )?function (is|set)(ExperimentalWabidbCallEnabled|WabidbRelayToggleEnabled)/);
		expect(relayModule).not.toContain('wabi_experimental_wabidb_calls_enabled');
		// The transport helpers calling_impl_core.ts uses stay.
		expect(relayModule).toContain('export async function markExperimentalWabidbCallAttempt');
	});

	test('chips are words: no emoji, and no lock glyph standing for retention or spoilers', () => {
		for (const glyph of ['🔒', '👁', '📦', '✕', '⋯']) expect(chatHeader).not.toContain(glyph);
		expect(chatHeader).not.toContain('retention-channel-badge');
		expect(chatHeader).not.toContain("'Live session'");
		expect(chatHeader).not.toContain("'Keep forever'");
	});

	test('DM and group privacy is the one PrivacyBadge chip; channels leave privacy to the colophon', () => {
		expect(chatHeader).toContain('<PrivacyBadge');
		expect(chatHeader).toContain('variant="popover-trigger"');
		expect(chatHeader).toContain("input={{ channelType: isGroup ? 'group' : 'dm', policy: e2eeStatus }}");
		expect(chatHeader).not.toMatch(/Encryption · experimental|'Server-readable'/);
	});

	test('search: a quiet icon that opens a 280px field named for the room; syntax help in the dropdown', () => {
		expect(chatHeader).toContain("$_('stage.search_channel'");
		expect(chatHeader).toContain("$_('stage.search_conversation'");
		expect(chatHeader).toContain("$_('stage.search_help')");
		expect(chatHeader).toContain('class="w-field w-field--chrome stage-search__field"');
		expect(chatHeader).not.toContain("$_('chat.search.placeholder')");
		const field = skinRules.find((rule) => rule.selectors.some((selector) => selector.endsWith('.stage-search__field')));
		expect(field?.body).toContain('width: min(280px, 40cqi)');
	});

	test('the topic opens "About this channel"; pinned and ⋯ are real actions', () => {
		expect(chatHeader).toContain('class="stage-a__topic"');
		expect(chatHeader).toContain('aria-haspopup="dialog"');
		expect(chatHeader).toContain("$_('stage.about_channel')");
		expect(chatHeader).toContain("$_('stage.pinned')");
		expect(chatHeader).toContain("$_('stage.more_actions')");
	});
});

describe('Chat.svelte keeps the stream and composer wiring', () => {
	test('the unreachable per-workspace header copy is gone (header-nav#18)', () => {
		for (const name of ['workspaceSurfaceLabel', 'workspaceHeaderTitle', 'workspaceHeaderSubtitle', "'Media Albums'", "'3D Viewport'", "return 'Voice'"]) {
			expect(chat).not.toContain(name);
		}
		expect(chat).not.toContain('<ChatHeader');
	});

	test('the stream filters by the masthead query and reports back; message keys and the composer are untouched', () => {
		expect(chat).toContain('$: searchInput = $chatSearch.query;');
		expect(chat).toContain('$: chatStageInfo.set({');
		expect(chat).toContain("{#key `${$currentUser?.dbUserId || $currentUser?.id || ''}:${$currentChannel}`}");
		expect(chat).toContain('<ChatComposer');
		expect(chat).toContain('bind:this={chatComposer}');
	});
});
