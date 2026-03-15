import type { BoosterRelayMode } from './boosterRelayMode.js';

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
	helperMode: 'off' | 'files-only' | 'desktop-assist' | null;
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

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || Array.isArray(value) || typeof value !== 'object') return null;
	return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown, maxLength = 256): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLength);
}

function asBoolean(value: unknown, fallback = false): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function asPort(value: unknown, fallback = 3478): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const port = Math.floor(value);
	if (port < 1 || port > 65535) return fallback;
	return port;
}

function asMode(value: unknown): BoosterRelayMode | null {
	return value === 'off' || value === 'turn-only' || value === 'turn-sfu' || value === 'turn-sfu-gateway'
		? value
		: null;
}

function asHelperMode(value: unknown): 'off' | 'files-only' | 'desktop-assist' | null {
	return value === 'off' || value === 'files-only' || value === 'desktop-assist' ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : null;
}

export function sanitizeRelayMetadata(input: unknown): Record<string, unknown> | null {
	const source = asObject(input);
	if (!source) return null;

	const kind = asTrimmedString(source.kind, 32);
	const sourceName = asTrimmedString(source.source, 64);
	const status = asTrimmedString(source.status, 32);
	const reason = asTrimmedString(source.reason, 256);
	const ownerUsername = asTrimmedString(source.ownerUsername, 120);
	const ownerUserId = asPositiveInteger(source.ownerUserId);
	const helperMode = asHelperMode(source.helperMode);
	const requestedMode = asMode(source.requestedMode);
	const effectiveMode = asMode(source.effectiveMode);
	const updatedAt = asTrimmedString(source.updatedAt, 64);
	const componentsInput = asObject(source.components);
	const capabilitiesInput = asObject(source.capabilities);
	const turnInput = asObject(source.turn);
	const sfuInput = asObject(source.sfu);

	const components = componentsInput
		? {
				turnConfigured: asBoolean(componentsInput.turnConfigured),
				sfuConfigured: asBoolean(componentsInput.sfuConfigured),
				gatewayConfigured: asBoolean(componentsInput.gatewayConfigured)
			}
		: undefined;
	const capabilities = capabilitiesInput
		? {
				fileRelay: asBoolean(capabilitiesInput.fileRelay, true),
				turn: asBoolean(capabilitiesInput.turn),
				sfu: asBoolean(capabilitiesInput.sfu),
				gateway: asBoolean(capabilitiesInput.gateway),
				selfHosted: asBoolean(capabilitiesInput.selfHosted),
				boosterMode: asMode(capabilitiesInput.boosterMode)
			}
		: undefined;
	const turn = turnInput
		? (() => {
				const server = asTrimmedString(turnInput.server, 255);
				if (!server) return null;
				return {
					server,
					port: asPort(turnInput.port),
					useTurns: asBoolean(turnInput.useTurns),
					realm: asTrimmedString(turnInput.realm, 128)
				};
			})()
		: undefined;
	const sfu = sfuInput
		? (() => {
				const provider = asTrimmedString(sfuInput.provider, 32);
				const url = asTrimmedString(sfuInput.url, 255);
				if (provider !== 'livekit' || !url) return null;
				return {
					provider: 'livekit' as const,
					url
				};
			})()
		: undefined;

	const metadata: Record<string, unknown> = {};
	if (kind === 'booster-relay' || kind === 'relay' || kind === 'desktop-helper') metadata.kind = kind;
	if (sourceName) metadata.source = sourceName;
	if (status) metadata.status = status;
	if (reason) metadata.reason = reason;
	if (ownerUserId) metadata.ownerUserId = ownerUserId;
	if (ownerUsername) metadata.ownerUsername = ownerUsername;
	if (helperMode) metadata.helperMode = helperMode;
	if (typeof source.selfHosted === 'boolean') metadata.selfHosted = source.selfHosted;
	if (typeof source.originManaged === 'boolean') metadata.originManaged = source.originManaged;
	if (requestedMode) metadata.requestedMode = requestedMode;
	if (effectiveMode) metadata.effectiveMode = effectiveMode;
	if (components) metadata.components = components;
	if (capabilities) metadata.capabilities = capabilities;
	if (turn) metadata.turn = turn;
	if (sfu) metadata.sfu = sfu;
	if (updatedAt) metadata.updatedAt = updatedAt;

	return Object.keys(metadata).length > 0 ? metadata : null;
}

export function parseRelayMetadata(raw: string | null | undefined): ParsedRelayMetadata | null {
	if (!raw) return null;
	try {
		const sanitized = sanitizeRelayMetadata(JSON.parse(raw));
		if (!sanitized) return null;
		const capabilitiesInput = asObject(sanitized.capabilities);
		const effectiveMode = asMode(sanitized.effectiveMode);
		const requestedMode = asMode(sanitized.requestedMode);
		const turnInput = asObject(sanitized.turn);
		const componentsInput = asObject(sanitized.components);
		const turn = turnInput
			? {
					server: asTrimmedString(turnInput.server, 255) || '',
					port: asPort(turnInput.port),
					useTurns: asBoolean(turnInput.useTurns),
					realm: asTrimmedString(turnInput.realm, 128)
				}
			: null;
		const sfuInput = asObject(sanitized.sfu);
		const sfu = sfuInput
			? (() => {
					const provider = asTrimmedString(sfuInput.provider, 32);
					const url = asTrimmedString(sfuInput.url, 255);
					if (provider !== 'livekit' || !url) return null;
					return {
						provider: 'livekit' as const,
						url
					};
				})()
			: null;
		const boosterMode = effectiveMode || requestedMode;
		return {
			kind:
				sanitized.kind === 'booster-relay' ||
				sanitized.kind === 'relay' ||
				sanitized.kind === 'desktop-helper'
					? sanitized.kind
					: null,
			source: asTrimmedString(sanitized.source, 64),
			status: asTrimmedString(sanitized.status, 32),
			reason: asTrimmedString(sanitized.reason, 256),
			selfHosted: asBoolean(sanitized.selfHosted),
			originManaged: asBoolean(sanitized.originManaged),
			ownerUserId: asPositiveInteger(sanitized.ownerUserId),
			ownerUsername: asTrimmedString(sanitized.ownerUsername, 120),
			helperMode: asHelperMode(sanitized.helperMode),
			requestedMode,
			effectiveMode,
			components: componentsInput
				? {
						turnConfigured: asBoolean(componentsInput.turnConfigured),
						sfuConfigured: asBoolean(componentsInput.sfuConfigured),
						gatewayConfigured: asBoolean(componentsInput.gatewayConfigured)
					}
				: null,
			capabilities: {
				fileRelay: capabilitiesInput ? asBoolean(capabilitiesInput.fileRelay, true) : true,
				turn: capabilitiesInput ? asBoolean(capabilitiesInput.turn) : false,
				sfu: capabilitiesInput ? asBoolean(capabilitiesInput.sfu) : false,
				gateway: capabilitiesInput ? asBoolean(capabilitiesInput.gateway) : false,
				selfHosted: capabilitiesInput ? asBoolean(capabilitiesInput.selfHosted) : asBoolean(sanitized.selfHosted),
				boosterMode: capabilitiesInput ? asMode(capabilitiesInput.boosterMode) : boosterMode
			},
			turn: turn && turn.server ? turn : null,
			sfu,
			updatedAt: asTrimmedString(sanitized.updatedAt, 64)
		};
	} catch {
		return null;
	}
}
