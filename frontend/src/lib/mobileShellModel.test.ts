import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	COMPACT_RAIL_WIDTH,
	MOBILE_NAV_ORDER,
	formatMobileUnreadBadge,
	mobileNavDestination,
	mobileNavItems,
	nextMobileBackSurface,
	reconcileMobileSurfaceStack,
	shouldRenderMobileNavigation,
	sidebarFlowWidth,
	sumUnreadCommunityCount,
	sumUnreadConversationCount,
	type MobileNavPlace,
	type MobileSurfaceState
} from './mobileShellModel';

const closed: MobileSurfaceState = {
	workspaceOpen: false,
	conversationOpen: false,
	youOpen: false,
	browseOpen: false,
	rightOverlayOpen: false,
	serverSwitcherOpen: false,
	settingsOpen: false
};

const inChat: MobileNavPlace = {
	channelsOpen: false,
	youOpen: false,
	settingsOpen: false,
	activeView: 'chat',
	workspaceView: 'messages',
	conversationOpen: false
};

const LABELS = { chat: 'Chat', channels: 'Channels', dms: 'DMs', activity: 'Activity', you: 'You' };
const NO_COUNTS = { channelsUnread: 0, dmsUnread: 0, friendRequests: 0, activity: 0 };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Remove every match of one pattern, repeating until the text stops changing (one pattern per loop). */
function stripAll(text: string, pattern: RegExp): string {
	let previous = '';
	let current = text;
	while (current !== previous) {
		previous = current;
		current = current.replace(pattern, '');
	}
	return current;
}
const stripCssComments = (css: string) => stripAll(css, /\/\*[\s\S]*?\*\//);
const stripHtmlComments = (html: string) => stripAll(html, /<!--[\s\S]*?-->/);

/** [selector, body] for every innermost rule of a stylesheet (comments already removed). */
function rules(css: string): Array<[string, string]> {
	return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [match[1].trim(), match[2]]);
}
function ruleBody(css: string, selector: string): string {
	return rules(css)
		.filter(([sel]) => sel.split(',').map((part) => part.trim()).includes(selector))
		.map(([, body]) => body)
		.join('\n');
}

describe('mobile shell model', () => {
	test('counts only DM and group unread messages', () => {
		const channels = [
			{ id: 'dm-1', type: 'dm' },
			{ id: 'group-1', type: 'group' },
			{ id: 'general', type: 'text' }
		] as any;
		expect(sumUnreadConversationCount({ 'dm-1': 3, 'group-1': 2, general: 9 }, channels)).toBe(5);
	});

	test('the Channels count is the community channels only, so no message counts twice', () => {
		const channels = [
			{ id: 'dm-1', type: 'dm' },
			{ id: 'general', type: 'text' },
			{ id: 'guide', type: 'wiki' },
			{ id: 'lounge', type: 'voice' }
		] as any;
		const counts = { 'dm-1': 2, general: 3, guide: 1, lounge: 0, unknown: 7 };
		expect(sumUnreadCommunityCount(counts, channels)).toBe(4);
		expect(sumUnreadConversationCount(counts, channels)).toBe(2);
		expect(sumUnreadCommunityCount(null, channels)).toBe(0);
	});

	test('ignores invalid unread values', () => {
		const channels = [{ id: 'dm-1', type: 'dm' }] as any;
		expect(sumUnreadConversationCount({ 'dm-1': -4, other: Number.NaN }, channels)).toBe(0);
	});

	test('formats bounded unread badges', () => {
		expect(formatMobileUnreadBadge(0)).toBe('');
		expect(formatMobileUnreadBadge(8)).toBe('8');
		expect(formatMobileUnreadBadge(100)).toBe('99+');
	});

	test('keeps root navigation present except keyboard/call takeover', () => {
		expect(shouldRenderMobileNavigation({ isMobile: true, isInCall: false })).toBe(true);
		expect(shouldRenderMobileNavigation({ isMobile: true, isInCall: true })).toBe(false);
		expect(shouldRenderMobileNavigation({ isMobile: true, isInCall: false, keyboardOpen: true })).toBe(false);
		expect(shouldRenderMobileNavigation({ isMobile: false, isInCall: false })).toBe(false);
	});
});

