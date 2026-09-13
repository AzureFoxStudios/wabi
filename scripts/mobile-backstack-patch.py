from pathlib import Path

model = Path('frontend/src/lib/mobileShellModel.ts')
model.write_text("""import type { Channel } from '$lib/socket';

export type MobileRootDestination = 'messages' | 'servers' | 'activity' | 'you';

export function isConversationChannel(channel: Pick<Channel, 'type'>): boolean {
\treturn channel.type === 'dm' || channel.type === 'group';
}

export function sumUnreadConversationCount(
\tchannelUnreadCounts: Record<string, number> | null | undefined,
\tchannels: Array<Pick<Channel, 'id' | 'type'>> | null | undefined
): number {
\tif (!channelUnreadCounts || !channels?.length) return 0;
\tconst conversationIds = new Set(
\t\tchannels.filter(isConversationChannel).map((channel) => channel.id)
\t);
\tlet total = 0;
\tfor (const [channelId, rawCount] of Object.entries(channelUnreadCounts)) {
\t\tif (!conversationIds.has(channelId)) continue;
\t\tconst count = Number(rawCount);
\t\tif (!Number.isFinite(count) || count <= 0) continue;
\t\ttotal += Math.floor(count);
\t}
\treturn total;
}

export function formatMobileUnreadBadge(count: number): string {
\tif (!Number.isFinite(count) || count <= 0) return '';
\tif (count > 99) return '99+';
\treturn String(Math.floor(count));
}

export function shouldRenderMobileNavigation(options: {
\tisMobile: boolean;
\tisInCall: boolean;
\tkeyboardOpen?: boolean;
}): boolean {
\treturn options.isMobile && !options.isInCall && !options.keyboardOpen;
}

export type MobileBackSurface =
\t| 'workspace'
\t| 'conversation'
\t| 'browse'
\t| 'overlay'
\t| 'server-switcher'
\t| 'settings';

export type MobileSurfaceState = {
\tworkspaceOpen: boolean;
\tconversationOpen: boolean;
\tbrowseOpen: boolean;
\trightOverlayOpen: boolean;
\tserverSwitcherOpen: boolean;
\tsettingsOpen: boolean;
};

const MOBILE_SURFACE_DISCOVERY_ORDER: MobileBackSurface[] = [
\t'workspace',
\t'conversation',
\t'browse',
\t'overlay',
\t'server-switcher',
\t'settings'
];

function surfaceIsActive(surface: MobileBackSurface, state: MobileSurfaceState): boolean {
\tswitch (surface) {
\t\tcase 'workspace': return state.workspaceOpen;
\t\tcase 'conversation': return state.conversationOpen;
\t\tcase 'browse': return state.browseOpen;
\t\tcase 'overlay': return state.rightOverlayOpen;
\t\tcase 'server-switcher': return state.serverSwitcherOpen;
\t\tcase 'settings': return state.settingsOpen;
\t}
}

export function reconcileMobileSurfaceStack(
\tprevious: readonly MobileBackSurface[],
\tstate: MobileSurfaceState
): MobileBackSurface[] {
\tconst next = previous.filter((surface) => surfaceIsActive(surface, state));
\tconst present = new Set(next);
\tfor (const surface of MOBILE_SURFACE_DISCOVERY_ORDER) {
\t\tif (surfaceIsActive(surface, state) && !present.has(surface)) {
\t\t\tnext.push(surface);
\t\t\tpresent.add(surface);
\t\t}
\t}
\tif (next.length === previous.length && next.every((surface, index) => surface === previous[index])) {
\t\treturn previous as MobileBackSurface[];
\t}
\treturn next;
}

export function nextMobileBackSurface(stack: readonly MobileBackSurface[]): MobileBackSurface | 'root' {
\treturn stack.length ? stack[stack.length - 1] : 'root';
}
""")

