export type BoosterRelayMode = 'off' | 'turn-only' | 'turn-sfu' | 'turn-sfu-gateway';

export interface BoosterRelayComponentConfigState {
	turnConfigured: boolean;
	sfuConfigured: boolean;
	gatewayConfigured: boolean;
}

export function getBoosterRelayComponentConfigState(): BoosterRelayComponentConfigState {
	const turnConfigured = Boolean(
		(process.env.TURN_EXTERNAL_IP || '').trim() &&
		(process.env.TURN_REALM || '').trim() &&
		(process.env.TURN_SHARED_SECRET || '').trim()
	);
	const sfuConfigured = Boolean(
		(process.env.SFU_PROVIDER || '').trim().toLowerCase() === 'livekit' &&
		(process.env.LIVEKIT_URL || '').trim() &&
		(process.env.LIVEKIT_API_KEY || '').trim() &&
		(process.env.LIVEKIT_API_SECRET || '').trim()
	);
	const gatewayConfigured = Boolean(
		((process.env.MEDIA_SRT_GATEWAY_ENABLED || '').trim() === 'true' ||
			(process.env.MEDIA_SRT_GATEWAY_ENABLED || '').trim() === '1') &&
		(process.env.MEDIA_SRT_GATEWAY_URL || '').trim()
	);
	return {
		turnConfigured,
		sfuConfigured,
		gatewayConfigured
	};
}

export function getRequestedBoosterRelayMode(): BoosterRelayMode {
	const raw = (process.env.BOOSTER_RELAY_MODE || '').trim().toLowerCase();
	if (raw === 'turn-only' || raw === 'turn-sfu' || raw === 'turn-sfu-gateway') {
		return raw;
	}
	return 'off';
}

export function getEffectiveBoosterRelayMode(): BoosterRelayMode {
	const { turnConfigured, sfuConfigured, gatewayConfigured } = getBoosterRelayComponentConfigState();
	if (turnConfigured && sfuConfigured && gatewayConfigured) return 'turn-sfu-gateway';
	if (turnConfigured && sfuConfigured) return 'turn-sfu';
	if (turnConfigured) return 'turn-only';
	return 'off';
}
