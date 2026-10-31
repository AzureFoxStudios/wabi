/**
 * The call shell where it meets the rest of the shell (design contract §7.4, §7.26, §8.5, §8.12,
 * §9.4; layout contract: center stage owns the selected workspace):
 * - navigation that only MainLayout sees docks the call, and every navigation dock is a plain close
 *   (like the sidebar's text-channel click), while the call's Minimize stays the person's dismissal;
 * - the embedded call and the call foot are stage parts under a held peek; the call dialogs are not;
 * - the calling-diagnostics toggle exists only in dev builds;
 * - on phones the dock is the only action bar while a call is open in the stage;
 * - the connection badge keeps clear of the call foot and the dock;
 * - the dock's More menu clears the pill, has a record glyph, and disabled rows keep their reason.
 *
 * Components are read as source (the repo has no DOM test environment); the pure parts live in
 * $lib/callShell and ContextMenu's module script and are run for real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get } from 'svelte/store';
import { compile } from 'svelte/compiler';
import {
	CORNER_BADGE_ZONE,
	DOCK_MENU_GAP,
	callCornerClearance,
	cornerClearance,
	dockCallPanel,
	recordingNoteWords,
	reportCornerBar
} from './callShell';
import { ICONS, ICON_STROKE } from './components/ui/icons';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const mainLayout = read('./components/MainLayout.svelte');
const callModal = read('./components/CallModal.svelte');
const callControls = read('./components/CallControls.svelte');
const voiceView = read('./components/VoiceView.svelte');
const badge = read('./effects/ConnectionBadge.svelte');
const contextMenu = read('./components/context-menu/ContextMenu.svelte');
const menu = read('./components/ui/Menu.svelte');
const overlays = read('../styles/kit-overlays.css');
const dockCss = read('../styles/components/call-modal-part2.css');
const callingCore = read('./calling_impl_core.ts');

/** The text between the `{` that follows `start` and its matching `}` (string scan, no regex). */
function block(source: string, start: string): string {
	const at = source.indexOf(start);
	if (at < 0) throw new Error(`not found: ${start}`);
	const open = source.indexOf('{', at + start.length - 1);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		const char = source[index];
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, index);
		}
	}
	throw new Error(`unbalanced: ${start}`);
}

/** The opening tag (up to its first `>`) that starts with `prefix`. */
function openingTag(source: string, prefix: string): string {
	const at = source.indexOf(prefix);
	if (at < 0) throw new Error(`not found: ${prefix}`);
	return source.slice(at, source.indexOf('>', at) + 1);
}

