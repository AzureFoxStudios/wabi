import { describe, expect, test } from 'bun:test';
import {
	formatMobileUnreadBadge,
	nextMobileBackSurface,
	pushMobileSurface,
	removeMobileSurface,
	shouldRenderMobileNavigation,
	sumUnreadConversationCount,
	syncMobileSurface,
	topMobileBackSurface
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

	test('ordered surface stack unwinds what was opened last', () => {
		let stack = pushMobileSurface([], 'conversation');
		stack = pushMobileSurface(stack, 'browse');
		stack = pushMobileSurface(stack, 'settings');
		expect(topMobileBackSurface(stack)).toBe('settings');
		stack = removeMobileSurface(stack, 'settings');
		expect(topMobileBackSurface(stack)).toBe('browse');
		stack = removeMobileSurface(stack, 'browse');
		expect(topMobileBackSurface(stack)).toBe('conversation');
	});

	test('reopening a surface moves it to the top without duplicates', () => {
		let stack = pushMobileSurface([], 'conversation');
		stack = pushMobileSurface(stack, 'browse');
		stack = pushMobileSurface(stack, 'conversation');
		expect(stack).toEqual(['browse', 'conversation']);
		expect(topMobileBackSurface(stack)).toBe('conversation');
	});

	test('visibility synchronization preserves unrelated surface ordering', () => {
		let stack = syncMobileSurface([], 'conversation', true);
		stack = syncMobileSurface(stack, 'overlay', true);
		stack = syncMobileSurface(stack, 'browse', true);
		stack = syncMobileSurface(stack, 'overlay', false);
		expect(stack).toEqual(['conversation', 'browse']);
		expect(topMobileBackSurface(stack)).toBe('browse');
	});

	test('full-screen workspace participates in Back order', () => {
		let stack = pushMobileSurface([], 'workspace');
		stack = pushMobileSurface(stack, 'server-switcher');
		expect(topMobileBackSurface(stack)).toBe('server-switcher');
		stack = removeMobileSurface(stack, 'server-switcher');
		expect(topMobileBackSurface(stack)).toBe('workspace');
	});

	test('legacy boolean helper remains compatible while shell migrates', () => {
		expect(nextMobileBackSurface({ settingsOpen: true, serverSwitcherOpen: true, browseOpen: true, rightOverlayOpen: true, conversationOpen: true })).toBe('settings');
		expect(nextMobileBackSurface({ settingsOpen: false, serverSwitcherOpen: true, browseOpen: true, rightOverlayOpen: true, conversationOpen: true })).toBe('server-switcher');
		expect(nextMobileBackSurface({ settingsOpen: false, serverSwitcherOpen: false, browseOpen: false, rightOverlayOpen: false, conversationOpen: true })).toBe('conversation');
	});
});
