/**
 * Declarative transport fallback chains (calling-audit T2).
 *
 * Before this module, each call surface hand-rolled its own fallback:
 *  - joinVoiceChannel: wabidb failure caught + logged, NO fallback (silent deaf)
 *  - enterEstablishedGroupCall: tried SFU, then LOGGED "will use P2P" without
 *    establishing it
 *  - answerCall (DM): the only real P2P fallthrough
 *
 * One executor, one table. Chains are data; the surface-aware tail (mesh
 * viability) is applied at execution time. Every demotion writes its reason
 * into callTransportState so the UI badge never lies about the active
 * transport.
 */
import { get } from 'svelte/store';
import { callTransportState, callOfflineNotice } from './callingStateStores';
import type { EffectiveCallTransport } from './mediaRuntime';
// (type-only: erased at runtime — keeps tests free of mediaRuntime's $app deps)
import { PEER_CONNECTION_UNAVAILABLE } from './mediaCapabilities';

export type CallSurface = 'channel' | 'group' | 'direct';

/** Full-mesh P2P is only sane below this many participants. */
export const MESH_MAX_PARTICIPANTS = 6;

/**
 * Chain per stored CallTransportMode. Order = preference order. The executor
 * walks the chain left to right and returns the first transport that
 * CONNECTS, not the first that resolves.
 */
export const FALLBACK_CHAINS: Record<string, EffectiveCallTransport[]> = {
	auto: ['wabidb', 'p2p'],
	wabidb: ['wabidb'],
	'sfu-preferred': ['sfu', 'wabidb', 'p2p'],
	'p2p-only': ['p2p']
};

export function chainForMode(mode: string): EffectiveCallTransport[] {
	return FALLBACK_CHAINS[mode] ?? FALLBACK_CHAINS.auto;
}

/**
 * Surface- and size-aware chain adjustment.
 *
 * Community voice channels deliberately never fall through to direct P2P.
 * Server mute/deafen/listen-only policy cannot be authoritatively enforced
 * after browsers exchange direct RTP, so silently demoting an SFU/relay call
 * to P2P would be a security downgrade. WabiDB and SFU transports remain
 * observable/enforceable by the Authority. Direct/group calls may still use
 * P2P where that trust model is appropriate.
 *
 * Group calls keep the historical small-mesh fallback, but trim it once the
 * expected room exceeds MESH_MAX_PARTICIPANTS.
 *
 * `peerConnections` is false in a webview built without WebRTC (WebKitGTK,
 * the Linux desktop app): P2P and the LiveKit SFU both need RTCPeerConnection,
 * so only the relay remains. Callers pass `hasPeerConnection()`.
 */
export function effectiveChain(
	mode: string,
	surface: CallSurface,
	expectedParticipants: number,
	peerConnections = true
): EffectiveCallTransport[] {
	const chain = chainForMode(mode).filter(
		(transport) => peerConnections || (transport !== 'p2p' && transport !== 'sfu')
	);
	if (surface === 'channel') {
		return chain.filter((transport) => transport !== 'p2p');
	}
	if (surface === 'group' && expectedParticipants > MESH_MAX_PARTICIPANTS) {
		return chain.filter((transport) => transport !== 'p2p');
	}
	return chain;
}

/** Shown wherever direct P2P is refused for a community voice channel. */
export const COMMUNITY_VOICE_P2P_REFUSAL =
	'Direct P2P is unavailable for community voice because it cannot enforce server mute/deafen.';

/**
 * Refuse before any capture or transport work when the chain is empty
 * (e.g. P2P-only on community voice). Sets the visible notice and throws.
 */
export function refuseEmptyChain(
	mode: string,
	surface: CallSurface,
	expectedParticipants = 1,
	peerConnections = true
): void {
	if (effectiveChain(mode, surface, expectedParticipants, peerConnections).length > 0) return;
	// Say which rule emptied the chain: the engine, or the community-voice policy.
	const engineLimit = !peerConnections && effectiveChain(mode, surface, expectedParticipants).length > 0;
	const message = engineLimit
		? `${PEER_CONNECTION_UNAVAILABLE} Choose Auto or WabiDB.`
		: surface === 'channel'
			? `${COMMUNITY_VOICE_P2P_REFUSAL} Choose Auto, WabiDB, or SFU.`
			: 'No permitted call transport is available.';
	callOfflineNotice.set(message);
	throw new Error(message);
}

export interface TransportAttempt {
	transport: EffectiveCallTransport;
	ok: boolean;
	error?: unknown;
}

export interface ConnectOutcome {
	/** The transport that actually connected. */
	active: EffectiveCallTransport;
	/** Demotions that happened before success, in order. */
	attempts: TransportAttempt[];
	/** True if we ended on a different transport than the chain's head. */
	demoted: boolean;
}

/**
 * Walk the chain. `connect` must be idempotent-ish per transport (the caller
 * wraps connectWabidbCall / connectLivekitSfu / P2P offer creation) and should
 * THROW on failure so the executor can move on.
 */
export async function connectWithFallback(opts: {
	mode: string;
	surface: CallSurface;
	expectedParticipants?: number;
	/** Cancellation is not a transport failure and must never select a fallback. */
	stillWanted?: () => boolean;
	/** `hasPeerConnection()` at the call site; see effectiveChain. Defaults to true. */
	peerConnections?: boolean;
	connect: (transport: EffectiveCallTransport) => Promise<void>;
}): Promise<ConnectOutcome> {
	const participants = opts.expectedParticipants ?? 1;
	const peerConnections = opts.peerConnections ?? true;
	const chain = effectiveChain(opts.mode, opts.surface, participants, peerConnections);
	// What this call would have tried first in an engine with peer connections.
	const preferred = effectiveChain(opts.mode, opts.surface, participants)[0];
	const attempts: TransportAttempt[] = [];
	const check = () => {
		if (opts.stillWanted && !opts.stillWanted()) throw new DOMException('Call ended during transport setup', 'AbortError');
	};
	check();

	refuseEmptyChain(opts.mode, opts.surface, participants, peerConnections);

	for (let i = 0; i < chain.length; i++) {
		const transport = chain[i];
		try {
			check();
			await opts.connect(transport);
			check();
			attempts.push({ transport, ok: true });
			const demoted = i > 0;
			// The engine removed the preferred transport before any attempt.
			const engineDemoted = !demoted && transport !== preferred;
			callTransportState.update((state) => ({
				...state,
				activeTransport: transport,
				isFallback: demoted || engineDemoted || state.isFallback,
				reason: demoted
					? `fallback_${transport}_after_${chain[0]}`
					: engineDemoted
						? `fallback_${transport}_no_peer_connections`
						: state.reason,
				checkedAt: Date.now()
			}));
			if (demoted) {
				console.warn('[Calling] Transport fallback:', chain[0], '->', transport,
					'(after', attempts.length - 1, 'failure(s))');
			}
			return { active: transport, attempts, demoted: demoted || engineDemoted };
		} catch (error) {
			check();
			if (error instanceof DOMException && error.name === 'AbortError') throw error;
			attempts.push({ transport, ok: false, error });
			console.warn(`[Calling] ${opts.surface} connect via ${transport} failed:`, error);
			callTransportState.update((state) => ({
				...state,
				reason: `${transport}_connect_failed`,
				checkedAt: Date.now()
			}));
		}
	}

	// Chain exhausted.
	callOfflineNotice.set(
		`All call transports failed (${chain.join(' → ')}). Check your connection or server relay.`
	);
	throw new Error(`All transports failed for ${opts.surface} call: ${chain.join(' -> ')}`);
}