tests = Path('frontend/src/lib/mobileShellModel.test.ts')
tests.write_text("""import { describe, expect, test } from 'bun:test';
import {
\tformatMobileUnreadBadge,
\tnextMobileBackSurface,
\treconcileMobileSurfaceStack,
\tshouldRenderMobileNavigation,
\tsumUnreadConversationCount,
\ttype MobileSurfaceState
} from './mobileShellModel';

const closed: MobileSurfaceState = {
\tworkspaceOpen: false,
\tconversationOpen: false,
\tbrowseOpen: false,
\trightOverlayOpen: false,
\tserverSwitcherOpen: false,
\tsettingsOpen: false
};

describe('mobile shell model', () => {
\ttest('counts only DM and group unread messages', () => {
\t\tconst channels = [
\t\t\t{ id: 'dm-1', type: 'dm' },
\t\t\t{ id: 'group-1', type: 'group' },
\t\t\t{ id: 'general', type: 'text' }
\t\t] as any;
\t\texpect(sumUnreadConversationCount({ 'dm-1': 3, 'group-1': 2, general: 9 }, channels)).toBe(5);
\t});

\ttest('ignores invalid unread values', () => {
\t\tconst channels = [{ id: 'dm-1', type: 'dm' }] as any;
\t\texpect(sumUnreadConversationCount({ 'dm-1': -4, other: Number.NaN }, channels)).toBe(0);
\t});

\ttest('formats bounded unread badges', () => {
\t\texpect(formatMobileUnreadBadge(0)).toBe('');
\t\texpect(formatMobileUnreadBadge(8)).toBe('8');
\t\texpect(formatMobileUnreadBadge(100)).toBe('99+');
\t});

\ttest('keeps root navigation present except keyboard/call takeover', () => {
\t\texpect(shouldRenderMobileNavigation({ isMobile: true, isInCall: false })).toBe(true);
\t\texpect(shouldRenderMobileNavigation({ isMobile: true, isInCall: true })).toBe(false);
\t\texpect(shouldRenderMobileNavigation({ isMobile: true, isInCall: false, keyboardOpen: true })).toBe(false);
\t\texpect(shouldRenderMobileNavigation({ isMobile: false, isInCall: false })).toBe(false);
\t});

\ttest('Back follows actual opening order instead of fixed flag priority', () => {
\t\tlet stack = reconcileMobileSurfaceStack([], { ...closed, workspaceOpen: true });
\t\tstack = reconcileMobileSurfaceStack(stack, { ...closed, workspaceOpen: true, settingsOpen: true });
\t\tstack = reconcileMobileSurfaceStack(stack, {
\t\t\t...closed,
\t\t\tworkspaceOpen: true,
\t\t\tsettingsOpen: true,
\t\t\tserverSwitcherOpen: true
\t\t});
\t\texpect(stack).toEqual(['workspace', 'settings', 'server-switcher']);
\t\texpect(nextMobileBackSurface(stack)).toBe('server-switcher');
\t});

\ttest('closing a surface removes it without disturbing older surfaces', () => {
\t\tconst stack = reconcileMobileSurfaceStack(
\t\t\t['workspace', 'settings', 'server-switcher'],
\t\t\t{ ...closed, workspaceOpen: true, serverSwitcherOpen: true }
\t\t);
\t\texpect(stack).toEqual(['workspace', 'server-switcher']);
\t\texpect(nextMobileBackSurface(stack)).toBe('server-switcher');
\t});

\ttest('full-screen workspaces participate in Back before the root destination', () => {
\t\tconst stack = reconcileMobileSurfaceStack([], { ...closed, workspaceOpen: true });
\t\texpect(nextMobileBackSurface(stack)).toBe('workspace');
\t\texpect(nextMobileBackSurface([])).toBe('root');
\t});
});
""")

layout = Path('frontend/src/lib/components/MainLayout.svelte')
text = layout.read_text()

def replace_once(old: str, new: str, label: str) -> None:
    global text
    if old not in text:
        raise SystemExit(f'MainLayout {label} anchor missing')
    text = text.replace(old, new, 1)