describe('one docking semantics', () => {
	test('navigation closes the panel; only Minimize dismisses it', () => {
		const calls: string[] = [];
		const panel = { close: () => calls.push('close'), dismiss: () => calls.push('dismiss') };
		expect(dockCallPanel('navigation', panel)).toBe('closed');
		expect(calls).toEqual(['close']);
		expect(dockCallPanel('minimize', panel)).toBe('dismissed');
		expect(calls).toEqual(['close', 'dismiss']);
		// A caller that has no dismissal (MainLayout) can only close.
		const closeOnly: string[] = [];
		expect(dockCallPanel('navigation', { close: () => closeOnly.push('close') })).toBe('closed');
		expect(closeOnly).toEqual(['close']);
	});

	test('the runtime treats a plain close and a dismissal differently (what the semantics rely on)', () => {
		// A remote screen share reopens the call unless the person dismissed it during this call;
		// only dismissChannelCallPanel sets that, and the plain close does not.
		expect(block(callingCore, 'export function presentRemoteScreenShare(')).toContain('if (!callPanelDismissedByUser)');
		expect(block(callingCore, 'export function dismissChannelCallPanel(')).toContain('callPanelDismissedByUser = true');
		const close = block(callingCore, 'export function closeChannelCallPanel(');
		expect(close).toContain('channelCallPanelOpen.set(false)');
		expect(close).not.toContain('callPanelDismissedByUser');
	});

	test('CallModal: folio, channel, DM and Connection details dock for navigation; the header Minimize dismisses', () => {
		const navigation = block(callModal, 'function dockForNavigation(): void {');
		expect(navigation).toContain("callViewportMode = 'docked'");
		expect(navigation).toContain("dockCallPanel('navigation', { close: () => channelCallPanelOpen.set(false) })");
		expect(navigation).not.toContain('dismissChannelCallPanel');
		expect(block(callModal, 'function followStagePlace(')).toContain('if (next.dock) dockForNavigation();');
		const details = block(callModal, 'function followConnectionDetails(');
		expect(details).toContain('dockForNavigation()');
		expect(details).not.toContain('minimizeToDocked');

		const minimize = block(callModal, 'function minimizeToDocked(): void {');
		expect(minimize).toContain("dockCallPanel('minimize', { close: () => channelCallPanelOpen.set(false), dismiss: dismissChannelCallPanel })");
		const minimizeButton = callModal.slice(callModal.indexOf('aria-label="Minimize call"'), callModal.indexOf('aria-label="Minimize call"') + 120);
		expect(minimizeButton).toContain('on:click={minimizeToDocked}');
	});

	test('MainLayout docks for the navigation CallModal cannot see, with a plain close', () => {
		const dock = block(mainLayout, 'function dockCallForNavigation(): void {');
		expect(dock).toContain('if (!get(channelCallPanelOpen)) return;');
		expect(dock).toContain("dockCallPanel('navigation', { close: () => channelCallPanelOpen.set(false) })");
		expect(dock).not.toContain('dismissChannelCallPanel');
		expect(mainLayout).not.toContain('dismissChannelCallPanel');

		// The folio word (also the one already active), DMs, Friends and Server home.
		for (const start of [
			'function handleWorkspaceViewSelect(view: WorkspaceViewKey): void {',
			'function selectMessagesHub(closeConversation = false): void {',
			'function openFriendsHub(): void {',
			'function openServerHub(): void {'
		]) {
			expect(block(mainLayout, start).trimStart().startsWith('dockCallForNavigation();'), start).toBe(true);
		}
		// Any change of MainLayout's own place (Server home, the DM hub, the following feed), from
		// whichever path made it (sidebar rows, ServerHub, Activity, the phone back gesture).
		expect(mainLayout).toContain('let viewUnderCall = activeView;');
		const follow = block(mainLayout, '$: if (activeView !== viewUnderCall) {');
		expect(follow).toContain('viewUnderCall = activeView;');
		expect(follow).toContain('dockCallForNavigation();');
	});
});

describe('the call under a held peek', () => {
	test('coverStage keeps its parts; the call parts are known for focus and their inert is CallModal’s', () => {
		expect(mainLayout).toContain("const STAGE_PARTS = '.stage-bar, .chat-surface, .voice-live-strip';");
		expect(mainLayout).toContain("const CALL_STAGE_PARTS = '.call-shell.mode-embedded, .docked-bar';");
		expect(block(mainLayout, 'function inCoveredStage(element: Element): boolean {')).toContain('part.matches(CALL_STAGE_PARTS)');
		// The old comment claimed the whole call layer stayed live above the scrim.
		expect(mainLayout).not.toContain('The call layer is not covered');
		expect(mainLayout).not.toContain('paints above the scrim and stays live.');
		// What CALL_STAGE_PARTS names is what CallModal makes inert with .chat-surface.
		expect(openingTag(callModal, '<div\n\t\tclass="docked-bar"')).toContain('use:followStageInert={true}');
		const shell = openingTag(callModal, '<div\n\t\tclass="call-shell"');
		expect(shell).toContain("class:mode-embedded={callViewportMode === 'embedded'}");
		expect(shell).toContain("use:followStageInert={callViewportMode === 'embedded'}");
		// The incoming and outgoing call dialogs are not stage parts: nothing makes them inert.
		expect(callModal).not.toMatch(/<IncomingCallModal[^>]*followStageInert/);
		expect(callModal).not.toMatch(/<OutgoingCallModal[^>]*followStageInert/);
	});
});

