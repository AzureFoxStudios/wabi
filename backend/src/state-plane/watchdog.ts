import type { StatePlaneRuntimeStats } from './adapter.js';

interface DriftSnapshot {
	messageParityMismatches: number;
	messageShadowWriteFailures: number;
	messageReadMismatches: number;
	messageReadShadowErrors: number;
	channelParityMismatches: number;
	channelShadowWriteFailures: number;
	channelReadMismatches: number;
	channelReadShadowErrors: number;
	channelMemberParityMismatches: number;
	channelMemberShadowWriteFailures: number;
	channelMemberReadMismatches: number;
	channelMemberReadShadowErrors: number;
	userParityMismatches: number;
	userShadowWriteFailures: number;
	userReadMismatches: number;
	userReadShadowErrors: number;
	sessionParityMismatches: number;
	sessionShadowWriteFailures: number;
	sessionReadMismatches: number;
	sessionReadShadowErrors: number;
	rbacParityMismatches: number;
	rbacShadowWriteFailures: number;
	rbacReadMismatches: number;
	rbacReadShadowErrors: number;
	shadowWriterFailures: number;
	shadowWriterBacklogOverLimit: number;
	shadowWriterTruncateFailures: number;
	outboxErrors: number;
}

export interface StatePlaneWatchdogStats {
	enabled: boolean;
	running: boolean;
	intervalMs: number;
	checks: number;
	alerts: number;
	lastCheckAt: number | null;
	lastAlertAt: number | null;
	lastAlertSummary: string | null;
	lastDelta: DriftSnapshot | null;
}

interface StatePlaneWatchdogOptions {
	enabled: boolean;
	intervalMs?: number;
	getRuntimeStats: () => StatePlaneRuntimeStats;
	recordEvent: (operation: string, payload: Record<string, unknown>) => void;
}

export class StatePlaneWatchdog {
	private readonly enabled: boolean;
	private readonly intervalMs: number;
	private readonly getRuntimeStats: () => StatePlaneRuntimeStats;
	private readonly recordEvent: (operation: string, payload: Record<string, unknown>) => void;
	private running = false;
	private timer: NodeJS.Timeout | null = null;
	private checks = 0;
	private alerts = 0;
	private lastCheckAt: number | null = null;
	private lastAlertAt: number | null = null;
	private lastAlertSummary: string | null = null;
	private lastDelta: DriftSnapshot | null = null;
	private previousSnapshot: DriftSnapshot | null = null;

	constructor(options: StatePlaneWatchdogOptions) {
		this.enabled = options.enabled;
		this.intervalMs = Math.max(5000, options.intervalMs || 30000);
		this.getRuntimeStats = options.getRuntimeStats;
		this.recordEvent = options.recordEvent;
	}

