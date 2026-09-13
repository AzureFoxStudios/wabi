import { describe, expect, test } from 'bun:test';
import {
	formatMobileUnreadBadge,
	nextMobileBackSurface,
	reconcileMobileSurfaceStack,
	shouldRenderMobileNavigation,
	sumUnreadConversationCount,
	type MobileSurfaceState
} from './mobileShellModel';

const closed: MobileSurfaceState = {
	workspaceOpen: false,
	conversationOpen: false,
	browseOpen: false,
	rightOverlayOpen: false,
	serverSwitcherOpen: false,
	settingsOpen: false
};

describe('mobile shell model', () => {
	test('counts only DM and group unread messages', () => {
		const channels = [
			{ id: 'dm-1', type: 'dm' },
			{ id: 'group-1', type: 'group' },
			{ id: 'general', type: 'text' }
		] as any;
		expect(sumUnreadConversationCount({ 'dm-1': 3, 'group-1': 2, general: 9 }, channels)).toBe(5);
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
});
