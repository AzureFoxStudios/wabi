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

/** The actions whose failure the forum says in its own words, beside the action (§7.16). */
export type ForumAction = 'vote' | 'solution' | 'delete-reply' | 'remove-thread' | 'load-threads' | 'load-thread';

/**
 * A failure in plain words: the cause in one line and what is known about the result. The raw
 * message ("Failed to vote: Bad Request") is for the console, never the page. The copy never
 * claims nothing changed where the request may have reached the server: a dropped connection
 * can still have deleted a reply.
 */
export function forumActionCopy(action: ForumAction): { title: string; text: string } {
	switch (action) {
		case 'vote':
			return { title: 'Your vote was not confirmed', text: 'The score shown is the last one the server sent. Reload the thread before you vote again.' };
		case 'solution':
			return { title: 'Could not mark the solution', text: 'The server did not confirm it. Reload the thread to check before you try again.' };
		case 'delete-reply':
			return { title: 'Could not delete the reply', text: 'It may still be in the thread. Reload the thread to check before you try again.' };
		case 'remove-thread':
			return { title: 'Could not remove the thread', text: 'It may still be in the list. Reload the forum to check before you try again.' };
		case 'load-thread':
			return { title: 'Could not load this thread', text: 'Its replies may be missing here. Try again in a moment.' };
		case 'load-threads':
			return { title: 'Could not load threads', text: 'Check your connection, then try again.' };
	}
}

/**
 * A category rename moves one thread at a time, so a failure can land part-way. The copy says
 * how many threads already carry the new name, read back from the list after the attempt.
 */
export function forumRenameCopy(from: string, to: string, moved: number, total: number): { title: string; text: string } {
	if (moved <= 0) return { title: `Could not rename ${from}`, text: `Every thread is still in ${from}. Try again in a moment.` };
	const rest = total - moved;
	return {
		title: `Could not move every thread to ${to}`,
		text: `${moved} of ${total} ${total === 1 ? 'thread' : 'threads'} moved; ${rest === 1 ? 'one is' : `${rest} are`} still in ${from}. Rename ${from} again to move the rest.`
	};
}

/**
 * Who is offered "Mark as solution" on a reply: the thread's author or a moderator (`canPick`),
 * and never on a reply they wrote themselves (forum-wiki#8). A moderator may still mark the
 * thread author's own answer.
 */
export function forumCanMarkSolution(canPick: boolean, viewerId: number | undefined, replyAuthorId: number): boolean {
	return canPick && viewerId !== undefined && viewerId !== replyAuthorId;
}

/**
 * A vote button's state. The server adds every vote and cannot take one back or switch it, so a
 * vote cast from this view locks both buttons: the one cast stays pressed, the other is
 * unavailable, and pressing either again sends nothing. While the request runs both wait.
 */
export function forumVoteState(direction: 'up' | 'down', myVote: 'up' | 'down' | undefined, voting: boolean): { pressed: boolean; locked: boolean } {
	return { pressed: myVote === direction, locked: voting || myVote !== undefined };
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