	start(): void {
		if (!this.enabled || this.running) return;
		this.running = true;
		void this.tick();
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		this.timer.unref?.();
		console.log(`[StatePlane] Watchdog started (interval=${this.intervalMs}ms)`);
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	getStats(): StatePlaneWatchdogStats {
		return {
			enabled: this.enabled,
			running: this.running,
			intervalMs: this.intervalMs,
			checks: this.checks,
			alerts: this.alerts,
			lastCheckAt: this.lastCheckAt,
			lastAlertAt: this.lastAlertAt,
			lastAlertSummary: this.lastAlertSummary,
			lastDelta: this.lastDelta ? { ...this.lastDelta } : null
		};
	}

	private snapshot(stats: StatePlaneRuntimeStats): DriftSnapshot {
		return {
			messageParityMismatches: stats.messageStore?.parity.mismatches || 0,
			messageShadowWriteFailures: stats.messageStore?.shadow.writesFailed || 0,
			messageReadMismatches: stats.messageStore?.readSwitch.mismatches || 0,
			messageReadShadowErrors: stats.messageStore?.readSwitch.shadowErrors || 0,
			channelParityMismatches: stats.channelStore.parity.mismatches,
			channelShadowWriteFailures: stats.channelStore.shadow.writesFailed,
			channelReadMismatches: stats.channelStore.readSwitch.mismatches,
			channelReadShadowErrors: stats.channelStore.readSwitch.shadowErrors,
			channelMemberParityMismatches: stats.channelMemberStore.parity.mismatches,
			channelMemberShadowWriteFailures: stats.channelMemberStore.shadow.writesFailed,
			channelMemberReadMismatches: stats.channelMemberStore.readSwitch.mismatches,
			channelMemberReadShadowErrors: stats.channelMemberStore.readSwitch.shadowErrors,
			userParityMismatches: stats.userStore.parity.mismatches,
			userShadowWriteFailures: stats.userStore.shadow.writesFailed,
			userReadMismatches: stats.userStore.readSwitch.mismatches,
			userReadShadowErrors: stats.userStore.readSwitch.shadowErrors,
			sessionParityMismatches: stats.sessionStore.parity.mismatches,
			sessionShadowWriteFailures: stats.sessionStore.shadow.writesFailed,
			sessionReadMismatches: stats.sessionStore.readSwitch.mismatches,
			sessionReadShadowErrors: stats.sessionStore.readSwitch.shadowErrors,
			rbacParityMismatches: stats.rbacStore.parity.mismatches,
			rbacShadowWriteFailures: stats.rbacStore.shadow.writesFailed,
			rbacReadMismatches: stats.rbacStore.readSwitch.mismatches,
			rbacReadShadowErrors: stats.rbacStore.readSwitch.shadowErrors,
			shadowWriterFailures:
				stats.shadowWriter.failed + stats.shadowWriter.parseErrors + stats.shadowWriter.loopErrors,
			shadowWriterBacklogOverLimit: stats.shadowWriter.backlogOverLimit ? 1 : 0,
			shadowWriterTruncateFailures: stats.shadowWriter.truncateFailures,
			outboxErrors: stats.outbox?.errors || 0
		};
	}

	private delta(current: DriftSnapshot, previous: DriftSnapshot): DriftSnapshot {
		return {
			messageParityMismatches: Math.max(0, current.messageParityMismatches - previous.messageParityMismatches),
			messageShadowWriteFailures: Math.max(0, current.messageShadowWriteFailures - previous.messageShadowWriteFailures),
			messageReadMismatches: Math.max(0, current.messageReadMismatches - previous.messageReadMismatches),
			messageReadShadowErrors: Math.max(0, current.messageReadShadowErrors - previous.messageReadShadowErrors),
			channelParityMismatches: Math.max(0, current.channelParityMismatches - previous.channelParityMismatches),
			channelShadowWriteFailures: Math.max(0, current.channelShadowWriteFailures - previous.channelShadowWriteFailures),
			channelReadMismatches: Math.max(0, current.channelReadMismatches - previous.channelReadMismatches),
			channelReadShadowErrors: Math.max(0, current.channelReadShadowErrors - previous.channelReadShadowErrors),
			channelMemberParityMismatches: Math.max(0, current.channelMemberParityMismatches - previous.channelMemberParityMismatches),
			channelMemberShadowWriteFailures: Math.max(0, current.channelMemberShadowWriteFailures - previous.channelMemberShadowWriteFailures),
			channelMemberReadMismatches: Math.max(0, current.channelMemberReadMismatches - previous.channelMemberReadMismatches),
			channelMemberReadShadowErrors: Math.max(0, current.channelMemberReadShadowErrors - previous.channelMemberReadShadowErrors),
			userParityMismatches: Math.max(0, current.userParityMismatches - previous.userParityMismatches),
			userShadowWriteFailures: Math.max(0, current.userShadowWriteFailures - previous.userShadowWriteFailures),
			userReadMismatches: Math.max(0, current.userReadMismatches - previous.userReadMismatches),
			userReadShadowErrors: Math.max(0, current.userReadShadowErrors - previous.userReadShadowErrors),
			sessionParityMismatches: Math.max(0, current.sessionParityMismatches - previous.sessionParityMismatches),
			sessionShadowWriteFailures: Math.max(0, current.sessionShadowWriteFailures - previous.sessionShadowWriteFailures),
			sessionReadMismatches: Math.max(0, current.sessionReadMismatches - previous.sessionReadMismatches),
			sessionReadShadowErrors: Math.max(0, current.sessionReadShadowErrors - previous.sessionReadShadowErrors),
			rbacParityMismatches: Math.max(0, current.rbacParityMismatches - previous.rbacParityMismatches),
			rbacShadowWriteFailures: Math.max(0, current.rbacShadowWriteFailures - previous.rbacShadowWriteFailures),
			rbacReadMismatches: Math.max(0, current.rbacReadMismatches - previous.rbacReadMismatches),
			rbacReadShadowErrors: Math.max(0, current.rbacReadShadowErrors - previous.rbacReadShadowErrors),
			shadowWriterFailures: Math.max(0, current.shadowWriterFailures - previous.shadowWriterFailures),
			shadowWriterBacklogOverLimit: Math.max(0, current.shadowWriterBacklogOverLimit - previous.shadowWriterBacklogOverLimit),
			shadowWriterTruncateFailures: Math.max(0, current.shadowWriterTruncateFailures - previous.shadowWriterTruncateFailures),
			outboxErrors: Math.max(0, current.outboxErrors - previous.outboxErrors)
		};
	}

	private hasDrift(delta: DriftSnapshot): boolean {
		return (
			delta.messageParityMismatches > 0 ||
			delta.messageShadowWriteFailures > 0 ||
			delta.messageReadMismatches > 0 ||
			delta.messageReadShadowErrors > 0 ||
			delta.channelParityMismatches > 0 ||
			delta.channelShadowWriteFailures > 0 ||
			delta.channelReadMismatches > 0 ||
			delta.channelReadShadowErrors > 0 ||
			delta.channelMemberParityMismatches > 0 ||
			delta.channelMemberShadowWriteFailures > 0 ||
			delta.channelMemberReadMismatches > 0 ||
			delta.channelMemberReadShadowErrors > 0 ||
			delta.userParityMismatches > 0 ||
			delta.userShadowWriteFailures > 0 ||
			delta.userReadMismatches > 0 ||
			delta.userReadShadowErrors > 0 ||
			delta.sessionParityMismatches > 0 ||
			delta.sessionShadowWriteFailures > 0 ||
			delta.sessionReadMismatches > 0 ||
			delta.sessionReadShadowErrors > 0 ||
			delta.rbacParityMismatches > 0 ||
			delta.rbacShadowWriteFailures > 0 ||
			delta.rbacReadMismatches > 0 ||
			delta.rbacReadShadowErrors > 0 ||
			delta.shadowWriterFailures > 0 ||
			delta.shadowWriterBacklogOverLimit > 0 ||
			delta.shadowWriterTruncateFailures > 0 ||
			delta.outboxErrors > 0
		);
	}

	private summarize(delta: DriftSnapshot): string {
		return [
			`msgParity+${delta.messageParityMismatches}`,
			`msgShadowFail+${delta.messageShadowWriteFailures}`,
			`msgReadMismatch+${delta.messageReadMismatches}`,
			`msgReadError+${delta.messageReadShadowErrors}`,
			`channelParity+${delta.channelParityMismatches}`,
			`channelShadowFail+${delta.channelShadowWriteFailures}`,
			`channelReadMismatch+${delta.channelReadMismatches}`,
			`channelReadError+${delta.channelReadShadowErrors}`,
			`memberParity+${delta.channelMemberParityMismatches}`,
			`memberShadowFail+${delta.channelMemberShadowWriteFailures}`,
			`memberReadMismatch+${delta.channelMemberReadMismatches}`,
			`memberReadError+${delta.channelMemberReadShadowErrors}`,
			`userParity+${delta.userParityMismatches}`,
			`userShadowFail+${delta.userShadowWriteFailures}`,
			`userReadMismatch+${delta.userReadMismatches}`,
			`userReadError+${delta.userReadShadowErrors}`,
			`sessionParity+${delta.sessionParityMismatches}`,
			`sessionShadowFail+${delta.sessionShadowWriteFailures}`,
			`sessionReadMismatch+${delta.sessionReadMismatches}`,
			`sessionReadError+${delta.sessionReadShadowErrors}`,
			`rbacParity+${delta.rbacParityMismatches}`,
			`rbacShadowFail+${delta.rbacShadowWriteFailures}`,
			`rbacReadMismatch+${delta.rbacReadMismatches}`,
			`rbacReadError+${delta.rbacReadShadowErrors}`,
			`shadowWriterFail+${delta.shadowWriterFailures}`,
			`shadowWriterBacklog+${delta.shadowWriterBacklogOverLimit}`,
			`shadowWriterTruncateFail+${delta.shadowWriterTruncateFailures}`,
			`outboxErrors+${delta.outboxErrors}`
		].join(' ');
	}

	private async tick(): Promise<void> {
		try {
			const runtime = this.getRuntimeStats();
			const current = this.snapshot(runtime);
			const now = Date.now();
			this.lastCheckAt = now;
			this.checks += 1;

			if (!this.previousSnapshot) {
				this.previousSnapshot = current;
				this.lastDelta = null;
				return;
			}

			const delta = this.delta(current, this.previousSnapshot);
			this.lastDelta = delta;
			this.previousSnapshot = current;

			if (!this.hasDrift(delta)) return;

			this.alerts += 1;
			this.lastAlertAt = now;
			this.lastAlertSummary = this.summarize(delta);

			console.warn(`[StatePlane] Drift watchdog alert: ${this.lastAlertSummary}`);
			this.recordEvent('watchdog_alert', {
				timestamp: now,
				delta
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[StatePlane] Watchdog tick failed: ${message}`);
		}
	}
}
