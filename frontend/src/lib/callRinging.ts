/** A ring attempt is bounded even when the other account has no live socket. */
export const CALL_ANSWER_TIMEOUT_MS = 30_000;

export class OutgoingRingDeadline {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private key: string | null = null;

	arm(key: string, onNoAnswer: () => void, timeoutMs = CALL_ANSWER_TIMEOUT_MS): void {
		this.clear();
		this.key = key;
		this.timer = setTimeout(() => {
			if (this.key !== key) return;
			this.timer = null;
			this.key = null;
			onNoAnswer();
		}, timeoutMs);
	}

	clear(key?: string): void {
		if (key && this.key !== key) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.key = null;
	}
}

export function noAnswerNotice(name: string, group = false): string {
	return group
		? `No answer in ${name}. Members may be offline.`
		: `No answer from ${name}. They may be offline.`;
}
