import type { DesktopHelperMode } from './runtimeAdminContracts';
import type { BoosterRelayMode } from './mediaContracts';

export interface RelayPublicCapabilities {
	fileRelay: boolean;
	turn: boolean;
	sfu: boolean;
	gateway: boolean;
	selfHosted: boolean;
	boosterMode: BoosterRelayMode | null;
}

export interface RelayTurnMetadata {
	server: string;
	port: number;
	useTurns: boolean;
	realm: string | null;
}

export interface RelaySfuMetadata {
	provider: 'livekit';
	url: string;
}

export interface ParsedRelayMetadata {
	kind: 'booster-relay' | 'relay' | 'desktop-helper' | null;
	source: string | null;
	status: string | null;
	reason: string | null;
	selfHosted: boolean;
	originManaged: boolean;
	ownerUserId: number | null;
	ownerUsername: string | null;
	helperMode: 'off' | DesktopHelperMode | null;
	requestedMode: BoosterRelayMode | null;
	effectiveMode: BoosterRelayMode | null;
	components: {
		turnConfigured: boolean;
		sfuConfigured: boolean;
		gatewayConfigured: boolean;
	} | null;
	capabilities: RelayPublicCapabilities;
	turn: RelayTurnMetadata | null;
	sfu: RelaySfuMetadata | null;
	updatedAt: string | null;
}

export interface AdminRelayNode {
	relay_id: number;
	url: string;
	name: string;
	region: string;
	status: string;
	last_health_ping: number | null;
	registered_at: number;
	approved: number;
	latitude: number | null;
	longitude: number | null;
	bandwidth_mbps: number | null;
	storage_gb: number | null;
	syncthing_device_id: string | null;
	metadata?: ParsedRelayMetadata | null;
}
