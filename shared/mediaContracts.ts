export type SfuProvider = 'none' | 'livekit';
export type BoosterRelayMode = 'off' | 'turn-only' | 'turn-sfu' | 'turn-sfu-gateway';
export type MediaRelaySelectionSource = 'origin' | 'relay';
export type MediaGatewaySessionKind = 'voice' | 'screen' | 'recording';
export type MediaGatewaySessionStatus = 'open' | 'closed';

export interface MediaRuntimeGatewaySnapshot {
	heartbeatTimeoutMs?: number;
	configured?: boolean;
	healthy?: boolean;
	mediaPlaneReady?: boolean;
	lastSeenAt?: number | null;
	activeStreams?: number;
	version?: string | null;
	region?: string | null;
}

export interface MediaRuntimeBoosterRelaySelfAdvertisement {
	enabled?: boolean;
	advertised?: boolean;
	relayId?: number | null;
	url?: string | null;
	name?: string | null;
	region?: string | null;
	status?: 'active' | 'degraded' | 'offline' | null;
	reason?: string | null;
	updatedAt?: number | null;
}

export interface ServerMediaRuntimeResponse {
	media?: {
		localEnhancedEnabled?: boolean;
		srtGatewayEnabled?: boolean;
		srtGatewayUrl?: string | null;
		opus?: {
			audioBitrateWeb?: number;
			audioBitrateLocal?: number;
		};
		turn?: {
			configured?: boolean;
			server?: string | null;
			port?: number;
			useTurns?: boolean;
		};
		gateway?: MediaRuntimeGatewaySnapshot;
		livekit?: {
			configured?: boolean;
			url?: string | null;
		};
		sfu?: {
			provider?: SfuProvider;
			enabled?: boolean;
		};
		boosterRelay?: {
			requestedMode?: BoosterRelayMode;
			effectiveMode?: BoosterRelayMode;
			selfHosted?: boolean;
			selfAdvertisement?: MediaRuntimeBoosterRelaySelfAdvertisement;
			components?: {
				turnConfigured?: boolean;
				sfuConfigured?: boolean;
				gatewayConfigured?: boolean;
				gatewayHealthy?: boolean;
				gatewayMediaPlaneReady?: boolean;
			};
		};
	};
	notes?: {
		srtDirectBrowserSupported?: boolean;
		message?: string | null;
	};
}

export interface TurnCredentialPayload {
	server: string;
	port: number;
	realm: string | null;
	useTurns: boolean;
	username: string;
	credential: string;
	expiresAt: number;
	relayId: number | null;
	relayName: string | null;
	source: MediaRelaySelectionSource;
}

export interface TurnCredentialsResponse {
	turn: TurnCredentialPayload;
}

export interface MediaGatewayHealthSnapshot {
	healthy: boolean;
	mediaPlaneReady?: boolean;
	lastSeenAt?: number | null;
	region?: string | null;
	version?: string | null;
}

export interface MediaGatewaySession {
	sessionId: string;
	channelId: string | null;
	kind: MediaGatewaySessionKind;
	status: MediaGatewaySessionStatus;
	transport: 'srt';
	gatewayUrl: string;
	publishUrl: string;
	playbackUrl: string;
	accessToken: string;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
}

export interface MediaGatewaySessionResponse {
	session: MediaGatewaySession;
	gateway?: MediaGatewayHealthSnapshot;
}

export interface MediaGatewaySessionsResponse {
	sessions: MediaGatewaySession[];
}

export interface LivekitAccessTokenResponse {
	token: string;
	url: string;
	roomName: string;
	identity: string;
	relayId?: number | null;
	relayName?: string | null;
	source?: MediaRelaySelectionSource;
}
