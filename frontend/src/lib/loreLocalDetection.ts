/** Detection only: this controller has no pull, publish, stage, or file-write capability. */
export interface WatchStatus {
	subscription: string;
	revision: string;
	quietForMs: number;
	error: string | null;
}
export interface DetectionStatus { checking: boolean; paused: boolean; warning: string }
export interface DetectionHooks {
	active(): boolean;
	visible(): boolean;
	probe(): Promise<WatchStatus>;
	compare(scanLocal: boolean): Promise<void>;
	release(): Promise<void>;
	status(value: DetectionStatus): void;
	now?(): number;
}
export const DETECTION_TIMING = {
	poll: 1000, quiet: 750, maxDebounce: 5000, remote: 15000,
	fallback: 30000, audit: 300000, maxBackoff: 60000
} as const;

/** Single-flight detection, serialized with explicit user operations. */
export class LocalDetection {
	private hooks: DetectionHooks;
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private disposed = false;
	private started = false;
	private paused = false;
	private checking = false;
	private warning = '';
	private timer: ReturnType<typeof setTimeout> | undefined;
	private seen: string | null = null;
	private dirtySince: number | null = null;
	private lastScan = -Infinity;
	private nextRemote = 0;
	private retryAt = 0;
	private failures = 0;
	private probeRetryAt = 0;
	private probeWarning = '';
	private forceNext = true;

	constructor(hooks: DetectionHooks) { this.hooks = hooks; }
	private now() { return this.hooks.now?.() ?? Date.now(); }
	private current() { return !this.disposed && this.hooks.active(); }
	private report() {
		if (this.current()) this.hooks.status({ checking: this.checking, paused: this.paused, warning: this.warning });
	}
	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		this.pending++;
		const job = this.tail.then(() => {
			if (!this.current()) throw new Error('Local workspace is no longer active.');
			return operation();
		});
		this.tail = job.then(() => {}, () => {}).finally(() => { this.pending--; });
		return job;
	}
	/** User decisions queue behind an in-flight comparison, never run concurrently with it. */
	runManual<T>(operation: () => Promise<T>): Promise<T> { return this.exclusive(operation); }
	start() { if (!this.disposed) { this.started = true; this.schedule(0); } }
	private schedule(delay: number) {
		if (this.timer !== undefined) clearTimeout(this.timer);
		if (!this.started || this.paused || this.disposed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.tick().catch(() => {}).finally(() => this.schedule(DETECTION_TIMING.poll));
		}, delay);
	}
	setPaused(paused: boolean) {
		if (this.disposed) return;
		this.paused = paused;
		if (paused) { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
		else { this.forceNext = true; this.retryAt = 0; this.schedule(0); }
		this.report();
	}
	/** Focus, visibility and network-reconnect hints coalesce into one fresh comparison. */
	nudge() {
		if (this.disposed) return;
		this.forceNext = true; this.retryAt = 0;
		this.schedule(0);
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		// A late native start reply must be released too; wait for queued work to settle.
		await this.tail;
		await this.hooks.release();
	}
	async tick(): Promise<void> {
		if (!this.current()) { await this.dispose(); return; }
		if (this.paused || !this.hooks.visible() || this.pending || this.now() < this.retryAt) return;
		try {
			await this.exclusive(async () => {
				let probe: WatchStatus | null = null;
				if (this.now() >= this.probeRetryAt) {
					try {
						probe = await this.hooks.probe();
						this.probeWarning = probe.error ?? '';
						if (probe.error) this.probeRetryAt = this.now() + DETECTION_TIMING.fallback;
					} catch (error) {
						this.probeWarning = error instanceof Error ? error.message : String(error);
						this.probeRetryAt = this.now() + DETECTION_TIMING.fallback;
					}
				}
				if (!this.current() || this.paused || !this.hooks.visible()) return;
				const now = this.now();
				const stamp = probe ? JSON.stringify([probe.subscription, probe.revision]) : null;
				const dirty = stamp !== null && stamp !== this.seen;
				if (dirty && this.dirtySince === null) this.dirtySince = now;
				const settled = dirty && !!probe && (probe.quietForMs >= DETECTION_TIMING.quiet
					|| now - this.dirtySince! >= DETECTION_TIMING.maxDebounce);
				const fallback = !!this.probeWarning;
				const scan = this.forceNext || settled || now - this.lastScan >= (fallback ? DETECTION_TIMING.fallback : DETECTION_TIMING.audit);
				if (!scan && now < this.nextRemote) {
					this.warning = fallback ? `File watching unavailable; checking periodically. ${this.probeWarning}` : '';
					this.report(); return;
				}
				// Clear before awaiting: a focus hint received DURING comparison must not be lost.
				this.forceNext = false;
				this.checking = true; this.report();
				await this.hooks.compare(scan);
				if (!this.current()) return;
				if (scan) { this.seen = stamp; this.lastScan = this.now(); this.dirtySince = null; }
				this.nextRemote = this.now() + DETECTION_TIMING.remote;
				this.failures = 0; this.retryAt = 0;
				this.warning = fallback ? `File watching unavailable; checking periodically. ${this.probeWarning}` : '';
			});
		} catch (error) {
			if (this.current()) {
				this.failures++;
				this.retryAt = this.now() + Math.min(DETECTION_TIMING.maxBackoff, 2000 * 2 ** Math.min(this.failures, 5));
				this.warning = `Automatic check failed; your files and staging are unchanged. ${error instanceof Error ? error.message : String(error)}`;
			}
		} finally { this.checking = false; this.report(); }
	}
}
