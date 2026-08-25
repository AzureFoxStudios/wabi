import { callTransportState } from './callingStateStores';
import {
	resolveCallTransportPlan,
	syncMediaRuntimeFromServer,
	type EffectiveCallTransport
} from './mediaRuntime';

// ============================================================================
// Transport Resolution
// ============================================================================

/**
 * Resolve the transport for an about-to-start call.
 *
 * History note (calling-audit T1): this function used to FORCE 'p2p' whenever
 * `channelId` was absent — i.e. every DM call, regardless of the user's mode.
 * That lie is why toggleVideo had to consult runtime truth instead of the
 * router. It now accepts a call kind and routes DMs by the SAME plan as
 * channels; the wabidb relay path keys DM sessions deterministically via
 * wabidbDmSessionKey, so a channel id is not required to use the relay.
 *
 * `kind` is advisory today (kept for the T2 chain executor's surface-aware
 * fallback tails); resolution itself is plan-driven for all kinds.
 */
export async function resolveActiveTransport(
	channelId?: string,
	kind: 'channel' | 'group' | 'direct' = channelId ? 'channel' : 'direct'
): Promise<EffectiveCallTransport> {
	void kind;
	const plan = await resolveCallTransportPlan();
	const runtime = await syncMediaRuntimeFromServer().catch(() => null);
	const sfuProvider = runtime?.media?.sfu?.provider === 'livekit' ? 'livekit' : plan.sfuProvider;
	const livekitReady = Boolean(
		sfuProvider === 'livekit' &&
		runtime?.media?.livekit?.configured &&
		runtime?.media?.livekit?.url
	);

	if (plan.effective === 'sfu') {
		if (sfuProvider === 'livekit' && livekitReady && channelId) {
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
		// SFU requested but unusable: demote per the plan's own reason.
		callTransportState.set({
			mode: plan.mode,
			activeTransport: plan.fallbackApplied ? plan.effective : 'wabidb',
			isFallback: true,
			reason: sfuProvider !== 'livekit' ? 'sfu_plugin_disabled' : (plan.reason || 'livekit_unavailable'),
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now()
		});
		return plan.fallbackApplied ? plan.effective : 'wabidb';
	}

	if (plan.effective === 'p2p') {
		callTransportState.set({
			mode: plan.mode,
			activeTransport: 'p2p',
			isFallback: plan.fallbackApplied,
			reason: plan.reason ?? 'p2p_requested',
			gatewayHealthy: plan.gatewayHealthy,
			checkedAt: Date.now()
		});
		return 'p2p';
	}

	// wabidb (the default for 'auto'): applies to channels AND direct calls.
	callTransportState.set({
		mode: plan.mode,
		activeTransport: 'wabidb',
		isFallback: plan.fallbackApplied,
		reason: plan.reason ?? 'wabidb_default',
		gatewayHealthy: plan.gatewayHealthy,
		checkedAt: Date.now()
	});
	return 'wabidb';
}
