export type QualityLayer = 'q' | 'h' | 'f';

export interface SubscriberMetrics {
	loss: number;
	jitterMs: number;
	rttMs: number;
	bitrateKbps: number;
	cpuPressure?: number;
}

export interface ViewportPriority {
	priority: number;
	isPinned?: boolean;
	isFullscreen?: boolean;
}

interface SubscriberState {
	publisherId: string;
	subscriberId: string;
	metrics: SubscriberMetrics;
	viewport: ViewportPriority;
	selectedLayer: QualityLayer;
	updatedAt: number;
}

export class SfuForwardingPolicyService {
	private readonly subscribers = new Map<string, SubscriberState>();
	private readonly activeSpeakerScores = new Map<string, number>();

	updateMetrics(publisherId: string, subscriberId: string, metrics: SubscriberMetrics): SubscriberState {
		const key = this.key(publisherId, subscriberId);
		const prev = this.subscribers.get(key);
		const viewport = prev?.viewport ?? { priority: 0.5 };
		const selectedLayer = this.chooseLayer(metrics, viewport, this.activeSpeakerScores.get(publisherId) ?? 0);
		const next: SubscriberState = {
			publisherId,
			subscriberId,
			metrics,
			viewport,
			selectedLayer,
			updatedAt: Date.now()
		};
		this.subscribers.set(key, next);
		return next;
	}

	updateViewportPriority(publisherId: string, subscriberId: string, viewport: ViewportPriority): SubscriberState {
		const key = this.key(publisherId, subscriberId);
		const prev = this.subscribers.get(key) ?? {
			publisherId,
			subscriberId,
			metrics: { loss: 0, jitterMs: 0, rttMs: 0, bitrateKbps: 1_500, cpuPressure: 0.2 },
			selectedLayer: 'h' as QualityLayer,
			viewport,
			updatedAt: Date.now()
		};
		const selectedLayer = this.chooseLayer(prev.metrics, viewport, this.activeSpeakerScores.get(publisherId) ?? 0);
		const next = { ...prev, viewport, selectedLayer, updatedAt: Date.now() };
		this.subscribers.set(key, next);
		return next;
	}

	updateActiveSpeaker(userId: string, score: number): void {
		this.activeSpeakerScores.set(userId, Math.max(0, Math.min(1, score)));
	}

	removeUser(userId: string): void {
		this.activeSpeakerScores.delete(userId);
		for (const [key, state] of this.subscribers.entries()) {
			if (state.publisherId === userId || state.subscriberId === userId) {
				this.subscribers.delete(key);
			}
		}
	}

	private chooseLayer(metrics: SubscriberMetrics, viewport: ViewportPriority, speakerScore: number): QualityLayer {
		const congestion = this.scoreCongestion(metrics);
		let target: QualityLayer = 'f';

		if (congestion > 0.72) {
			target = 'q';
		} else if (congestion > 0.4) {
			target = 'h';
		}

		const viewportBoost = (viewport.priority ?? 0) + (viewport.isPinned ? 0.15 : 0) + (viewport.isFullscreen ? 0.2 : 0);
		if (viewportBoost > 0.95 && target !== 'f') {
			target = target === 'q' ? 'h' : 'f';
		}

		if (speakerScore > 0.65 && target === 'q') {
			target = 'h';
		}

		return target;
	}

	private scoreCongestion(metrics: SubscriberMetrics): number {
		const loss = Math.min(1, metrics.loss * 2.5);
		const jitter = Math.min(1, metrics.jitterMs / 60);
		const rtt = Math.min(1, metrics.rttMs / 300);
		const bitrate = metrics.bitrateKbps < 700 ? 1 : metrics.bitrateKbps < 1_400 ? 0.5 : 0;
		const cpu = Math.min(1, metrics.cpuPressure ?? 0.35);
		return (loss * 0.35) + (jitter * 0.2) + (rtt * 0.2) + (bitrate * 0.15) + (cpu * 0.1);
	}

	private key(publisherId: string, subscriberId: string): string {
		return `${publisherId}:${subscriberId}`;
	}
}
