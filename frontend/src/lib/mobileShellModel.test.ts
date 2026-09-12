import { describe, expect, test } from 'bun:test';
import {
	formatMobileUnreadBadge,
	nextMobileBackSurface,
	shouldRenderMobileNavigation,
	sumUnreadConversationCount
} from './mobileShellModel';

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

	test('back closes transient surfaces before leaving the conversation', () => {
		expect(nextMobileBackSurface({ settingsOpen: true, serverSwitcherOpen: true, browseOpen: true, rightOverlayOpen: true, conversationOpen: true })).toBe('settings');
		expect(nextMobileBackSurface({ settingsOpen: false, serverSwitcherOpen: true, browseOpen: true, rightOverlayOpen: true, conversationOpen: true })).toBe('server-switcher');
		expect(nextMobileBackSurface({ settingsOpen: false, serverSwitcherOpen: false, browseOpen: false, rightOverlayOpen: false, conversationOpen: true })).toBe('conversation');
	});
});
