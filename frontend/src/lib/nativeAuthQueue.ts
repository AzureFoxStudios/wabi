/** Ordered credential I/O per Authority. Newer intents retire queued work and
 * fence completion of an already-running bootstrap read. */
export class NativeAuthQueue {
	private tails = new Map<string, Promise<unknown>>();
	private revisions = new Map<string, number>();

	run<T>(scope: string, operation: (current: () => boolean) => Promise<T>): Promise<T | undefined> {
		const revision = (this.revisions.get(scope) ?? 0) + 1;
		this.revisions.set(scope, revision);
		const current = () => this.revisions.get(scope) === revision;
		const previous = this.tails.get(scope) ?? Promise.resolve();
		const pending = previous.catch(() => {}).then(() => current() ? operation(current) : undefined);
		this.tails.set(scope, pending);
		void pending.finally(() => {
			if (this.tails.get(scope) === pending) this.tails.delete(scope);
		}).catch(() => {});
		return pending;
	}
}

export const nativeAuthQueue = new NativeAuthQueue();