replace_once(
    "\timport { formatMobileUnreadBadge, nextMobileBackSurface, sumUnreadConversationCount } from '$lib/mobileShellModel';",
    "\timport { formatMobileUnreadBadge, nextMobileBackSurface, reconcileMobileSurfaceStack, sumUnreadConversationCount, type MobileBackSurface, type MobileSurfaceState } from '$lib/mobileShellModel';",
    'mobile shell import'
)
replace_once(
    "\tlet swipePreviewTarget: 'none' | 'channels' | 'users' = 'none';\n\tlet swipePreviewOffsetX = 0;",
    "\tlet swipePreviewTarget: 'none' | 'channels' | 'users' = 'none';\n\tlet swipePreviewOffsetX = 0;\n\tlet mobileSurfaceStack: MobileBackSurface[] = [];",
    'stack state'
)
replace_once(
    """\tfunction openSettings(paymentSurface: 'connections' | null = null): void {
\t\trequestedSettingsPaymentSurface = paymentSurface;
\t\tshowSettings = true;
\t}
""",
    """\tfunction syncMobileSurfaceStack(state: MobileSurfaceState): void {
\t\tconst previous = mobileSurfaceStack;
\t\tconst next = reconcileMobileSurfaceStack(previous, state);
\t\tif (next === previous) return;
\t\tmobileSurfaceStack = next;

\t\tconst nextTop = nextMobileBackSurface(next);
\t\tif (nextTop !== 'root' && !previous.includes(nextTop)) {
\t\t\ttry {
\t\t\t\thistory.pushState({ wabiMobileSurface: nextTop }, '');
\t\t\t} catch {
\t\t\t\t/* History is best-effort; the in-app stack remains authoritative. */
\t\t\t}
\t\t}
\t}

\t$: if ($layoutStore.isMobile) {
\t\tsyncMobileSurfaceStack({
\t\t\tworkspaceOpen: $activeWorkspaceView !== 'messages',
\t\t\tconversationOpen: Boolean($layoutStore.centerDmChannelId),
\t\t\tbrowseOpen: $layoutStore.showMobileChannels,
\t\t\trightOverlayOpen: $layoutStore.rightPanelMode !== 'none',
\t\t\tserverSwitcherOpen: showServerSwitcher,
\t\t\tsettingsOpen: showSettings
\t\t});
\t} else if (mobileSurfaceStack.length) {
\t\tmobileSurfaceStack = [];
\t}

\tfunction openSettings(paymentSurface: 'connections' | null = null): void {
\t\trequestedSettingsPaymentSurface = paymentSurface;
\t\tshowSettings = true;
\t}
""",
    'openSettings'
)
replace_once(
    """\tfunction openMobileChat(): void {
\t\tlayoutStore.showMobileChannels.set(false);
\t\tlayoutStore.closeRightPanel();
\t\tactiveView = 'chat';
\t\tlayoutStore.closeDM();
\t\tscheduleMobileNavIdleHide();
\t}
""",
    """\tfunction openMobileChat(): void {
\t\tlayoutStore.showMobileChannels.set(false);
\t\tlayoutStore.closeRightPanel();
\t\tactiveView = 'chat';
\t\tlayoutStore.closeDM();
\t\tselectWorkspaceView('messages');
\t\tmobileSurfaceStack = [];
\t\tscheduleMobileNavIdleHide();
\t}
""",
    'openMobileChat'
)
replace_once(
    """\t\ttry {
\t\t\thistory.pushState({ wabiMobileSheet: 'browse' }, '');
\t\t} catch {
\t\t\t/* ignore */
\t\t}
""",
    '',
    'browse history'
)
replace_once(
    """\tfunction openMobileMessages(): void {
\t\tlayoutStore.showMobileChannels.set(false);
\t\tlayoutStore.closeRightPanel();
\t\tlayoutStore.closeDM();
\t\tactiveView = 'dm';
""",
    """\tfunction openMobileMessages(): void {
\t\tlayoutStore.showMobileChannels.set(false);
\t\tlayoutStore.closeRightPanel();
\t\tlayoutStore.closeDM();
\t\tselectWorkspaceView('messages');
\t\tactiveView = 'dm';
""",
    'messages'
)
replace_once(
    """\t\ttry {
\t\t\thistory.pushState({ wabiMobileSheet: 'you' }, '');
\t\t} catch {
\t\t\t/* ignore */
\t\t}
""",
    '',
    'you history'
)
replace_once(
    """\t\tconst surface = nextMobileBackSurface({
\t\t\tsettingsOpen: showSettings,
\t\t\tserverSwitcherOpen: showServerSwitcher,
\t\t\tbrowseOpen: $layoutStore.showMobileChannels,
\t\t\trightOverlayOpen: $layoutStore.rightPanelMode !== 'none',
\t\t\tconversationOpen: Boolean($layoutStore.centerDmChannelId)
\t\t});
""",
    "\t\tconst surface = nextMobileBackSurface(mobileSurfaceStack);\n",
    'Back resolver'
)
replace_once(
    """\t\t\tcase 'conversation':
\t\t\t\tlayoutStore.closeCenterDm();
\t\t\t\tactiveView = 'dm';
\t\t\t\treturn;
\t\t\tcase 'root':
""",
    """\t\t\tcase 'conversation':
\t\t\t\tlayoutStore.closeCenterDm();
\t\t\t\tactiveView = 'dm';
\t\t\t\treturn;
\t\t\tcase 'workspace':
\t\t\t\tselectWorkspaceView('messages');
\t\t\t\treturn;
\t\t\tcase 'root':
""",
    'workspace Back case'
)
replace_once(
    """
\t\tif (!channelsOpen && !usersOpen && swipeLeft) {
\t\t\tlayoutStore.showUsersTab();
\t\t\tlayoutStore.showMobileChannels.set(false);
\t\t\tresetTouchSwipe();
\t\t\treturn;
\t\t}

\t\tif (usersOpen && swipeRight) {
\t\t\tlayoutStore.closeRightPanel();
\t\t\tlayoutStore.showMobileChannels.set(false);
\t\t\tresetTouchSwipe();
\t\t\treturn;
\t\t}

\t\tif (!channelsOpen && !usersOpen && swipeRight) {
\t\t\tlayoutStore.showMobileChannels.set(true);
\t\t\tlayoutStore.closeRightPanel();
\t\t\tresetTouchSwipe();
\t\t\treturn;
\t\t}
""",
    """
\t\tif (usersOpen && swipeRight) {
\t\t\tlayoutStore.closeRightPanel();
\t\t\tlayoutStore.showMobileChannels.set(false);
\t\t\tresetTouchSwipe();
\t\t\treturn;
\t\t}
""",
    'central touchend fallback'
)
layout.write_text(text)
