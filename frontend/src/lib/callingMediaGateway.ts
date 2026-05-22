import { callTransportState } from './callingStateStores';
import {
	MEDIA_GATEWAY_RENEW_MS,
	MEDIA_GATEWAY_RENEW_FAILURE_LIMIT,
	MEDIA_GATEWAY_WATCHDOG_MS,
	MEDIA_GATEWAY_RUNTIME_POLL_MS
} from './callingTypes';
import { syncMediaRuntimeFromServer } from './mediaRuntime';
import {
	closeMediaGatewaySession,
	renewMediaGatewaySession,
	getMediaGatewaySession
} from './mediaGateway';

// ============================================================================
// Private State
// ============================================================================

let activeMediaGatewaySessionId: string | null = null;
let mediaGatewayRenewInterval: number | null = null;
let mediaGatewayRenewFailureCount = 0;
let mediaGatewayWatchdogInterval: number | null = null;
let mediaGatewayRuntimePollInterval: number | null = null;

// ============================================================================
// Getter / Setter for activeMediaGatewaySessionId
// ============================================================================

export function getActiveMediaGatewaySessionId(): string | null {
	return activeMediaGatewaySessionId;
}

export function setActiveMediaGatewaySessionId(id: string | null): void {
	activeMediaGatewaySessionId = id;
}

// ============================================================================
// Media Gateway Runtime Telemetry
// ============================================================================

async function refreshGatewayRuntimeTelemetry(): Promise<void> {
	const runtime = await syncMediaRuntimeFromServer().catch(() => null);
	const gateway = runtime?.media?.gateway;
	if (!gateway) {
		callTransportState.update((state) => ({
			...state,
			gatewayMediaPlaneStatus: state.gatewaySessionId ? 'degraded' : 'idle',
			gatewayActiveStreams: null,
			gatewayLastSeenAt: null
		}));
		return;
	}

	const healthy = gateway.healthy === true;
	const mediaPlaneReady = gateway.mediaPlaneReady === true;
	const nextStatus: 'idle' | 'pending' | 'ready' | 'degraded' | 'lost' =
		!activeMediaGatewaySessionId
			? 'idle'
			: healthy && mediaPlaneReady
				? 'ready'
				: healthy
					? 'pending'
					: 'degraded';

	callTransportState.update((state) => ({
		...state,
		gatewayMediaPlaneStatus: nextStatus,
		gatewayActiveStreams: typeof gateway.activeStreams === 'number' ? gateway.activeStreams : null,
		gatewayLastSeenAt: typeof gateway.lastSeenAt === 'number' ? gateway.lastSeenAt : null
	}));
}

function stopMediaGatewayRuntimePolling(): void {
	if (mediaGatewayRuntimePollInterval !== null) {
		clearInterval(mediaGatewayRuntimePollInterval);
		mediaGatewayRuntimePollInterval = null;
	}
}

function startMediaGatewayRuntimePolling(): void {
	stopMediaGatewayRuntimePolling();
	if (typeof window === 'undefined') return;
	void refreshGatewayRuntimeTelemetry();
	mediaGatewayRuntimePollInterval = window.setInterval(() => {
		void refreshGatewayRuntimeTelemetry();
	}, MEDIA_GATEWAY_RUNTIME_POLL_MS);
}

function stopMediaGatewaySessionRenewal(): void {
	if (mediaGatewayRenewInterval !== null) {
		clearInterval(mediaGatewayRenewInterval);
		mediaGatewayRenewInterval = null;
	}
	if (mediaGatewayWatchdogInterval !== null) {
		clearInterval(mediaGatewayWatchdogInterval);
		mediaGatewayWatchdogInterval = null;
	}
	stopMediaGatewayRuntimePolling();
	mediaGatewayRenewFailureCount = 0;
	callTransportState.update((state) => ({
		...state,
		gatewaySessionId: activeMediaGatewaySessionId,
		gatewayControlPlaneStatus: activeMediaGatewaySessionId ? 'idle' : 'idle',
		gatewayMediaPlaneStatus: activeMediaGatewaySessionId ? 'pending' : 'idle',
		gatewayActiveStreams: null,
		gatewayLastSeenAt: null
	}));
}

function startMediaGatewaySessionRenewal(): void {
	stopMediaGatewaySessionRenewal();
	if (typeof window === 'undefined') return;
	if (!activeMediaGatewaySessionId) return;
	startMediaGatewayRuntimePolling();
	mediaGatewayRenewInterval = window.setInterval(() => {
		const sessionId = activeMediaGatewaySessionId;
		if (!sessionId) return;
		void renewMediaGatewaySession(sessionId)
			.then(() => {
				mediaGatewayRenewFailureCount = 0;
				callTransportState.update((state) => ({
					...state,
					gatewaySessionId: sessionId,
					gatewayControlPlaneStatus: 'ready',
					gatewayMediaPlaneStatus: state.gatewayMediaPlaneStatus === 'idle' ? 'pending' : state.gatewayMediaPlaneStatus,
					reason: state.reason === 'sfu_control_plane_degraded' ? 'sfu_control_plane_ready_media_plane_pending' : state.reason
				}));
			})
			.catch((error) => {
				mediaGatewayRenewFailureCount += 1;
				console.warn('[MediaGateway] Session renewal failed:', error);
				callTransportState.update((state) => ({
					...state,
					gatewaySessionId: sessionId,
					gatewayControlPlaneStatus: mediaGatewayRenewFailureCount >= MEDIA_GATEWAY_RENEW_FAILURE_LIMIT ? 'lost' : 'degraded',
					gatewayMediaPlaneStatus: mediaGatewayRenewFailureCount >= MEDIA_GATEWAY_RENEW_FAILURE_LIMIT ? 'lost' : 'degraded',
					reason: 'sfu_control_plane_degraded'
				}));

				if (mediaGatewayRenewFailureCount >= MEDIA_GATEWAY_RENEW_FAILURE_LIMIT) {
					void closeMediaGatewaySession(sessionId).catch(() => undefined);
					activeMediaGatewaySessionId = null;
					stopMediaGatewaySessionRenewal();
				}
			});
	}, MEDIA_GATEWAY_RENEW_MS);

	mediaGatewayWatchdogInterval = window.setInterval(() => {
		const sessionId = activeMediaGatewaySessionId;
		if (!sessionId) return;
		void getMediaGatewaySession(sessionId)
			.then((session) => {
				if (!session || session.status !== 'open') {
					callTransportState.update((state) => ({
						...state,
						gatewaySessionId: sessionId,
						gatewayControlPlaneStatus: 'lost',
						gatewayMediaPlaneStatus: 'lost',
						reason: 'sfu_control_plane_lost'
					}));
					activeMediaGatewaySessionId = null;
					stopMediaGatewaySessionRenewal();
					return;
				}
				callTransportState.update((state) => ({
					...state,
					gatewaySessionId: sessionId,
					gatewayControlPlaneStatus: 'ready'
				}));
			})
			.catch(() => {
				callTransportState.update((state) => ({
					...state,
					gatewaySessionId: sessionId,
					gatewayControlPlaneStatus: 'degraded',
					gatewayMediaPlaneStatus: 'degraded',
					reason: 'sfu_control_plane_degraded'
				}));
			});
	}, MEDIA_GATEWAY_WATCHDOG_MS);
}

// ============================================================================
// Public Exports
// ============================================================================

export {
	refreshGatewayRuntimeTelemetry,
	stopMediaGatewayRuntimePolling,
	startMediaGatewayRuntimePolling,
	stopMediaGatewaySessionRenewal,
	startMediaGatewaySessionRenewal
};