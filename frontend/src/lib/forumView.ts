/**
 * Presentation helpers for the forum surface (design contract §8.7). Pure functions, so the list
 * order, the vote labels, the byline's version note and the error copy are testable without
 * mounting ForumChannel.
 */
import type { ForumPost } from './forumStore';

export type ForumSort = 'newest' | 'top' | 'oldest';

/** The sort select's options, in menu order. "Newest" is the default. */
export const FORUM_SORT_OPTIONS: { value: ForumSort; label: string }[] = [
	{ value: 'newest', label: 'Newest' },
	{ value: 'top', label: 'Most votes' },
	{ value: 'oldest', label: 'Oldest' }
];

/** Microseconds (or milliseconds from older records) to epoch milliseconds. */
export function forumMillis(micros: number): number {
	return micros > 1e12 ? Math.floor(micros / 1000) : micros;
}

/** The score a post shows: up votes minus down votes. */
export function forumScore(post: Pick<ForumPost, 'votes_up' | 'votes_down'>): number {
	return (Number(post.votes_up) || 0) - (Number(post.votes_down) || 0);
}

export function forumPoints(score: number): string {
	return `${score} ${Math.abs(score) === 1 ? 'point' : 'points'}`;
}

/** "Upvote, 7 points": the vote button's accessible name carries the current score. */
export function forumVoteLabel(direction: 'up' | 'down', score: number): string {
	return `${direction === 'up' ? 'Upvote' : 'Downvote'}, ${forumPoints(score)}`;
}

/**
 * A sorted copy of the thread list. The server returns threads in storage-key order, which means
 * nothing to a reader, so the list always says how it is ordered. Ties keep the newer thread first
 * and then the incoming order, so the list never reshuffles between identical loads.
 */
export function sortForumThreads(threads: readonly ForumPost[], sort: ForumSort): ForumPost[] {
	const indexed = threads.map((thread, index) => ({ thread, index }));
	const created = (post: ForumPost) => forumMillis(post.created_at_micros);
	indexed.sort((a, b) => {
		let order = 0;
		if (sort === 'top') order = forumScore(b.thread) - forumScore(a.thread);
		if (sort === 'oldest') order = created(a.thread) - created(b.thread);
		if (order === 0 && sort !== 'oldest') order = created(b.thread) - created(a.thread);
		return order || a.index - b.index;
	});
	return indexed.map((entry) => entry.thread);
}

/** The byline's version note: "Original version" until the post is edited, then "Edited 3h ago". */
export function forumVersionNote(post: Pick<ForumPost, 'edited_at_micros'>, formatTime: (micros: number) => string): string {
	return post.edited_at_micros ? `Edited ${formatTime(post.edited_at_micros)}` : 'Original version';
}

/**
 * A store error in plain words (§7.16): the cause in one line and what is unchanged. The raw
 * message ("Failed to vote: Bad Request") is for the console, never the page.
 */
export function forumErrorCopy(raw: string | null | undefined): { title: string; text: string } | null {
	if (!raw) return null;
	const message = raw.toLowerCase();
	if (message.includes('vote')) return { title: 'Your vote was not counted', text: 'The score is unchanged. Try again in a moment.' };
	if (message.includes('solution')) return { title: 'Could not mark the solution', text: 'The thread is unchanged. Try again in a moment.' };
	if (message.includes('delete')) return { title: 'Could not remove that post', text: 'It is still in the thread. Try again in a moment.' };
	if (message.includes('update')) return { title: 'Could not save that change', text: 'The thread is unchanged. Try again in a moment.' };
	if (message.includes('create')) return { title: 'Could not post that', text: 'Your draft is still here. Try again in a moment.' };
	if (message.includes('posts')) return { title: 'Could not load this thread', text: 'The thread list is unchanged. Try again in a moment.' };
	if (message.includes('thread')) return { title: 'Could not load threads', text: 'Check your connection, then try again.' };
	return { title: 'Something did not go through', text: 'Nothing was changed. Try again in a moment.' };
}

/**
 * Show a category on list rows only when it tells the rows apart: the list is not filtered to
 * one category and the threads span more than one (a "Discussion" pill on every row says nothing).
 */
export function forumRowsShowCategory(categories: readonly string[], filtered: boolean): boolean {
	return !filtered && new Set(categories).size > 1;
}

/**
 * The category filter's rows, in the order categories are known: the ones threads use, the ones
 * added on this device (so a new one can be found before a thread uses it) and the applied one.
 * Unused defaults are left out; a filter that can only answer "No threads match" is noise.
 */
export function forumFilterCategories(
	categories: readonly string[],
	counts: ReadonlyMap<string, number>,
	custom: readonly string[],
	active: string | null
): string[] {
	return categories.filter((cat) => (counts.get(cat) || 0) > 0 || custom.includes(cat) || cat === active);
}
