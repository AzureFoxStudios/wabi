import { describe, expect, test } from 'bun:test';
import {
	FORUM_SORT_OPTIONS,
	forumActionCopy,
	forumCanMarkSolution,
	forumFilterCategories,
	forumMillis,
	forumPoints,
	forumRenameCopy,
	forumRowsShowCategory,
	forumScore,
	forumVersionNote,
	forumVoteLabel,
	forumVoteState,
	sortForumThreads,
	type ForumAction
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

describe('failures are said in plain words, per action (§7.16)', () => {
	const actions: ForumAction[] = ['vote', 'solution', 'delete-reply', 'remove-thread', 'load-thread', 'load-threads'];

	test('every action has a one-line cause and a consequence line', () => {
		for (const action of actions) {
			const copy = forumActionCopy(action);
			expect(copy.title.length, action).toBeGreaterThan(8);
			expect(copy.text.length, action).toBeGreaterThan(10);
			expect(copy.text.endsWith('.'), action).toBe(true);
		}
	});

	test('a delete that may have reached the server never claims nothing changed', () => {
		for (const action of ['delete-reply', 'remove-thread'] as const) {
			const { title, text } = forumActionCopy(action);
			expect(`${title} ${text}`).not.toMatch(/unchanged|nothing (was )?changed|still in the thread\./i);
			expect(text).toContain('may still be');
			expect(text).toMatch(/Reload/);
		}
	});

	test('a vote is not retried blindly: the server adds every vote it receives', () => {
		const { title, text } = forumActionCopy('vote');
		expect(title).toBe('Your vote was not confirmed');
		expect(text).toContain('Reload the thread before you vote again');
	});

	test('a rename that fails part-way says how far it got', () => {
		expect(forumRenameCopy('Ideas', 'Plans', 0, 3)).toEqual({ title: 'Could not rename Ideas', text: 'Every thread is still in Ideas. Try again in a moment.' });
		const partial = forumRenameCopy('Ideas', 'Plans', 2, 3);
		expect(partial.title).toBe('Could not move every thread to Plans');
		expect(partial.text).toBe('2 of 3 threads moved; one is still in Ideas. Rename Ideas again to move the rest.');
		expect(forumRenameCopy('Ideas', 'Plans', 1, 4).text).toContain('3 are still in Ideas');
		expect(`${partial.title} ${partial.text}`).not.toMatch(/unchanged/i);
	});
});

describe('who may mark a solution', () => {
	test('the thread author or a moderator, on other people\'s replies (forum-wiki#8)', () => {
		expect(forumCanMarkSolution(true, 1, 2)).toBe(true);
	});
	test('never on a reply the viewer wrote, the thread author\'s own answer included', () => {
		expect(forumCanMarkSolution(true, 1, 1)).toBe(false);
	});
	test('nobody else, and nobody without an account id', () => {
		expect(forumCanMarkSolution(false, 1, 2)).toBe(false);
		expect(forumCanMarkSolution(true, undefined, 2)).toBe(false);
	});
});

describe('a vote cannot be switched or taken back', () => {
	test('before voting both keys are free and unpressed', () => {
		expect(forumVoteState('up', undefined, false)).toEqual({ pressed: false, locked: false });
	});
	test('while the request runs both keys wait', () => {
		expect(forumVoteState('up', undefined, true)).toEqual({ pressed: false, locked: true });
		expect(forumVoteState('down', undefined, true)).toEqual({ pressed: false, locked: true });
	});
	test('after a vote the cast key stays pressed and both are locked', () => {
		expect(forumVoteState('up', 'up', false)).toEqual({ pressed: true, locked: true });
		expect(forumVoteState('down', 'up', false)).toEqual({ pressed: false, locked: true });
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
