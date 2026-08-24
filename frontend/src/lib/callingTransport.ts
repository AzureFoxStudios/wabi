import { callTransportState } from './callingStateStores';
import {
	resolveCallTransportPlan,
	syncMediaRuntimeFromServer,
	type EffectiveCallTransport
} from './mediaRuntime';

// ============================================================================
// Transport Resolution
// ============================================================================

export async function resolveActiveTransport(channelId?: string): Promise<EffectiveCallTransport> {
	const plan = await resolveCallTransportPlan();
	const runtime = await syncMediaRuntimeFromServer().catch(() => null);
	const sfuProvider = runtime?.media?.sfu?.provider === 'livekit' ? 'livekit' : plan.sfuProvider;
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
		checkedAt: plan.checkedAt
	});

	if (!channelId) {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: false,
			reason: 'direct_call_p2p',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now()
		});
		return 'p2p';
	}

	if (plan.effective === 'sfu' && sfuProvider !== 'livekit') {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: true,
			reason: 'sfu_plugin_disabled',
			gatewayHealthy: false,
			checkedAt: Date.now()
		});
		return 'p2p';
	}

	if (plan.effective === 'sfu' && livekitReady && channelId) {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'sfu',
			isFallback: false,
			reason: 'sfu_livekit_ready',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now()
		});
		return 'sfu';
	}

	if (plan.effective === 'sfu') {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: true,
			reason: plan.reason || 'livekit_unavailable',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now()
		});
		return 'p2p';
	}

	if (plan.effective === 'wabidb') {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'wabidb',
			isFallback: false,
			reason: 'wabidb_default',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now()
		});
		return 'wabidb';
	}

	return 'wabidb';
}