describe('developer instruments stay out of member builds (§9.4)', () => {
	test('the calling-diagnostics toggle and overlay exist only in dev builds', () => {
		expect(mainLayout).toContain('const callDebugPanelEnabled = import.meta.env.DEV;');
		expect(mainLayout).not.toContain('const callDebugPanelEnabled = true');
		const gate = mainLayout.indexOf('{#if callDebugPanelEnabled && (callUiActive || showCallDebugPanel)}');
		expect(gate).toBeGreaterThan(0);
		expect(mainLayout.indexOf('class="call-debug-toggle"')).toBeGreaterThan(gate);
		expect(mainLayout.split('class="call-debug-toggle"').length - 1).toBe(1);
		expect(mainLayout.split('class="call-debug-overlay"').length - 1).toBe(1);
	});

	test('its close key is the registry x, not a text glyph', () => {
		const close = mainLayout.slice(mainLayout.indexOf('class="call-debug-close"'), mainLayout.indexOf('</button>', mainLayout.indexOf('class="call-debug-close"')));
		expect(close).toContain('<Icon name="x" size={14} />');
		expect(close).not.toContain('×');
		expect(close).not.toContain('✕');
	});
});

describe('phones: the dock is the only action bar while a call is open (§8.12)', () => {
	test('the legacy voice strip steps aside while the call is open, with no diagnostics grid or ASCII chevrons', () => {
		expect(mainLayout).toContain("{#if $layoutStore.isMobile && $callMode === 'channel' && $activeVoiceChannel && !$channelCallPanelOpen}");
		const strip = mainLayout.slice(mainLayout.indexOf('<div class="voice-channel-strip"'), mainLayout.indexOf('<div class="voice-channel-actions">'));
		for (const word of ['Ping', 'Jitter', 'Inbound Loss', 'Transport', 'voice-debug-grid', 'status-chevron', "'v' : '>'", 'aria-expanded']) {
			expect(strip, word).not.toContain(word);
		}
		// The header is a status line, not a diagnostics toggle, and never shows the lifecycle enum.
		expect(strip).not.toContain('<button');
		expect(strip).not.toContain('{$connectionState}');
		expect(mainLayout).toContain('$: stripConnectionWords = connectionWords($connectionState);');
		expect(mainLayout).not.toContain('showVoiceDebugDetails');
	});

	test('the phone bar drops Mic, Sound and ⋯ while a call is open in the stage; the title stays', () => {
		expect(voiceView).toContain('const phoneCallOpen = $derived($isMobile && $channelCallPanelOpen);');
		const actions = block(voiceView, 'const headerActions = $derived.by<StageHeaderAction[]>(() => {');
		expect(actions.trimStart().startsWith('if (!inCall) return [];\n\t\tif (phoneCallOpen) return [];')).toBe(true);
		expect(voiceView).toContain("setStageHeader(HEADER_OWNER, { view: 'voice', title: t('places.calls'), status: summary, actions: headerActions });");
	});
});

describe('the connection badge keeps clear of the call foot and the dock', () => {
	const phone = { width: 390, height: 844 };
	const box = (x: number, y: number, width: number, height: number) => ({ left: x, top: y, right: x + width, bottom: y + height });

	test('a bar in the bottom-right corner reports how far it rises; one elsewhere reports nothing', () => {
		// The minimized DM call foot on a phone (390×844): Leave sat under the badge.
		expect(cornerClearance(box(0, 784, 390, 60), phone)).toBe(60);
		// The embedded call's dock sits above the bottom nav, clear of the corner.
		expect(cornerClearance(box(61, 718, 267, 58), phone)).toBe(0);
		// Full window: the dock is 16px off the bottom and reaches the corner.
		expect(cornerClearance(box(61, 770, 267, 58), phone)).toBe(74);
		// Desktop: the call foot stops at a pinned panel, far from the corner; without one it reaches it.
		expect(cornerClearance(box(280, 880, 852, 80), { width: 1536, height: 960 })).toBe(0);
		expect(cornerClearance(box(280, 880, 1212, 80), { width: 1536, height: 960 })).toBe(80);
		// Nothing drawn, or off screen, is no obstacle.
		expect(cornerClearance(box(0, 0, 0, 0), phone)).toBe(0);
		expect(cornerClearance(box(0, 900, 390, 60), phone)).toBe(0);
		expect(CORNER_BADGE_ZONE.width).toBeGreaterThanOrEqual(140);
	});

	test('the badge stays above the highest bar, and returns when the bars go', () => {
		const foot = Symbol('foot');
		const dock = Symbol('dock');
		expect(get(callCornerClearance)).toBe(0);
		reportCornerBar(foot, 60);
		reportCornerBar(dock, 74);
		expect(get(callCornerClearance)).toBe(74);
		reportCornerBar(dock, 0);
		expect(get(callCornerClearance)).toBe(60);
		reportCornerBar(foot, 0);
		expect(get(callCornerClearance)).toBe(0);
	});

	test('the foot and the dock publish themselves; the badge yields when Online and rises otherwise', () => {
		expect(openingTag(callModal, '<div\n\t\tclass="docked-bar"')).toContain('use:cornerBar');
		expect(openingTag(callControls, '<div class="call-dock call-controls"')).toContain('use:cornerBar');
		expect(badge).toContain("import { callCornerClearance } from '$lib/callShell';");
		expect(badge).toContain("$: yieldToCall = callBarRise > 0 && status === 'online';");
		expect(badge).toContain('class:badge--yield={yieldToCall}');
		expect(badge).toContain('style:bottom={callBarRise > 0 ? `${callBarRise + 8}px` : undefined}');
		expect(block(badge, '.badge--yield {')).toContain('visibility: hidden;');
		// Lifted by the foot's 60px, the 18px badge ends above the foot (and its Leave) with 8px to spare.
		const rise = cornerClearance(box(0, 784, 390, 60), phone);
		expect(phone.height - (rise + 8)).toBeLessThanOrEqual(784 - 8);
	});
});

