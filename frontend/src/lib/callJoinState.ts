/**
 * Join and Listen in progress, and the failures they leave behind (design contract §7.1 busy,
 * §7.16 notice, §8.5: "Joining…" with aria-busy; on failure an inline notice under that row with
 * Retry). The Calls page reads this to render the busy button and the notice where the click
 * happened, instead of a failure that only reached the console.
 *
 * Pure state over a store: `run` takes the join itself as a callback, so this module never
 * touches sockets or media and is unit-tested on its own (callJoinState.test.ts).
 */
import { get, writable, type Readable } from 'svelte/store';

/** "Join" sends your mic there; "Listen" only receives. */
export type CallJoinMode = 'join' | 'listen';

/** Why a join failed, in words a member can act on (the raw error is logged, never shown). */
export type CallJoinFailure = 'offline' | 'failed';

export type CallJoinAttempt =
	| { mode: CallJoinMode; status: 'joining' }
	| { mode: CallJoinMode; status: 'failed'; failure: CallJoinFailure };

/** Thrown by a join callback when there is no server connection to join through. */
export class CallJoinOfflineError extends Error {
	constructor() {
		super('No server connection');
		this.name = 'CallJoinOfflineError';
	}
}

function isAbort(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export interface CallJoinTracker {
	/** channelId → the attempt in progress or the failure it left. */
	attempts: Readable<Readonly<Record<string, CallJoinAttempt>>>;
	/**
	 * Run one join. While it runs the room reads "joining"; a second click on the same room is
	 * ignored (resolves false). Success clears the room; a cancelled join (AbortError, e.g. the
	 * person left first) clears it silently; any other failure stays until `dismiss` or a retry.
	 */
	run(channelId: string, mode: CallJoinMode, start: () => Promise<unknown>): Promise<boolean>;
	/** Forget a failure (the notice's close) or an attempt that no longer matters. */
	dismiss(channelId: string): void;
}

export function createCallJoinTracker(onError?: (channelId: string, error: unknown) => void): CallJoinTracker {
	const attempts = writable<Readonly<Record<string, CallJoinAttempt>>>({});
	/** The newest run per room: a stale run never overwrites a newer one's state. */
	const runs = new Map<string, number>();
	let sequence = 0;

	function patch(channelId: string, attempt: CallJoinAttempt | null): void {
		attempts.update((current) => {
			if (attempt === null && !(channelId in current)) return current;
			const next = { ...current };
			if (attempt === null) delete next[channelId];
			else next[channelId] = attempt;
			return next;
		});
	}

	async function run(channelId: string, mode: CallJoinMode, start: () => Promise<unknown>): Promise<boolean> {
		if (get(attempts)[channelId]?.status === 'joining') return false;
		const token = ++sequence;
		runs.set(channelId, token);
		patch(channelId, { mode, status: 'joining' });
		try {
			await start();
			if (runs.get(channelId) !== token) return false;
			runs.delete(channelId);
			patch(channelId, null);
			return true;
		} catch (error) {
			if (runs.get(channelId) !== token) return false;
			runs.delete(channelId);
			if (isAbort(error)) {
				patch(channelId, null);
				return false;
			}
			onError?.(channelId, error);
			patch(channelId, { mode, status: 'failed', failure: error instanceof CallJoinOfflineError ? 'offline' : 'failed' });
			return false;
		}
	}

	function dismiss(channelId: string): void {
		runs.delete(channelId);
		patch(channelId, null);
	}

	return { attempts: { subscribe: attempts.subscribe }, run, dismiss };
}

/** The consequence line under "Couldn't join <room>": the cause in plain words and what is unchanged. */
export function joinFailureText(failure: CallJoinFailure, inOtherCalls: boolean): string {
	if (failure === 'offline') return 'You are not connected to the server. Check your connection, then try again.';
	return inOtherCalls ? 'The call did not start. Your other calls are unchanged.' : 'The call did not start. Try again in a moment.';
}
