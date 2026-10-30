/**
 * Keeps the composer colophon's room status fresh for a DM or group opened in the channel
 * stream (design contract §7.20, §9.2; AGENTS.md rule 13).
 *
 * Display only. The send path (`messageStore.sendMessage` → `encryptMessageForChannel`) asks the
 * server for the room status on every send and never reads what this module holds. The danger
 * this module guards against is the opposite one: a colophon that still says "Encryption
 * pending" after the member chose "send server-readable instead" somewhere else (the DM panel
 * beside the stream, their phone). The server only announces enable and rekey
 * (`e2ee-room-updated`), never that choice, so the status is asked again:
 *
 * - at once, from the cache, when another surface on this device already has a newer answer;
 * - every 5 seconds while the room is still pending (neither encrypted nor server-readable),
 *   the same cadence the DM views use;
 * - when the server says the room changed (`e2ee-room-updated` for this room) or the server's
 *   privacy policy changed (`privacy-policy-updated`);
 * - when the window regains focus, and when the composer asks (`refresh()`: field focus, after
 *   a send) while the room is not settled;
 * - after a failed request: 2 s, 4 s, 8 s, then on the next of the triggers above.
 *
 * The socket is looked up on every poll and rebound when the connection object changes (a
 * reconnect, a server switch), so no listener stays on a socket that no longer delivers.
 */

/** The room-status facts this module reads; the full `E2eeRoomStatus` satisfies it. */
export type ComposerRoomStatus = {
	enabled?: boolean | null;
	pendingDefault?: boolean | null;
	serverReadableSelected?: boolean | null;
};

export type RoomStatusSocket = {
	on(event: string, handler: (payload?: { channelId?: string }) => void): unknown;
	off(event: string, handler: (payload?: { channelId?: string }) => void): unknown;
};

type FocusTarget = {
	addEventListener(type: 'focus', listener: () => void): void;
	removeEventListener(type: 'focus', listener: () => void): void;
};

type Timers = {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(handler: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
};

export type RoomStatusWatchOptions<S extends ComposerRoomStatus> = {
	channelId: string;
	/** Fetch the room status from the server (and update the shared cache). */
	refresh: (channelId: string) => Promise<S>;
	/** The shared per-device cache other surfaces write to (dmE2eeState). */
	cached?: (channelId: string) => S | null;
	/** The current socket; looked up again on every poll. */
	socket: () => RoomStatusSocket | null | undefined;
	onStatus: (status: S) => void;
	focusTarget?: FocusTarget | null;
	pollMs?: number;
	/** `refresh()` calls closer together than this after an answer are skipped. */
	minGapMs?: number;
	timers?: Timers;
	now?: () => number;
};

export type RoomStatusWatch = {
	/** Ask again unless the room is settled or an answer just arrived (field focus, after a send). */
	refresh(): void;
	dispose(): void;
};

export const ROOM_STATUS_POLL_MS = 5000;
const ROOM_STATUS_MIN_GAP_MS = 1500;
const RETRY_DELAYS_MS = [2000, 4000, 8000];

/** Encrypted or explicitly server-readable: only the server's own events change it from here. */
export function roomStatusSettled(status: ComposerRoomStatus | null | undefined): boolean {
	return Boolean(status && (status.enabled === true || status.serverReadableSelected === true));
}

const defaultTimers: Timers = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (handler, ms) => setInterval(handler, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export function watchComposerRoomStatus<S extends ComposerRoomStatus>(options: RoomStatusWatchOptions<S>): RoomStatusWatch {
	const id = options.channelId;
	const timers = options.timers ?? defaultTimers;
	const now = options.now ?? Date.now;
	const minGap = options.minGapMs ?? ROOM_STATUS_MIN_GAP_MS;
	let live = true;
	let last: S | null = null;
	let answeredAt = -Infinity;
	let inFlight = false;
	let askAgain = false;
	let failures = 0;
	let retry: unknown;

	const apply = (status: S) => {
		if (!live) return;
		last = status;
		options.onStatus(status);
	};
	const adoptCache = () => {
		const cached = options.cached?.(id) ?? null;
		if (cached && cached !== last) apply(cached);
	};
	const ask = () => {
		if (!live) return;
		if (inFlight) {
			askAgain = true;
			return;
		}
		inFlight = true;
		timers.clearTimeout(retry);
		retry = undefined;
		options
			.refresh(id)
			.then(
				(status) => {
					failures = 0;
					answeredAt = now();
					apply(status);
				},
				() => {
					// Fail closed: the colophon keeps what it had ("Checking privacy…" before any
					// answer), never a guess.
					if (!live || failures >= RETRY_DELAYS_MS.length) return;
					retry = timers.setTimeout(ask, RETRY_DELAYS_MS[failures]);
					failures += 1;
				}
			)
			.finally(() => {
				inFlight = false;
				if (live && askAgain) {
					askAgain = false;
					ask();
				}
			});
	};

	const onRoomUpdate = (payload?: { channelId?: string }) => {
		if (payload?.channelId === id) ask();
	};
	const onPolicyUpdate = () => ask();
	let bound: RoomStatusSocket | null = null;
	/** True when a new socket was bound (its events may have been missed: ask). */
	const bindSocket = (): boolean => {
		const next = options.socket() ?? null;
		if (next === bound) return false;
		bound?.off('e2ee-room-updated', onRoomUpdate);
		bound?.off('privacy-policy-updated', onPolicyUpdate);
		bound = next;
		bound?.on('e2ee-room-updated', onRoomUpdate);
		bound?.on('privacy-policy-updated', onPolicyUpdate);
		return bound !== null;
	};

	const onFocus = () => ask();
	options.focusTarget?.addEventListener('focus', onFocus);

	adoptCache();
	bindSocket();
	ask();
	const poll = timers.setInterval(() => {
		if (!live) return;
		if (bindSocket()) {
			ask();
			return;
		}
		adoptCache();
		if (last && !roomStatusSettled(last)) ask();
	}, options.pollMs ?? ROOM_STATUS_POLL_MS);

	return {
		refresh() {
			if (!live) return;
			adoptCache();
			if (roomStatusSettled(last)) return;
			if (!inFlight && now() - answeredAt < minGap) return;
			ask();
		},
		dispose() {
			if (!live) return;
			live = false;
			timers.clearTimeout(retry);
			timers.clearInterval(poll);
			bound?.off('e2ee-room-updated', onRoomUpdate);
			bound?.off('privacy-policy-updated', onPolicyUpdate);
			bound = null;
			options.focusTarget?.removeEventListener('focus', onFocus);
		}
	};
}
