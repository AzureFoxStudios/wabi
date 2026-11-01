/**
 * The typing row above the composer (design contract §7.17): "**Iris** is writing",
 * "**Iris** and **Leo** are writing", "Several people are writing".
 *
 * - `typingSegments` splits the localized sentence around the names so the row can set each
 *   name in 500 --w-mute without hand-building the grammar of any language.
 * - `createTypingAnnouncer` feeds the polite live region: one announcement per interval (10s),
 *   the latest wording once the interval is over, nothing when nobody is writing any more.
 */

export type TypingSegment = { text: string; name?: boolean };

type Translate = (key: string, options?: { values?: Record<string, string> }) => string;

// Private-use characters never occur in a username and survive any translation template.
const MARK_A = '';
const MARK_B = '';

function split(sentence: string, names: Record<string, string>): TypingSegment[] {
	const segments: TypingSegment[] = [];
	let rest = sentence;
	while (rest.length) {
		let at = -1;
		let mark = '';
		for (const candidate of Object.keys(names)) {
			const index = rest.indexOf(candidate);
			if (index !== -1 && (at === -1 || index < at)) {
				at = index;
				mark = candidate;
			}
		}
		if (at === -1) {
			segments.push({ text: rest });
			break;
		}
		if (at > 0) segments.push({ text: rest.slice(0, at) });
		segments.push({ text: names[mark], name: true });
		rest = rest.slice(at + mark.length);
	}
	return segments;
}

/** The row's words, with the names marked. Empty when nobody is writing. */
export function typingSegments(names: string[], t: Translate): TypingSegment[] {
	const people = names.filter(Boolean);
	if (people.length === 0) return [];
	if (people.length === 1) {
		return split(t('chat.typing.one', { values: { user: MARK_A } }), { [MARK_A]: people[0] });
	}
	if (people.length === 2) {
		return split(t('chat.typing.two', { values: { user1: MARK_A, user2: MARK_B } }), {
			[MARK_A]: people[0],
			[MARK_B]: people[1]
		});
	}
	// Three or more: the sentence names nobody ("Several people are writing").
	return [{ text: t('chat.typing.many') }];
}

export type TypingAnnouncer = {
	/** The row's current words ('' when nobody is writing). */
	update(text: string): void;
	dispose(): void;
};

/**
 * Throttles what a polite live region says: the first change is spoken at once, later ones at
 * most once per `intervalMs`, always the latest wording; a row that empties is never spoken.
 */
export function createTypingAnnouncer(options: {
	intervalMs?: number;
	announce: (text: string) => void;
	now?: () => number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}): TypingAnnouncer {
	const interval = options.intervalMs ?? 10_000;
	const now = options.now ?? (() => Date.now());
	const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	let lastAt = -Infinity;
	let spoken = '';
	let pending: string | null = null;
	let timer: unknown = null;

	const speak = (text: string) => {
		lastAt = now();
		spoken = text;
		pending = null;
		options.announce(text);
	};
	const flush = () => {
		timer = null;
		if (pending && pending !== spoken) speak(pending);
		else pending = null;
	};

	return {
		update(text) {
			if (!text) {
				// Nobody is writing: drop what was queued and clear the region without a word.
				pending = null;
				if (timer !== null) clearTimer(timer);
				timer = null;
				if (spoken) {
					spoken = '';
					options.announce('');
				}
				return;
			}
			if (text === spoken) {
				pending = null;
				return;
			}
			const wait = lastAt + interval - now();
			if (wait <= 0 && timer === null) {
				speak(text);
				return;
			}
			pending = text;
			if (timer === null) timer = setTimer(flush, Math.max(0, wait));
		},
		dispose() {
			if (timer !== null) clearTimer(timer);
			timer = null;
			pending = null;
		}
	};
}
