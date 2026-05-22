import { callTransportState } from './callingStateStores';
import {
	resolveCallTransportPlan,
	syncMediaRuntimeFromServer,
	type EffectiveCallTransport
} from './mediaRuntime';
import {
	getActiveMediaGatewaySessionId,
	stopMediaGatewaySessionRenewal
} from './callingMediaGateway';

// ============================================================================
// Transport Resolution
// ============================================================================

export async function resolveActiveTransport(channelId?: string): Promise<EffectiveCallTransport> {
	const plan = await resolveCallTransportPlan();
	const runtime = await syncMediaRuntimeFromServer().catch(() => null);
	const sfuProvider = runtime?.media?.sfu?.provider === 'livekit' ? 'livekit' : plan.sfuProvider;
	const turnConfigured = Boolean(runtime?.media?.turn?.configured);
	const livekitReady = Boolean(
		sfuProvider === 'livekit' &&
		runtime?.media?.livekit?.configured &&
		runtime?.media?.livekit?.url
	);
	callTransportState.set({
		mode: plan.mode,
		activeTransport: plan.effective,
		isFallback: plan.fallbackApplied,
		reason: plan.reason,
		gatewayHealthy: plan.gatewayHealthy,
		checkedAt: plan.checkedAt,
		gatewaySessionId: getActiveMediaGatewaySessionId(),
		gatewayControlPlaneStatus: 'idle',
		gatewayMediaPlaneStatus: getActiveMediaGatewaySessionId() ? 'pending' : 'idle',
		gatewayActiveStreams: null,
		gatewayLastSeenAt: null
	});

	if (!channelId) {
		stopMediaGatewaySessionRenewal();
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: plan.effective === 'sfu',
			reason: turnConfigured ? 'direct_call_p2p' : 'direct_call_turn_unconfigured',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now(),
			gatewaySessionId: null,
			gatewayControlPlaneStatus: 'idle',
			gatewayMediaPlaneStatus: 'idle',
			gatewayActiveStreams: null,
			gatewayLastSeenAt: null
		});
		return 'p2p';
	}

	if (plan.effective === 'sfu' && sfuProvider !== 'livekit') {
		stopMediaGatewaySessionRenewal();
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: true,
			reason: 'sfu_plugin_disabled',
			gatewayHealthy: false,
			checkedAt: Date.now(),
			gatewaySessionId: null,
			gatewayControlPlaneStatus: 'idle',
			gatewayMediaPlaneStatus: 'idle',
			gatewayActiveStreams: null,
			gatewayLastSeenAt: null
		});
		return 'p2p';
	}

	if (plan.effective === 'sfu' && livekitReady && channelId) {
		stopMediaGatewaySessionRenewal();
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'sfu',
			isFallback: false,
			reason: 'sfu_livekit_ready',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now(),
			gatewaySessionId: null,
			gatewayControlPlaneStatus: 'idle',
			gatewayMediaPlaneStatus: 'pending',
			gatewayActiveStreams: null,
			gatewayLastSeenAt: null
		});
		return 'sfu';
	}

	if (plan.effective === 'sfu') {
		stopMediaGatewaySessionRenewal();
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: true,
			reason: plan.reason || 'livekit_unavailable',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now(),
			gatewaySessionId: null,
			gatewayControlPlaneStatus: 'idle',
			gatewayMediaPlaneStatus: 'idle',
			gatewayActiveStreams: null,
			gatewayLastSeenAt: null
		});
		return 'p2p';
	}

	if (plan.effective === 'stdb') {
		stopMediaGatewaySessionRenewal();
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'stdb',
			isFallback: false,
			reason: 'stdb_default',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now(),
			gatewaySessionId: null,
			gatewayControlPlaneStatus: 'idle',
			gatewayMediaPlaneStatus: 'idle',
			gatewayActiveStreams: null,
			gatewayLastSeenAt: null
		});
		return 'stdb';
	}

	stopMediaGatewaySessionRenewal();
	return 'p2p';
}