describe('root navigation: five truthful destinations (§8.12)', () => {
	test('Chat · Channels · DMs · Activity · You, in that order; Friends lives in DMs', () => {
		expect([...MOBILE_NAV_ORDER]).toEqual(['chat', 'channels', 'dms', 'activity', 'you']);
		const items = mobileNavItems('chat', NO_COUNTS, LABELS);
		expect(items.map((item) => item.label)).toEqual(['Chat', 'Channels', 'DMs', 'Activity', 'You']);
		expect(items.map((item) => item.icon)).toEqual(['chat', 'hash', 'dm', 'bell', null]);
		expect(items.filter((item) => item.current).map((item) => item.id)).toEqual(['chat']);
	});

	test('Chat stays active while any channel workspace is in center stage', () => {
		for (const workspaceView of ['messages', 'voice', 'files', 'whiteboard', 'lore', 'documents', 'sheets', 'present']) {
			expect(mobileNavDestination({ ...inChat, workspaceView }), workspaceView).toBe('chat');
		}
		// Calls over a DM: the stage shows Calls, so Chat (not DMs) is current.
		expect(mobileNavDestination({ ...inChat, activeView: 'dm', workspaceView: 'voice' })).toBe('chat');
	});

	test('the nav marks what is on screen, not the last tap', () => {
		expect(mobileNavDestination({ ...inChat, workspaceView: 'notifications' })).toBe('activity');
		expect(mobileNavDestination({ ...inChat, activeView: 'dm' })).toBe('dms');
		expect(mobileNavDestination({ ...inChat, conversationOpen: true })).toBe('dms');
		// An open drawer or the You page covers the stage.
		expect(mobileNavDestination({ ...inChat, activeView: 'dm', channelsOpen: true })).toBe('channels');
		expect(mobileNavDestination({ ...inChat, workspaceView: 'notifications', youOpen: true })).toBe('you');
		expect(mobileNavDestination({ ...inChat, settingsOpen: true })).toBe('you');
		// Server home (from the drawer's community block) and the following feed are not nav places.
		expect(mobileNavDestination({ ...inChat, activeView: 'server', workspaceView: 'voice' })).toBeNull();
		expect(mobileNavDestination({ ...inChat, activeView: 'following' })).toBeNull();
	});

	test('badges: Channels unread, DMs unread plus friend requests, Activity; counts in the names', () => {
		const items = mobileNavItems('chat', { channelsUnread: 3, dmsUnread: 2, friendRequests: 1, activity: 2 }, LABELS);
		const byId = Object.fromEntries(items.map((item) => [item.id, item]));
		expect(byId.chat.badge).toBe('');
		expect(byId.channels.badge).toBe('3');
		expect(byId.dms.badge).toBe('3');
		expect(byId.activity.badge).toBe('2');
		expect(byId.you.badge).toBe('');
		expect(byId.channels.ariaLabel).toBe('Channels, 3 unread');
		expect(byId.dms.ariaLabel).toBe('DMs, 2 unread, 1 friend request');
		expect(byId.activity.ariaLabel).toBe('Activity, 2 need you');
		const quiet = mobileNavItems(null, NO_COUNTS, { ...LABELS, youDetail: 'Away' });
		expect(quiet.map((item) => item.ariaLabel)).toEqual(['Chat', 'Channels', 'DMs', 'Activity', 'You, Away']);
		expect(quiet.some((item) => item.current)).toBe(false);
		expect(mobileNavItems('dms', { ...NO_COUNTS, friendRequests: 120 }, LABELS)[2].badge).toBe('99+');
	});

	test('a locale can word the counts', () => {
		const items = mobileNavItems('activity', { ...NO_COUNTS, activity: 1, channelsUnread: 4 }, {
			...LABELS,
			unread: (count) => `${count} sin leer`,
			activityNeedsYou: (count) => `Actividad: ${count}`
		});
		expect(items[1].ariaLabel).toBe('Channels, 4 sin leer');
		expect(items[3].ariaLabel).toBe('Actividad: 1');
		expect(items[3].current).toBe(true);
	});
});

