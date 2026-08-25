/**
 * Mid-call transport watchdog (calling-audit T3).
 *
 * Before: if the wabidb relay died mid-call you stayed broken until the
 * drain/reconnect heal happened to fire — no demotion, no promotion, no
 * health signal anywhere.
 *
 * Now:
 *  - Relay disconnect ⇒ one bounded reconnect attempt (the underlying client
 *    already retries; the watchdog waits a grace window and checks whether it
 *    actually recovered) ⇒ if still dead, DEMOTE to the next chain link.
 *  - While demoted on a fallback, the primary is probed periodically; on
 *    recovery the call is PROMOTED back (auto for listen-only contexts,
 *    surfaced for explicit user action otherwise — the caller decides via the
 *    onPromote callback's return).
 *
 * The watchdog owns callTransportState.checkedAt freshness so stale badges
 * are distinguishable from live ones.
 */
import { get } from 'svelte/store';
import { callTransportState } from './callingStateStores';
import { chainForMode } from './callingFallback';
import type { EffectiveCallTransport } from './mediaRuntime';

export interface WatchdogOptions {
	/** Current stored transport mode ('auto' | 'wabidb' | ...). */
	mode: string;
	/** The transport the call is currently riding. */
	active: EffectiveCallTransport;
	/** Attempt to establish `transport` anew. Throws on failure. */
	connect: (transport: EffectiveCallTransport) => Promise<void>;
	/** Tear down a failed/demoted transport cleanly. */
	disconnectCurrent?: () => Promise<void>;
	/** True when auto-promotion back to the primary is acceptable. */
	autoPromoteOk?: () => boolean;
	/** Grace window before declaring the primary dead (ms). */
	graceMs?: number;
	/** Probe interval while demoted (ms). */
	probeIntervalMs?: number;
}

export type WatchdogState = 'monitoring' | 'demoting' | 'demoted' | 'promoting' | 'stopped';

const GRACE_DEFAULT_MS = 8000;
const PROBE_DEFAULT_MS = 30000;

class TransportWatchdog {
	private state: WatchdogState = 'stopped';
	private timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
	private opts: WatchdogOptions | null = null;
	private primary: EffectiveCallTransport = 'wabidb';
	private current: EffectiveCallTransport = 'wabidb';
	private transitionListeners: ((s: WatchdogState, t: EffectiveCallTransport) => void)[] = [];

	get status(): WatchdogState {
		return this.state;
	}

	get riding(): EffectiveCallTransport {
		return this.current;
	}

	onTransition(cb: (s: WatchdogState, t: EffectiveCallTransport) => void): void {
		this.transitionListeners.push(cb);
	}

	private emit(s: WatchdogState): void {
		this.state = s;
		for (const cb of this.transitionListeners) {
			try { cb(s, this.current); } catch { /* listener errors never kill the watchdog */ }
		}
	}

	start(opts: WatchdogOptions): void {
		this.stop();
		this.opts = opts;
		this.primary = chainForMode(opts.mode)[0];
		this.current = opts.active;
		this.emit('monitoring');
		callTransportState.update((st) => ({ ...st, checkedAt: Date.now() }));
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.opts = null;
		this.emit('stopped');
	}

	/**
	 * Called by the relay layer the moment the transport drops. Runs the
	 * grace/reconnect probe; demotes if the transport does not come back.
	 */
	handleDisconnect(): void {
		const opts = this.opts;
		if (!opts || this.state === 'stopped' || this.state === 'demoting' || this.state === 'demoted') {
			return;
		}
		this.emit('demoting');
		callTransportState.update((st) => ({
			...st,
			reason: `${this.current}_dropped_reconnecting`,
			checkedAt: Date.now()
		}));

		const graceMs = opts.graceMs ?? GRACE_DEFAULT_MS;
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = setTimeout(() => void this.evaluateAfterGrace(), graceMs);
	}

	private async evaluateAfterGrace(): Promise<void> {
		const opts = this.opts;
		if (!opts || this.state !== 'demoting') return;

		// Did the underlying client's own retry heal it during grace?
		if (await this.probe()) {
			this.emit('monitoring');
			callTransportState.update((st) => ({ ...st, reason: 'reconnected', checkedAt: Date.now() }));
			return;
		}

		// Still dead: demote to the next link in the chain after the current one.
		const chain = chainForMode(opts.mode);
		const idx = chain.indexOf(this.current);
		const next = chain[idx + 1];
		try {
			await opts.disconnectCurrent?.();
			if (!next) throw new Error('no further fallback');
			await opts.connect(next);
			this.current = next;
			callTransportState.update((st) => ({
				...st,
				activeTransport: next,
				isFallback: true,
				reason: `demoted_to_${next}_after_${this.primary}_drop`,
				checkedAt: Date.now()
			}));
			this.emit('demoted');

			// If we're now below the primary, schedule promotion probes.
			if (next !== this.primary && this.current === next) {
				const probeMs = opts.probeIntervalMs ?? PROBE_DEFAULT_MS;
				if (this.timer !== null) clearInterval(this.timer);
				this.timer = setInterval(() => void this.tryPromote(), probeMs);
			}
		} catch (error) {
			console.error('[Watchdog] Demotion failed — no usable transport:', error);
			callTransportState.update((st) => ({
				...st,
				reason: 'all_transports_lost',
				checkedAt: Date.now()
			}));
			this.emit('stopped');
		}
	}

	private async tryPromote(): Promise<void> {
		const opts = this.opts;
		if (!opts || this.state !== 'demoted' || this.current === this.primary) return;
		try {
			if (!(await this.probe())) return;
			if (opts.autoPromoteOk && !opts.autoPromoteOk()) return; // stay demoted; user can switch manually
			await opts.connect(this.primary);
			await opts.disconnectCurrent?.();
			this.current = this.primary;
			callTransportState.update((st) => ({
				...st,
				activeTransport: this.primary,
				isFallback: false,
				reason: 'promoted_to_primary',
				checkedAt: Date.now()
			}));
			this.emit('monitoring');
			if (this.timer !== null) clearInterval(this.timer);
			this.timer = null;
		} catch (error) {
			// Primary still not ready; keep probing quietly.
			console.debug('[Watchdog] Promotion attempt failed:', error);
		}
	}

	/**
	 * Health probe. The wabidb client exposes isConnected; other transports
	 * report healthy by default unless a future adapter says otherwise.
	 */
	private async probe(): Promise<boolean> {
		const opts = this.opts;
		if (!opts) return false;
		return (globalThis as any).__wabidbProbePrimary?.(this.primary) ?? false;
	}
}

export const transportWatchdog = new TransportWatchdog();
