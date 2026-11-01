import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Activity and Following (design contract §8.11, §7.16; critique mobile#8). Sources are read as
// text: a regression that brings back the second header band, boxed cards, a bar for unread, the
// duplicated Friends panel or legacy colours fails here. Styles are compared with comments
// removed by a loop that repeats one pattern until nothing changes (never a single-pass replace).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
};
const center = read('./components/NotificationsCenter.svelte');
const header = read('./components/ActivityStageHeader.svelte');
const following = read('./components/FollowingFeed.svelte');
const styleOf = (source: string) => stripComments(source.slice(source.indexOf('<style>')));

describe('Activity', () => {
	test('row A is "Activity" with All | Mentions | Follows; no second header band', () => {
		expect(center).toContain("setStageHeader(HEADER_OWNER, {");
		expect(center).toContain("view: 'notifications',");
		expect(center).toContain('component: ActivityStageHeader,');
		expect(center).toContain('onDestroy(() => clearStageHeader(HEADER_OWNER));');
		expect(header).toContain("{ value: 'all', label: label('All', counts.all) }");
		expect(header).toContain("{ value: 'mentions', label: label('Mentions', counts.mentions) }");
		expect(header).toContain("{ value: 'follows', label: label('Follows', counts.follows) }");
		for (const gone of ['activity-eyebrow', 'Your Wabi activity', 'Review requests, current-server conversations', 'activity-tabs']) expect(center).not.toContain(gone);
	});

	test('friend requests are rows with Accept and Decline; friends live in the DMs hub', () => {
		expect(center).toContain('await (accept ? acceptFriendship(requestId) : dismissFriendship(requestId));');
		expect(center).toContain('>Accept</button>');
		expect(center).toContain('>Decline</button>');
		expect(center).not.toContain('FriendsPanel');
	});

	test('56px rows: identity stamp, name in its ink, a 6px accent dot for unread (never a bar or card)', () => {
		const css = styleOf(center);
		expect(css).toMatch(/\.activity-row \{[^}]*min-height: 56px;/);
		expect(css).toMatch(/\.activity-row__name \{[^}]*color: var\(--ink, var\(--w-text\)\);/);
		expect(css).toMatch(/\.activity-row--unread \.activity-row__text::before \{[^}]*width: 6px; height: 6px;[^}]*background: var\(--w-accent\);/);
		expect(center).toContain("style={row.color ? $inkFor(row.color) : ''}");
		expect(css).not.toMatch(/border-left|border-inline-start/);
		expect(css).not.toMatch(/\.activity-row \{[^}]*border: var/);
	});

	test('empty states say what is missing and what happens next', () => {
		expect(center).toContain("title: 'Nothing needs you right now.'");
		expect(center).not.toContain('All caught up here');
	});
});

describe('both surfaces draw only with roles', () => {
	test('no legacy colour names, raw colours or glass', () => {
		for (const source of [center, following]) {
			const css = styleOf(source);
			expect(css).not.toMatch(/--surface-|--text-heading|--text-secondary|--accent-primary|--border-subtle|--shadow-|-rgb\b|rgba?\(/);
			expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(css).not.toMatch(/backdrop-filter|linear-gradient/);
		}
	});

	test('Following keeps its tools with honest words', () => {
		expect(following).toContain('on:click={() => cycleAlert(entry.channel.id)}');
		expect(following).toContain('on:click={() => unfollowChannel(entry.channel.id)}');
		expect(following).toContain('Previews of the latest messages, held in memory while Wabi is open.');
		expect(following).not.toContain('loading whole extra communities into RAM');
		expect(following).not.toContain('cached</span>');
	});
});