describe('Back follows the surfaces opened over the root', () => {
	test('Back follows actual opening order instead of fixed flag priority', () => {
		let stack = reconcileMobileSurfaceStack([], { ...closed, workspaceOpen: true });
		stack = reconcileMobileSurfaceStack(stack, { ...closed, workspaceOpen: true, settingsOpen: true });
		stack = reconcileMobileSurfaceStack(stack, {
			...closed,
			workspaceOpen: true,
			settingsOpen: true,
			serverSwitcherOpen: true
		});
		expect(stack).toEqual(['workspace', 'settings', 'server-switcher']);
		expect(nextMobileBackSurface(stack)).toBe('server-switcher');
	});

	test('discovers surfaces opened outside the root nav without losing existing order', () => {
		let stack = reconcileMobileSurfaceStack([], { ...closed, conversationOpen: true });
		stack = reconcileMobileSurfaceStack(stack, {
			...closed,
			conversationOpen: true,
			rightOverlayOpen: true
		});
		expect(stack).toEqual(['conversation', 'overlay']);
		expect(nextMobileBackSurface(stack)).toBe('overlay');
	});

	test('closing a surface removes it without disturbing older surfaces', () => {
		const stack = reconcileMobileSurfaceStack(
			['workspace', 'settings', 'server-switcher'],
			{ ...closed, workspaceOpen: true, serverSwitcherOpen: true }
		);
		expect(stack).toEqual(['workspace', 'server-switcher']);
		expect(nextMobileBackSurface(stack)).toBe('server-switcher');
	});

	test('full-screen workspaces participate in Back before the root destination', () => {
		const stack = reconcileMobileSurfaceStack([], { ...closed, workspaceOpen: true });
		expect(nextMobileBackSurface(stack)).toBe('workspace');
		expect(nextMobileBackSurface([])).toBe('root');
	});

	test('the You page is a surface: Back closes Settings first, then You', () => {
		let stack = reconcileMobileSurfaceStack([], { ...closed, youOpen: true });
		expect(stack).toEqual(['you']);
		stack = reconcileMobileSurfaceStack(stack, { ...closed, youOpen: true, settingsOpen: true });
		expect(nextMobileBackSurface(stack)).toBe('settings');
		stack = reconcileMobileSurfaceStack(stack, { ...closed, youOpen: true });
		expect(nextMobileBackSurface(stack)).toBe('you');
		expect(reconcileMobileSurfaceStack(stack, closed)).toEqual([]);
	});
});

