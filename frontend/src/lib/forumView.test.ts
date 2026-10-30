import { describe, expect, test } from 'bun:test';
import {
	FORUM_SORT_OPTIONS,
	forumErrorCopy,
	forumFilterCategories,
	forumMillis,
	forumPoints,
	forumRowsShowCategory,
	forumScore,
	forumVersionNote,
	forumVoteLabel,
	sortForumThreads
} from './forumView';
import type { ForumPost } from './forumStore';

// Contract: design spec §8.7 (forum list, article byline, votes), §7.16 (errors in plain words)
// and critiques forum-wiki#5 (the "views" count was the vote total), #8 (votes had no labels or
// state) and #9 (a category pill on every row).

function post(overrides: Partial<ForumPost>): ForumPost {
	return {
		post_id: 'p',
		thread_id: 'p',
		channel_id: 'c',
		author_user_id: 1,
		title: 'Thread',
		body: '',
		tags: [],
		is_thread_starter: true,
		is_solution: false,
		votes_up: 0,
		votes_down: 0,
		created_at_micros: 0,
		edited_at_micros: null,
		...overrides
	} as ForumPost;
}

describe('votes', () => {
	test('the score is up minus down, never their sum', () => {
		expect(forumScore({ votes_up: 7, votes_down: 2 })).toBe(5);
		expect(forumScore({ votes_up: 0, votes_down: 3 })).toBe(-3);
		expect(forumScore({ votes_up: Number.NaN, votes_down: 1 } as ForumPost)).toBe(-1);
	});

	test('each vote button names its direction and the current score', () => {
		expect(forumVoteLabel('up', 7)).toBe('Upvote, 7 points');
		expect(forumVoteLabel('down', 1)).toBe('Downvote, 1 point');
		expect(forumVoteLabel('down', -1)).toBe('Downvote, -1 point');
		expect(forumPoints(0)).toBe('0 points');
	});
});

describe('the byline says what version you are reading', () => {
	test('"Original version" until the post is edited, then when it was edited', () => {
		expect(forumVersionNote({ edited_at_micros: null } as ForumPost, () => 'never')).toBe('Original version');
		expect(forumVersionNote({ edited_at_micros: 42 } as ForumPost, (micros) => `t${micros}`)).toBe('Edited t42');
	});
});

describe('the thread list says how it is ordered', () => {
	const threads = [
		post({ post_id: 'a', created_at_micros: 2_000_000_000_000_000, votes_up: 1 }),
		post({ post_id: 'b', created_at_micros: 3_000_000_000_000_000, votes_up: 1 }),
		post({ post_id: 'c', created_at_micros: 1_000_000_000_000_000, votes_up: 9 })
	];
	const ids = (list: ForumPost[]) => list.map((thread) => thread.post_id);

	test('newest first by default, oldest first on request', () => {
		expect(FORUM_SORT_OPTIONS[0].value).toBe('newest');
		expect(ids(sortForumThreads(threads, 'newest'))).toEqual(['b', 'a', 'c']);
		expect(ids(sortForumThreads(threads, 'oldest'))).toEqual(['c', 'a', 'b']);
	});

	test('most votes first, ties newest first, and the input is left alone', () => {
		expect(ids(sortForumThreads(threads, 'top'))).toEqual(['c', 'b', 'a']);
		expect(ids(threads)).toEqual(['a', 'b', 'c']);
	});

	test('identical timestamps keep the incoming order, so loads never reshuffle', () => {
		const same = [post({ post_id: 'x' }), post({ post_id: 'y' }), post({ post_id: 'z' })];
		expect(ids(sortForumThreads(same, 'newest'))).toEqual(['x', 'y', 'z']);
		expect(ids(sortForumThreads(same, 'oldest'))).toEqual(['x', 'y', 'z']);
	});

	test('timestamps convert the way formatForumTime reads them (micros above 1e12)', () => {
		expect(forumMillis(1_700_000_000_000_000)).toBe(1_700_000_000_000);
		expect(forumMillis(1_700_000_000_123_999)).toBe(1_700_000_000_123);
		expect(forumMillis(900_000_000_000)).toBe(900_000_000_000);
	});
});

describe('list rows show a category only when it tells rows apart', () => {
	test('one category everywhere: no pill on every row', () => {
		expect(forumRowsShowCategory(['Discussion', 'Discussion'], false)).toBe(false);
	});
	test('mixed categories in an unfiltered list: shown', () => {
		expect(forumRowsShowCategory(['Discussion', 'Events'], false)).toBe(true);
	});
	test('filtered to one category: the toolbar already says it', () => {
		expect(forumRowsShowCategory(['Discussion', 'Events'], true)).toBe(false);
	});
});

describe('store errors become plain words', () => {
	test('no error, no notice', () => {
		expect(forumErrorCopy(null)).toBeNull();
		expect(forumErrorCopy('')).toBeNull();
	});

	test('the raw message is never shown, and each copy says what is unchanged', () => {
		const raw = ['Failed to vote: Bad Request', 'Failed to mark solution: 500', 'Failed to delete post', 'Failed to update thread', 'Failed to create post', 'Failed to load posts', 'Failed to load threads', 'Something odd: 418'];
		for (const message of raw) {
			const copy = forumErrorCopy(message);
			expect(copy).not.toBeNull();
			expect(`${copy?.title} ${copy?.text}`).not.toContain(message);
			expect(copy?.text.length).toBeGreaterThan(10);
		}
		expect(forumErrorCopy('Failed to vote: Bad Request')?.title).toBe('Your vote was not counted');
		expect(forumErrorCopy('Failed to create post')?.text).toContain('draft is still here');
	});
});

describe('the category filter lists what can be found', () => {
	const counts = new Map([['Discussion', 4], ['Events', 1]]);
	test('categories in use, ones added on this device and the applied one; unused defaults left out', () => {
		expect(forumFilterCategories(['General', 'Bug', 'Discussion', 'Events'], counts, [], null)).toEqual(['Discussion', 'Events']);
		expect(forumFilterCategories(['General', 'Bug', 'Discussion', 'Garden'], counts, ['Garden'], null)).toEqual(['Discussion', 'Garden']);
		expect(forumFilterCategories(['General', 'Bug', 'Discussion'], counts, [], 'General')).toEqual(['General', 'Discussion']);
	});
});
