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

	test('the tiers are drawn for 100% text: a measured fit pass hides what still overflows', () => {
		// The rule the fit pass sets, outside every tier (it applies at any stage width).
		const fitRule = skinRules.find((rule) => rule.selectors.some((selector) => selector.endsWith(".w-folio [data-fit='out']")));
		expect(fitRule?.body).toContain('display: none');
		expect(fitRule?.context).toEqual([]);
		// It measures real overflow (not only the tabs a tier hid) and re-runs on every width,
		// scale or word change: the stage resizes the folio, --w-fs resizes More.
		expect(folio).toContain('strip.scrollWidth > strip.clientWidth');
		expect(folio).toContain("tab.setAttribute('data-fit', 'out')");
		expect(folio).toContain("group.setAttribute('data-fit', 'out')");
		expect(folio).toContain('for (const id of folioFitOrder(');
		expect(folio).toContain('observer.observe(more)');
		for (const dependency of ['void barIds;', 'void activityBadge;', 'void channelKind;', 'void $_;']) expect(folio).toContain(dependency);
		// data-fit is owned by the pass, never by the template (a pass starts from the tiers alone).
		expect(between(folio, '{:else}\n\t<nav', '</nav>')).not.toContain('data-fit=');
	});

	test('below a 760px stage the crumb collapses to its glyph and a scope tag to its dot (words kept)', () => {
		const at760 = skinRules.filter((rule) => rule.context.includes('@container stage (max-width: 759.98px)'));
		expect(at760.some((rule) => rule.selectors.some((selector) => selector.includes('.stage-a__crumb-glyph')) && rule.body.includes('display: block'))).toBe(true);
		const hidden = at760.find((rule) => rule.selectors.some((selector) => selector.includes('.stage-a__crumb-words')));
		expect(hidden?.selectors.some((selector) => selector.includes('.stage-a__scope-words'))).toBe(true);
		// Visually hidden, not removed: assistive tech keeps the words.
		expect(hidden?.body).toContain('clip-path: inset(50%)');
		expect(hidden?.body).not.toContain('display: none');
		expect(at760.some((rule) => rule.selectors.some((selector) => selector.includes('.stage-a__scope-dot')) && rule.body.includes('display: inline-block'))).toBe(true);
		expect(stageBar).toContain('<span class="stage-a__crumb" title={fallback.crumb}>');
		expect(stageBar).toContain('title={tag.title ?? tag.label}');
	});

	test('a scope tag collapses to its dot only when row A has a ⋯ to carry its words', () => {
		expect(stageBar).toContain("const scopeCollapses = $derived(Boolean(header?.actions.some((action) => action.icon === 'more')));");
		const collapsed = between(stageBar, '{:else if scopeCollapses}', '{:else}');
		expect(collapsed).toContain('class="w-tag stage-a__chip stage-a__scope"');
		// Without a ⋯ the words stay in the row (Principle 8: never a bare glyph).
		const plain = between(stageBar, '{:else if scopeCollapses}', '{/if}').split('{:else}')[1] ?? '';
		expect(plain).toContain('<span class="w-tag stage-a__chip" title={tag.title}>{tag.label}</span>');
		expect(plain).not.toContain('stage-a__scope');
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

	test('a short title keeps only its own width; a long one keeps 96px while the row shrinks', () => {
		const title = skinRules.find((rule) => rule.selectors.includes('.stage-bar .stage-a__title'));
		const mins = declarations(title!).filter((entry) => entry.property === 'min-width').map((entry) => entry.value);
		// The plain floor first (engines without calc-size), then the content-aware one.
		expect(mins).toEqual(['min(96px, 100%)', 'calc-size(max-content, min(96px, size))']);
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
		// The in-stream results toolbar is a rule on the stage gutter, not a bordered box at the edge.
		const toolbar = rules(chatSearchCss).find((rule) => rule.selectors.includes('.search-results-toolbar'));
		expect(toolbar?.body).toContain('padding: 8px var(--w-gutter)');
		expect(toolbar?.body).toContain('border-bottom: var(--w-bw) solid var(--w-line)');
		expect(toolbar?.body).not.toMatch(/(^|;)\s*border:/);
		expect(toolbar?.body).not.toContain('border-radius');
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

	test('the phone "Chat ▾" button sits after the clipped lead, so its 44px touch band survives', () => {
		// StageBar: never rendered inside a .stage-a__lead (overflow: hidden clips the ::before band).
		for (const lead of stageBar.split('<div class="stage-a__lead').slice(1)) {
			expect(lead.slice(0, lead.indexOf('</div>'))).not.toContain('workspaceButton');
		}
		// ChatHeader: the trail renders after each lead closes, before the actions.
		const leads = chatHeader.split('<div class="stage-a__lead').slice(1);
		expect(leads.length).toBe(2);
		for (const lead of leads) {
			expect(lead.slice(0, lead.indexOf('</div>'))).not.toContain('trail');
			expect(lead.slice(lead.indexOf('</div>'), lead.indexOf('<div class="stage-a__actions"'))).toContain('{@render trail?.()}');
		}
		const lead = skinRules.find((rule) => rule.selectors.includes('.stage-bar .stage-a__lead'));
		expect(lead?.body).toContain('overflow: hidden');
		// On the phone the lead takes its content width, so the button follows the title; the lead
		// gives way before the button does.
		const phoneLead = skinRules.find((rule) => rule.selectors.includes('.stage-bar--phone .stage-a__lead'));
		// 10⁶, not 1000: the trigger's share of a long name's overflow must stay under a layout unit,
		// or its label takes an ellipsis while the lead still has room to give (round 3).
		expect(phoneLead?.body).toContain('flex: 0 1000000 auto');
		const band = skinRules.find((rule) => rule.selectors.includes('.stage-bar .w-folio-trigger::before'));
		// The band is measured from inside the border, so the border width is added back: 30 + 2 × 7 = 44.
		expect(band?.body).toContain('inset: calc(-7px - var(--w-bw)) calc(-2px - var(--w-bw))');
		const trigger = skinRules.find((rule) => rule.selectors.includes('.stage-bar .w-folio-trigger'));
		expect(trigger?.body).toContain('height: 30px');
	});

	test('the channel views keep the channel row; ChatHeader no longer hosts the switcher', () => {
		expect(stageBar).toContain("view === 'messages' || view === 'whiteboard'");
		expect(chatHeader).not.toContain('WorkspaceViewBar');
		expect(chatHeader).not.toContain('header-view-switch');
	});

	// Regression (round 3 handoff): the companion's "Open in center stage" for DMs sends
	// preserveRightPanel: true and unpins only its own panel. The DM branch of wabi:navigate
	// closed the whole right panel anyway, so every other pin went with it.
	test('wabi:navigate keeps the companion when asked, for chat and for DMs alike', () => {
		const handler = between(mainLayout, 'function handleWabiNavigate(event: Event): void {', 'function handleMobilePopState');
		expect(handler.length).toBeGreaterThan(0);
		const chatBranch = between(handler, "if (detail.view === 'chat') {", 'return;');
		const dmBranch = between(handler, "if (detail.view === 'dm' || detail.view === 'messages') {", 'return;');
		expect(chatBranch.length).toBeGreaterThan(0);
		expect(dmBranch.length).toBeGreaterThan(0);
		for (const branch of [chatBranch, dmBranch]) {
			expect(branch).toContain('if (detail.preserveRightPanel !== true) layoutStore.closeRightPanel();');
			// No unconditional close beside the guarded one.
			expect(branch.split('layoutStore.closeRightPanel()').length - 1).toBe(1);
		}
		// Without the flag the DM route still closes the companion, as before.
		expect(dmBranch).toContain('layoutStore.openCenterDm(detail.channelId, null);');
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

	test('Pin to bar: rows stay while More is open; a pin that is out of room says where it shows', () => {
		expect(folio).toContain('onopenchange={onMoreOpenChange}');
		expect(folio).toContain('FOLIO_VIEWS.filter((view) => isCustomizable(view) || pinRows.includes(view.id))');
		expect(folio).toContain("pinRows = open ? FOLIO_VIEWS.filter(isCustomizable).map((view) => view.id) : [];");
		expect(folio).toContain("hint: onBar && hiddenNow.includes(view.id) ? 'shows on a wider stage' : undefined");
	});

	test('My Planner states its locality once, in the sheet and tooltip detail (§8.12, §9.3)', () => {
		expect(folio).toContain("$businessSyncAvailable === true ? 'Synced to server' : 'Only you · this device'");
		expect(folio).not.toContain('personal tasks, journal & calendar');
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
	let folioFitOrder: (shown: Key[]) => Key[];
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
		({ FOLIO_VIEWS, folioBarIds, readFolioChoices, folioFitOrder } = await import(pathToFileURL(path).href));
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
		// Media, Reader, 3D viewer and Map live in More until pinned; once pinned no tier moves
		// them (a pin that a tier hid at once would tick the row and change nothing on the bar).
		expect(FOLIO_VIEWS.filter((view) => !view.bar).map((view) => view.id).sort()).toEqual(['map', 'media', 'model', 'reader']);
		expect(FOLIO_VIEWS.filter((view) => !view.bar).every((view) => view.tier === 0)).toBe(true);
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

	test('fit order: tiered defaults first (widest tier, right to left), then pins, then the rest; never Chat', () => {
		// The full ≥1000 bar with Map pinned, as the fit pass sees it at 125% text.
		const shown = ['messages', 'files', 'whiteboard', 'voice', 'notifications', 'lore', 'map', 'planner', 'notes', 'documents', 'sheets', 'present'];
		expect(folioFitOrder(shown)).toEqual([
			'lore', 'whiteboard', 'present', 'sheets', 'files', 'notes', 'notifications', 'documents', 'map', 'planner', 'voice'
		]);
		// What the 700–879 tier leaves (Chat | Calls Activity | My Planner Notes | Documents).
		expect(folioFitOrder(['messages', 'voice', 'notifications', 'planner', 'notes', 'documents'])).toEqual([
			'notes', 'notifications', 'documents', 'planner', 'voice'
		]);
		expect(folioFitOrder(['messages'])).toEqual([]);
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

	test('with the better search page on, the help drop never covers the stream results toolbar', () => {
		// The drop then carries only the help line; the count, Search on Web and full history live in
		// the results toolbar under the bar, so a typed query must close the drop.
		const decl = chatHeader.slice(chatHeader.indexOf('const dropVisible'), chatHeader.indexOf(');', chatHeader.indexOf('const dropVisible')));
		expect(decl).toContain("betterSearch ? searchFocused && query.trim() === ''");
		expect(decl).toContain("searchFocused || query.trim() !== ''");
		// Without the better search page the drop holds the count and actions itself, so it stays.
		expect(chatHeader).toContain('{#if query.trim() && info && !betterSearch}');
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
		expect(chatHeader).toContain("const privacyInput = $derived({ channelType: isGroup ? 'group' : 'dm', policy: e2eeStatus });");
		expect(chatHeader).toContain('input={privacyInput}');
		expect(chatHeader).not.toMatch(/Encryption · experimental|'Server-readable'/);
	});

	test('channel retention is said once per screen: the composer colophon where it shows the channel, else this chip', () => {
		const imported = between(chatHeader, 'import {\n\t\tprivacyWords,', "} from '$lib/privacy/privacyState';");
		for (const name of ['retentionChipVisible', 'retentionFact', 'retentionLabel', 'retentionTitle']) expect(imported).toContain(name);
		// w1-composer: a mounted composer colophon holds its channel; row A then leaves retention to it.
		expect(chatHeader).toContain("import { composerColophons } from './composerPrivacy';");
		expect(chatHeader).toContain('const colophonCarriesRetention = $derived(($composerColophons[channelId] ?? 0) > 0);');
		expect(chatHeader).toContain('!colophonCarriesRetention && retentionChipVisible(privacySummary)');
		expect(chatHeader).toContain('{ label: retentionLabel(privacySummary), title: retentionTitle(privacySummary) }');
		const chip = between(chatHeader, '{#if retention}', '{/if}');
		expect(chip).toContain('<Icon name="clock" size={12} />');
		expect(chip).toContain('title={retention.title}');
		expect(chip).not.toMatch(/\block|private/i);
		// About this channel carries it too, so the phone bar (no chip room) can reach it.
		expect(chatHeader).toContain('<dt>Messages kept</dt>');
		expect(chatHeader).toContain('const chipRoom = $derived(retention ? 1 : 2);');
		// The colophon reads the summary this header publishes, only for its own channel.
		const composer = read('./components/chat/ChatComposer.svelte');
		expect(composer).toContain('return holdComposerColophon(id);');
		expect(composer).toContain('composerRetention(retention, $stagePrivacySummary, effectiveChannel, ');
		expect(composer).toContain('<PrivacyBadge variant="colophon" input={privacyInput} room={roomFact} retention={keptSource} />');
	});

	test('phone DM bar: the name keeps its 96px; the seal, Voice call and Video call move into ⋯', () => {
		// Markup: on the phone the lead holds avatar + name only, the actions only search + ⋯.
		const dmLead = between(chatHeader, '<div class="stage-a__lead stage-a__lead--dm"', '{@render trail?.()}');
		expect(dmLead).toContain('{#if !phone}');
		expect(dmLead.indexOf('{#if !phone}')).toBeLessThan(dmLead.indexOf('<PrivacyBadge'));
		expect(dmLead.indexOf('{#if rulesTag}')).toBeGreaterThan(dmLead.indexOf('{#if !phone}'));
		const dmActions = between(chatHeader, '{@render trail?.()}\n\t<div class="stage-a__actions"', '{@render moreMenu()}');
		expect(dmActions).toContain('{#if isDM && peer && !phone}');
		// ⋯ on the phone: the privacy state first (every word from privacyState.ts), then the calls.
		const phoneRows = between(chatHeader, 'if (conversation && phone && privacy) {', "items.push({ id: 'phone-sep', type: 'separator' });");
		expect(phoneRows).toContain("id: 'privacy', label: words.word, icon: words.glyph, seal: true");
		expect(phoneRows).toContain("hint: short.sentence || undefined");
		expect(phoneRows).toContain('onSelect: () => void tick().then(openPrivacy)');
		expect(phoneRows).toContain("id: 'voice-call'");
		expect(phoneRows).toContain("id: 'video-call'");
		expect(phoneRows).toContain('disabled: callActive, hint: callWord');
		expect(phoneRows).not.toMatch(/'(Secure|End-to-end encrypted|E2EE)'/);
		// The same state the desktop chip shows opens the same popover, anchored to ⋯.
		expect(chatHeader).toContain('const privacy = $derived(conversation ? resolvePrivacySubject({ input: privacyInput }).state : null);');
		const popover = between(chatHeader, '{#if conversation && phone && privacy}', '{/if}');
		expect(popover).toContain('<PrivacyPopover');
		expect(popover).toContain('bind:open={privacyOpen}');
		expect(popover).toContain('anchor={privacyAnchor}');
		expect(popover).toContain('state={privacy}');
		expect(popover).toContain('retention={privacySummary}');
		expect(chatHeader).toContain('privacyAnchor = moreTrigger();');
		// The content-rules tag has no room either: ⋯'s one-line context carries it, and below an
		// 880 stage the row drops it before anything clips.
		expect(chatHeader).toContain('subheading={rulesTag ? `${rulesTag.label} · ${rulesTag.title}` : null}');
		expect(chatHeader).toContain('class="w-tag stage-a__chip stage-a__rules"');
		const rules = skinRules.find((rule) => rule.selectors.includes('.stage-bar .stage-a__rules'));
		expect(rules?.context).toEqual(['@container stage (max-width: 879.98px)']);
		expect(rules?.body).toContain('display: none');

		// CSS: the lead never shrinks below avatar + 96px (or its own width), and gives way first.
		const floor = skinRules.find((rule) => rule.selectors.includes('.stage-bar--phone .stage-a__lead:not(.stage-a__lead--component)'));
		expect(floor?.body).toContain('min-width: calc-size(max-content, min(size, var(--stage-lead-floor, 96px)))');
		// The DM floor is set where no stronger selector overrides it (the :not() rule sets none).
		expect(floor?.body).not.toContain('--stage-lead-floor:');
		expect(floor?.body).toContain('padding: 0');
		// The avatar steps aside when the stage cannot hold avatar + 96px name + "Chat" + search + ⋯
		// at the current text size (round 3: a px container query kept it at 150% text on a 360
		// phone and squeezed the label to "C…"). The floor follows the avatar.
		const dmFloor = skinRules.find((rule) => rule.selectors.includes('.stage-bar--phone .stage-a__lead--dm') && rule.context.length === 0);
		expect(dmFloor?.body).toContain('--stage-avatar: clamp(0px, (100cqi - 322px - 32.5px * var(--w-fs)) * 1000, 28px)');
		expect(dmFloor?.body).toContain('--stage-lead-floor: calc(var(--stage-avatar) * 38 / 28 + 96px)');
		expect(dmFloor?.body).toContain('gap: 0');
		const avatar = skinRules.find((rule) => rule.selectors.includes('.stage-bar--phone .stage-a__lead--dm > .stage-a__avatar'));
		expect(avatar?.body).toContain('width: var(--stage-avatar)');
		expect(avatar?.body).toContain('margin-inline-end: calc(var(--stage-avatar) * 10 / 28)');
		expect(avatar?.body).toContain('overflow: hidden');
		expect(skinRules.some((rule) => rule.context.includes('@container stage (max-width: 359.98px)'))).toBe(false);
		// Then the "Chat ▾" label takes an ellipsis; its full name is in the aria-label.
		const trigger = skinRules.find((rule) => rule.selectors.includes('.stage-bar .w-folio-trigger'));
		expect(trigger?.body).toContain('flex: 0 1 auto');
		expect(trigger?.body).toContain('min-width: calc(40px + 2em)');
		const label = skinRules.find((rule) => rule.selectors.includes('.stage-bar .w-folio-trigger__label'));
		expect(label?.body).toContain('text-overflow: ellipsis');
		expect(folio).toContain('aria-label={`${labelOf(activeView)}: ${$_(\'folio.label\')}`}');
		// The call state stays a live region on the phone: visually hidden, never display: none.
		const call = skinRules.find((rule) => rule.selectors.includes('.stage-bar--phone .stage-a__call'));
		expect(call?.body).toContain('clip-path: inset(50%)');
		expect(call?.body).not.toContain('display: none');
	});

	// Regression (round 3): the lead floor and the "Chat ▾" floor stayed in force while the phone
	// search was open, so row A needed ~525px on a 390 phone, overflowed, and the browser scrolled
	// the whole app sideways to keep the caret in view (⋯ off-screen, the stream cut at the left).
	test('phone search open takes row A: lead to its glyph, "Chat ▾" aside, the field fills, Close', () => {
		// Markup: both leads and both action rows carry the open state; the trail stays between.
		const leads = chatHeader.split('<div class="stage-a__lead').slice(1).map((lead) => lead.slice(0, lead.indexOf('>')));
		expect(leads.length).toBe(2);
		for (const lead of leads) expect(lead).toContain('class:stage-a__lead--searching={expanded}');
		expect(chatHeader.split('<div class="stage-a__actions" class:stage-a__actions--searching={expanded}>').length - 1).toBe(2);
		// The phone has no Esc key and a press outside keeps a typed query: Close is the way back,
		// inside the search box (so the outside-press handler ignores it), restoring focus to the icon.
		const control = between(chatHeader, '{#snippet searchControl()}', '{/snippet}');
		const close = between(control, '{#if phone}', '{/if}');
		expect(close).toContain('class="w-ibtn stage-search__close"');
		expect(close).toContain("aria-label={$_('common.close')}");
		expect(close).toContain('onclick={() => void closeSearch(true)}');
		expect(control.indexOf('stage-search__close')).toBeGreaterThan(control.indexOf('</label>'));
		expect(control.indexOf('stage-search__close')).toBeLessThan(control.indexOf('{:else}'));

		const find = (selector: string) => skinRules.find((rule) => rule.selectors.includes(selector) && rule.context.length === 0);
		// The lead releases its floor and keeps only its glyph; the name is visually hidden, not removed.
		const lead = find('.stage-bar--phone .stage-a__lead.stage-a__lead--searching');
		expect(lead?.body).toContain('flex: none');
		expect(lead?.body).toContain('min-width: auto');
		// Specificity: it must outrank the floor rule (:not() counts as a class) and come after it.
		expect(skin.indexOf('.stage-bar--phone .stage-a__lead.stage-a__lead--searching {')).toBeGreaterThan(
			skin.indexOf('.stage-bar--phone .stage-a__lead:not(.stage-a__lead--component) {')
		);
		const name = find('.stage-bar--phone .stage-a__lead--searching .stage-a__name');
		expect(name?.body).toContain('clip-path: inset(50%)');
		expect(name?.body).not.toContain('display: none');
		expect(find('.stage-bar--phone .stage-a__lead--searching > .stage-a__avatar')?.body).toContain('width: 28px');
		// "Chat ▾" steps aside (its trigger floor cannot fight the field).
		expect(find('.stage-bar--phone .stage-a__lead--searching + .w-folio-trigger')?.body).toContain('display: none');
		// The actions and the search box take the rest of the row; the field has no fixed width.
		const takes = find('.stage-bar--phone .stage-a__actions--searching');
		expect(takes?.selectors).toContain('.stage-bar--phone .stage-a__actions--searching > .stage-search');
		expect(takes?.body).toContain('flex: 1 1 0');
		expect(takes?.body).toContain('min-width: 0');
		const field = find('.stage-bar--phone .stage-search__field');
		expect(field?.body).toContain('flex: 1 1 0');
		expect(field?.body).toContain('width: auto');
		expect(field?.body).not.toMatch(/\bwidth: min\(/);
		// The results card spans the bar, inside the 16px gutters.
		const drop = find('.stage-bar--phone .stage-search__drop');
		expect(drop?.body).toContain('left: 16px');
		expect(drop?.body).toContain('right: 16px');
		const box = skinRules.filter((rule) => rule.selectors.length === 1 && rule.selectors[0] === '.stage-bar--phone .stage-a__actions--searching > .stage-search');
		expect(box.some((rule) => rule.body.includes('position: static'))).toBe(true);
		// Every open-search rule is phone-only: the desktop field keeps its 280px.
		for (const rule of skinRules.filter((entry) => entry.selectors.some((selector) => selector.includes('--searching')))) {
			for (const selector of rule.selectors) expect(selector.startsWith('.stage-bar--phone ')).toBe(true);
		}
		expect(find('.stage-bar .stage-search__field')?.body).toContain('width: min(280px, 40cqi)');
		// A narrow field ends its placeholder with an ellipsis instead of cutting a word.
		const ellipsis = find('.stage-bar .stage-search__field > input');
		expect(ellipsis?.selectors).toContain('.stage-bar .stage-search__field > input::placeholder');
		expect(ellipsis?.body).toContain('text-overflow: ellipsis');
	});

	// Regression (round 3): at 150% text on a 320 phone, the name's 96px floor, the "Chat ▾" floor,
	// search + ⋯ and two 12px gaps needed 323px of 320, so row A overflowed and the label read "C…".
	test('phone row A at large text: the gaps give first, so the name, a whole "Chat" and the actions fit', () => {
		const row = skinRules.find((rule) => rule.selectors.includes('.stage-bar--phone .stage-a') && rule.context.length === 0);
		expect(row?.body).toContain('gap: clamp(6px, 12px - (var(--w-fs) - 1) * 12px, 12px)');
		// 100% text keeps the desktop row's 12px rhythm, so the closed phone bar is unchanged there.
		const base = skinRules.find((rule) => rule.selectors.includes('.stage-bar .stage-a') && rule.context.length === 0);
		expect(base?.body).toContain('gap: 12px');
		// Same specificity: the phone rule must come after the base rule.
		expect(skin.indexOf('.stage-bar--phone .stage-a {')).toBeGreaterThan(skin.indexOf('.stage-bar .stage-a {'));
	});

	test('the masthead privacy summary is cleared when the header unmounts', () => {
		const effect = between(chatHeader, 'privacySummaryStore.set(value);', '});');
		expect(effect).toContain('if (get(privacySummaryStore) === value) privacySummaryStore.set(null);');
	});

	test('Mute in ⋯ reads the store value, so it says Unmute once the channel is muted', () => {
		expect(chatHeader).not.toContain('isServerChannelMuted');
		expect(chatHeader).toContain('const muted = $derived($activeServerSettings.mutedChannelIds?.includes(channelId) === true);');
		expect(chatHeader).not.toContain('menuSeed');
	});

	test('a failed DM privacy request is asked again instead of leaving "Checking privacy…" for good', () => {
		expect(chatHeader).toContain('retry = setTimeout(() => ask(attempt + 1), 2000 * 2 ** attempt);');
		expect(chatHeader).toContain('clearTimeout(retry);');
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