describe('the dock More menu (kit)', () => {
	let anchorGap: (gap: number | null | undefined) => number;
	let directory = '';
	const fileUrl = (relative: string) => pathToFileURL(new URL(relative, import.meta.url).pathname).href;

	/** Compile a component for the server with its imports pointed at real files. */
	function compileTo(file: string, relative: string, replacements: [RegExp, string][]): string {
		let code = compile(read(relative), { generate: 'server', filename: file }).js.code.replace(
			/(from|import) ['"](svelte[^'"]*)['"]/g,
			(_match, keyword, specifier) => `${keyword} ${JSON.stringify(import.meta.resolve(specifier))}`
		);
		for (const [pattern, target] of replacements) code = code.replace(pattern, `from ${JSON.stringify(target)}`);
		const path = join(directory, file.replace(/\.svelte$/, '.mjs'));
		writeFileSync(path, code);
		return pathToFileURL(path).href;
	}

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), 'wabi-call-menu-'));
		const icons = fileUrl('./components/ui/icons.ts');
		const icon = compileTo('Icon.svelte', './components/ui/Icon.svelte', [[/from ['"]\.\/icons['"]/g, icons]]);
		const compiled = compileTo('ContextMenu.svelte', './components/context-menu/ContextMenu.svelte', [
			[/from ['"]\$lib\/components\/ui\/icons['"]/g, icons],
			[/from ['"]\$lib\/actions\/portal['"]/g, fileUrl('./actions/portal.ts')],
			[/from ['"]\$lib\/components\/ui\/Icon\.svelte['"]/g, icon]
		]);
		({ anchorGap } = await import(compiled));
	});

	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	test('menus keep the 4px gap by default; a caller can ask for more', () => {
		expect(anchorGap(undefined)).toBe(4);
		expect(anchorGap(null)).toBe(4);
		expect(anchorGap(Number.NaN)).toBe(4);
		expect(anchorGap(-2)).toBe(4);
		expect(anchorGap(14)).toBe(14);
		expect(anchorGap(0)).toBe(0);
		// Both placements (below and flipped above) use the caller's gap.
		const place = block(contextMenu, 'function place() {');
		expect(place).toContain('const space = anchorGap(gap);');
		expect(place).not.toContain('GAP');
		expect(contextMenu).toContain('export let gap: number | undefined = undefined;');
		// Menu passes it through, and leaves it unset (the default) unless asked.
		expect(menu).toContain('gap = undefined,');
		expect(menu).toMatch(/<ContextMenu[\s\S]*?\{gap\}[\s\S]*?\/>/);
	});

	test('the dock More menu clears the pill by 6–8px', () => {
		const dock = block(dockCss, '.call-dock {');
		expect(dock).toContain('padding: 6px;');
		expect(dock).toContain('border: var(--w-bw) solid var(--w-line-strong);');
		// The key sits 6px (padding) + 1px (hairline) inside the pill's edge.
		const clearance = DOCK_MENU_GAP - 6 - 1;
		expect(clearance).toBeGreaterThanOrEqual(6);
		expect(clearance).toBeLessThanOrEqual(8);
		expect(callControls).toContain('gap={DOCK_MENU_GAP}');
	});

	test('Start recording has a record glyph: a static solid dot in currentColor', () => {
		const record = ICONS.record;
		expect(record).toBeDefined();
		const circles = record.split('<circle').slice(1);
		expect(circles.length).toBeGreaterThan(0);
		expect(record).not.toContain('<path');
		const radii = circles.map((circle) => {
			expect(circle).toContain('cx="12" cy="12"');
			return Number(circle.split('r="')[1].split('"')[0]);
		});
		radii.sort((a, b) => a - b);
		// Rings drawn with the registry stroke overlap one another and the centre, so the disc is solid.
		expect(radii[0]).toBeLessThanOrEqual(ICON_STROKE / 2 + 0.25);
		for (let index = 1; index < radii.length; index += 1) expect(radii[index] - radii[index - 1]).toBeLessThan(ICON_STROKE);
		// About 9px across in the menu's 16px slot.
		expect(((radii[radii.length - 1] + ICON_STROKE / 2) * 2 * 16) / 24).toBeGreaterThanOrEqual(8);
		expect(record).not.toMatch(/animate|fill=|style=/);
	});

	test('a disabled row dims its glyph and label; its reason stays at full --w-faint', () => {
		const row = block(overlays, ".w-menu__item:is(:disabled, [aria-disabled='true']),\n.w-menu [role^='menuitem'][aria-disabled='true'] {");
		expect(row).toContain('cursor: not-allowed;');
		expect(row).not.toContain('opacity');
		const dimmed = block(overlays, ":is(.w-menu__item, .w-menu [role^='menuitem']):is(:disabled, [aria-disabled='true']) > :not(.w-menu__hint, .menu-hint, .menu-text),");
		expect(dimmed).toContain('opacity: 0.45;');
		expect(overlays).toContain(":is(.w-menu__item, .w-menu [role^='menuitem']):is(:disabled, [aria-disabled='true']) > .menu-text > :not(.menu-hint) {");
		// The hint itself is never dimmed by any disabled rule.
		expect(block(overlays, '.w-menu__hint {')).toContain('color: var(--w-faint);');
		const disabledRules = overlays.split("[aria-disabled='true']").length - 1;
		expect(disabledRules).toBeGreaterThanOrEqual(4);
		// ContextMenu marks both hint placements with .menu-hint, so the rule finds them.
		expect(contextMenu).toContain('<span class="menu-sub menu-hint">{row.hint}</span>');
		expect(contextMenu).toContain('<span class="w-menu__hint menu-hint">{row.hint}</span>');
	});
});

describe('the recording note follows the state', () => {
	test('"starting" only before the readout counts a second, then "You\'re recording"', () => {
		expect(recordingNoteWords('recording', 0, '')).toBe('Recording is starting. Everyone in this call can see it.');
		expect(recordingNoteWords('recording', 600, '')).toBe('Recording is starting. Everyone in this call can see it.');
		expect(recordingNoteWords('recording', 1000, '')).toBe("You're recording. Everyone in this call can see it.");
		expect(recordingNoteWords('recording', 134000, '')).toBe("You're recording. Everyone in this call can see it.");
		expect(recordingNoteWords('recording', Number.NaN, '')).toBe('Recording is starting. Everyone in this call can see it.');
	});

	test('names from the presence echo win; saving and idle say their own words', () => {
		const echo = 'Theo Park is recording. Everyone in this call can see it.';
		expect(recordingNoteWords('recording', 134000, echo)).toBe(echo);
		expect(recordingNoteWords('idle', 0, echo)).toBe(echo);
		expect(recordingNoteWords('saving', 134000, echo)).toBe('Recording has stopped. Saving locally on this device.');
		expect(recordingNoteWords('idle', 0, '')).toBe('');
		expect(recordingNoteWords('error', 0, '')).toBe('');
	});

	test('CallModal words the note through recordingNoteWords with the running time', () => {
		expect(callModal).toContain('$: recordingPresenceCopy = recordingNoteWords(');
		expect(callModal).toContain('$callRecordingState.elapsedMs,');
		expect(callModal.split('Recording is starting').length - 1).toBe(0);
	});
});
