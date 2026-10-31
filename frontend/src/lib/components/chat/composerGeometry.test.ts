import { describe, expect, test } from 'bun:test';
import { followStreamBottom, scrollbarInset, streamScrollerFor } from './composerGeometry';

// Contract: design spec §7.20 (the field ends where the rules end; it grows upward), D20, §8.13.
// Review findings (w1-composer r1): at 1000x800 the field ended 8px past the day rule, because
// the rules sit inside a scroller with an 8px scrollbar; typing four lines hid the newest
// message under the field.

describe('the field ends where the stream rules end', () => {
	test('a classic scrollbar is measured; overlay bars and borders are not a scrollbar', () => {
		expect(scrollbarInset({ offsetWidth: 676, clientWidth: 668 })).toBe(8);
		expect(scrollbarInset({ offsetWidth: 676, clientWidth: 676 })).toBe(0);
		expect(scrollbarInset({ offsetWidth: 678, clientWidth: 668, borderLeft: 1, borderRight: 1 })).toBe(8);
		expect(scrollbarInset({ offsetWidth: 670, clientWidth: 676 })).toBe(0);
		expect(scrollbarInset({ offsetWidth: Number.NaN, clientWidth: 0 })).toBe(0);
	});

	test('the scroller is the stage stream beside the composer, never one inside it', () => {
		const composer = { tag: 'composer' } as unknown as Element;
		const messages = { tag: 'messages', contains: (node: unknown) => node === 'inside' } as unknown as HTMLElement;
		let asked = '';
		const stage = {
			querySelector: (selector: string) => {
				asked = selector;
				return messages;
			}
		};
		(composer as unknown as { closest: (s: string) => unknown }).closest = (selector: string) => {
			expect(selector).toContain('.chat-container');
			expect(selector).toContain('.dm-message-view');
			expect(selector).toContain('.dm-conversation');
			return stage;
		};
		expect(streamScrollerFor(composer)).toBe(messages);
		expect(asked).toContain(':scope > .messages');
		expect(asked).toContain('.dm-conversation-messages');
		expect(streamScrollerFor(null)).toBeNull();
		const orphan = { closest: () => null } as unknown as Element;
		expect(streamScrollerFor(orphan)).toBeNull();
	});

	test('composer.css adds the measured scrollbar to the right margin on every tier', async () => {
		const css = await Bun.file(new URL('../../../styles/surfaces/composer.css', import.meta.url)).text();
		expect(css).toContain('margin: 0 calc(var(--w-gutter) + var(--composer-scrollbar, 0px)) 0 var(--composer-lead);');
		expect(css).toContain('margin: 0 calc(12px + var(--composer-scrollbar, 0px)) 0 12px;');
	});
});

describe('a growing field keeps the newest message in view', () => {
	test('a stream at its newest message follows the field up', () => {
		// 1000 tall content, 600 tall scroller, at the bottom; the field grows by 72px.
		const scroller = { scrollHeight: 1000, clientHeight: 528, scrollTop: 400 };
		expect(followStreamBottom(scroller, 72)).toBe(true);
		expect(scroller.scrollTop).toBe(472);
	});

	test('a reader scrolled up into history is left where they are', () => {
		const scroller = { scrollHeight: 1000, clientHeight: 528, scrollTop: 200 };
		expect(followStreamBottom(scroller, 72)).toBe(false);
		expect(scroller.scrollTop).toBe(200);
	});

	test('shrinking, no change, or a stream already at the bottom does nothing', () => {
		const atBottom = { scrollHeight: 1000, clientHeight: 600, scrollTop: 400 };
		expect(followStreamBottom(atBottom, 0)).toBe(false);
		expect(followStreamBottom(atBottom, -40)).toBe(false);
		expect(followStreamBottom(atBottom, 24)).toBe(false);
		expect(atBottom.scrollTop).toBe(400);
	});
});