describe('tablet bands (§8.13)', () => {
	test('769–1023px: the column rests on the 60px rail; the stored width is untouched', () => {
		expect(COMPACT_RAIL_WIDTH).toBe(60);
		expect(sidebarFlowWidth(280, true)).toBe(60);
		expect(sidebarFlowWidth(140, true)).toBe(60);
		// A sidebar the person closed stays closed.
		expect(sidebarFlowWidth(0, true)).toBe(0);
		// Outside the band the stored width decides.
		expect(sidebarFlowWidth(280, false)).toBe(280);
		expect(sidebarFlowWidth(-4, false)).toBe(0);
		expect(sidebarFlowWidth(Number.NaN, true)).toBe(0);
	});

	test('the band and the rail are their own queries; isMobile keeps its 768px meaning', () => {
		const states = read('./layoutStoreStates.ts');
		expect(states).toContain("export const isMobile = mediaFlag('(max-width: 768px)');");
		expect(states).toContain("export const isNavRail = mediaFlag('(min-width: 600px) and (max-width: 768px)');");
		expect(states).toContain("export const isCompactShell = mediaFlag('(min-width: 768.02px) and (max-width: 1023.98px)');");
		// The sidebar draws the band's tier; it never rewrites the synced width to get there.
		const sidebar = read('./components/ChannelSidebar.svelte');
		expect(sidebar).toContain('$: widthTier = (!$layoutStore.isMobile && $compactShellTier) || sidebarWidthTier(sidebarWidth, $layoutStore.isMobile);');
		const layout = read('./components/MainLayout.svelte');
		expect(layout).toContain('sidebarFlowWidth($layoutStore.channelSidebarWidth, compactShell)');
		expect(layout).not.toMatch(/channelSidebarWidth\.set\(\s*(?:60|COMPACT_RAIL_WIDTH)/);
	});
});

describe('the phone shell markup (MainLayout, MobileNav, YouPage)', () => {
	const layout = stripHtmlComments(read('./components/MainLayout.svelte'));
	const nav = stripHtmlComments(read('./components/MobileNav.svelte'));
	const you = stripHtmlComments(read('./components/YouPage.svelte'));

	test('one nav, from MobileNav; no grabber, no auto-hide, no sixth Friends tab', () => {
		expect(layout.split('<MobileNav ').length - 1).toBe(1);
		expect(layout).toContain('<MobileNav active={mobileNavActive} counts={mobileNavCounts} onselect={selectMobileDestination} />');
		for (const gone of ['mobile-nav-grabber', 'mobileNavIdleTimer', 'scheduleMobileNavIdleHide', 'handleMobileNavTouchStart', 'openMobileFriends', '<nav class="mobile-bottom-nav"']) {
			expect(layout, gone).not.toContain(gone);
		}
		// Friends stays reachable through DMs (the sidebar entry and the hub's segment).
		expect(layout).toContain('on:openFriends={openFriendsHub}');
	});

	test('the nav: aria-current on the place, 22px glyphs, ringed small badges outside the label', () => {
		expect(nav).toContain("aria-current={item.current ? 'page' : undefined}");
		expect(nav).toContain('aria-label={item.ariaLabel}');
		expect(nav).toContain('<Icon name={item.icon} size={22} />');
		expect(nav).toContain('class="w-badge w-badge--sm w-badge--ring mnav-badge"');
		// The badge is inside the icon wrapper, never inside the (ellipsised) label.
		const icon = nav.slice(nav.indexOf('<span class="mnav-icon"'), nav.indexOf('<span class="mnav-label"'));
		expect(icon).toContain('mnav-badge');
		// You is the person's avatar with presence.
		expect(nav).toContain('class="mnav-avatar"');
		expect(nav).toContain('mnav-presence--{presence}');
		expect(nav).not.toMatch(/<svg/);
	});

	test('the You page: a page in the stage with the nav kept, seven rows, a quiet confirmed Sign out', () => {
		expect(layout).toContain('{#if youPageShown}');
		expect(layout).toContain('<YouPage onopensettings={openSettingsPage} onopenservers={openServerSwitcher} onsignout={signOutFromYou} />');
		// The You tab no longer opens the Settings dialog over the nav.
		const openYou = layout.slice(layout.indexOf('function openMobileYou(): void {'), layout.indexOf('\n\t}\n', layout.indexOf('function openMobileYou(): void {')));
		expect(openYou).toContain('mobileYouOpen = true;');
		expect(openYou).not.toContain('openSettings');
		for (const key of ['settings.tabs.profile', 'settings.tabs.notifications', 'settings.tabs.appearance', 'settings.tabs.privacy', 'settings.language', 'shell.you.servers', 'shell.you.all_settings', 'settings.tabs.logout']) {
			expect(you, key).toContain(`'${key}'`);
		}
		expect(you).toContain('height: 52px;');
		expect(you).toContain('await confirmAction({');
		expect(you).not.toMatch(/danger:\s*true/);
		expect(you).not.toMatch(/you-row--quiet[^{]*\{[^}]*--w-danger/);
		// It is the first bar on screen, so it takes the top safe area.
		expect(you).toContain('padding: env(safe-area-inset-top, 0px) 16px 0;');
	});

	test('the stage shows no masthead under the You page', () => {
		const stack = layout.slice(layout.indexOf('<div class="chat-stack"'), layout.indexOf('<div class="chat-surface">'));
		expect(stack).toContain('{#if !youPageShown && ');
		expect(stack).toContain('<StageBar {activityBadge} onSelectView={handleWorkspaceViewSelect} />');
	});
});

describe('the phone shell stylesheets (§8.12, mobile#3, #7, #18)', () => {
	const skin = stripCssComments(read('../styles/surfaces/mobile.css'));
	const compact = stripCssComments(read('../styles/components/sidebar-compact.css'));
	const index = stripCssComments(read('../styles/components/mobile-shell.css'));
	const retired = stripCssComments(read('../styles/components/mobile-breakpoints.css'));
	const platform = stripCssComments(read('../styles/mobile.css'));

	test('one definition: mobile-shell.css is an index and mobile-breakpoints.css holds no rules', () => {
		expect(index.replace(/@import\s+'[^']+';/, '').trim()).toBe('');
		expect(index).toContain("@import '../surfaces/mobile.css';");
		expect(retired.trim()).toBe('');
	});

	test('roles only: no raw colors, legacy tokens, glass, gradients, glows or !important', () => {
		for (const [name, css] of [['surfaces/mobile.css', skin], ['sidebar-compact.css', compact]] as const) {
			expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], name).toEqual([]);
			expect(css.match(/\brgba?\(/g) ?? [], name).toEqual([]);
			expect(css.match(/var\(--(?:surface|text|accent-primary|border|color)-[\w-]*/g) ?? [], name).toEqual([]);
			expect(css, name).not.toMatch(/(?:linear|radial)-gradient\(/);
			expect(css, name).not.toMatch(/blur\(/);
			expect(css, name).not.toMatch(/drop-shadow/);
			expect(css, name).not.toContain('!important');
			expect(css, name).not.toMatch(/transition\s*:\s*all\b/);
			expect(css, name).not.toMatch(/\binfinite\b/);
		}
	});

	test('the bottom nav: --w-bg2, a hairline, 58 + max(14px, inset), labels 11px sans 500', () => {
		expect(skin).toContain('--mobile-nav-bar: 58px;');
		expect(skin).toContain('--mobile-nav-pad: max(14px, env(safe-area-inset-bottom, 0px));');
		const bar = ruleBody(skin, '.mobile-bottom-nav');
		expect(bar).toContain('background: var(--w-bg2);');
		expect(bar).toContain('border-top: var(--w-bw) solid var(--w-line);');
		expect(bar).toContain('grid-template-columns: repeat(5, minmax(0, 1fr));');
		expect(bar).not.toMatch(/box-shadow/);
		expect(ruleBody(skin, '.mobile-bottom-nav .mnav-tab')).toContain('font: 500 calc(11px * var(--w-fs)) / calc(14px * var(--w-fs)) var(--w-sans);');
		// Active: sig glyph, text label, the 24×2 sig mark.
		expect(ruleBody(skin, ".mobile-bottom-nav .mnav-tab[aria-current='page'] .mnav-icon")).toContain('color: var(--w-sig);');
		expect(ruleBody(skin, ".mobile-bottom-nav .mnav-tab[aria-current='page']")).toContain('color: var(--w-text);');
		const mark = ruleBody(skin, '.mobile-bottom-nav .mnav-tab::before');
		expect(mark).toContain('width: 24px;');
		expect(mark).toContain('height: 2px;');
		expect(mark).toContain('background: var(--w-sig);');
	});

	test('badges are never clipped and wear a 2px ring in the nav surface', () => {
		expect(ruleBody(skin, '.mobile-bottom-nav .mnav-icon')).toContain('overflow: visible;');
		expect(ruleBody(skin, '.mobile-bottom-nav .mnav-badge')).toContain('--w-badge-ring: var(--w-bg2);');
		// The ellipsis is the label's alone (the old `button span` rule clipped the badge).
		expect(ruleBody(skin, '.mobile-bottom-nav .mnav-label')).toContain('overflow: hidden;');
		expect(skin).not.toMatch(/\.mobile-bottom-nav button span/);
	});

	test('600–768px: a 72px rail; the drawer is min(88vw, 360px) with the scrim', () => {
		expect(skin).toContain('@media (min-width: 600px) and (max-width: 768px)');
		expect(skin).toContain('--mobile-rail-w: 72px;');
		expect(ruleBody(skin, '.app-container.nav-rail')).toContain('padding-inline-start: var(--mobile-rail-w);');
		expect(ruleBody(skin, '.channel-sidebar-container')).toContain('width: min(88vw, 360px);');
		expect(ruleBody(skin, '.mobile-panel-backdrop')).toContain('background: var(--w-scrim);');
	});

	test('769–1023px: the drawer hangs over the stage at the sidebar width, with the scrim', () => {
		const drawer = ruleBody(compact, ':root .app-container.compact-shell .channel-sidebar-container.compact-drawer > .channel-sidebar');
		expect(drawer).toContain('position: absolute;');
		expect(drawer).toContain('width: var(--w-sb-w);');
		expect(drawer).toContain('box-shadow: var(--w-shadow);');
		expect(ruleBody(compact, '.app-container.compact-shell .compact-scrim')).toContain('background: var(--w-scrim);');
	});

	test('a kit dialog or sheet covers the nav (its scrim dims it); drawers keep the nav in front', () => {
		for (const open of [':root:has(.base-modal-scrim) .mobile-bottom-nav', ':root:has(.sheet-scrim) .mobile-bottom-nav']) {
			expect(ruleBody(skin, open)).toContain('z-index: calc(var(--z-modal) - 2);');
		}
		expect(ruleBody(skin, '.mobile-bottom-nav')).toContain('z-index: var(--z-toast);');
	});

	test('no global button or input hammers (scoped rules only)', () => {
		for (const [name, css] of [['surfaces/mobile.css', skin], ['mobile.css', platform]] as const) {
			for (const [selector] of rules(css)) {
				for (const part of selector.split(',').map((piece) => piece.trim())) {
					expect(/^(?:button|\[role="button"\])(?::[\w-]+)?$/.test(part), `${name}: ${part}`).toBe(false);
				}
			}
		}
		expect(platform).not.toMatch(/button:active/);
		expect(platform).not.toMatch(/padding:\s*var\(--space-1\) var\(--space-2\)/);
	});
});
