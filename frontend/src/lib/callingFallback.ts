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
// (type-only: erased at runtime — keeps tests free of mediaRuntime's \$app deps)

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
 * - A p2p tail for a channel/group with more than MESH_MAX_PARTICIPANTS
 *   expected members is an outage, not a fallback: trim it and let exhaustion
 *   surface callOfflineNotice instead of N×N renegotiation hell.
 */
export function effectiveChain(
	mode: string,
	surface: CallSurface,
	expectedParticipants: number
): EffectiveCallTransport[] {
	const chain = chainForMode(mode).slice();
	if (
		(surface === 'channel' || surface === 'group') &&
		expectedParticipants > MESH_MAX_PARTICIPANTS
	) {
		return chain.filter((t) => t !== 'p2p');
	}
	return chain;
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
	connect: (transport: EffectiveCallTransport) => Promise<void>;
}): Promise<ConnectOutcome> {
	const chain = effectiveChain(opts.mode, opts.surface, opts.expectedParticipants ?? 1);
	const attempts: TransportAttempt[] = [];

	for (let i = 0; i < chain.length; i++) {
		const transport = chain[i];
		try {
			await opts.connect(transport);
			attempts.push({ transport, ok: true });
			const demoted = i > 0;
			callTransportState.update((state) => ({
				...state,
				activeTransport: transport,
				isFallback: demoted || state.isFallback,
				reason: demoted ? `fallback_${transport}_after_${chain[0]}` : state.reason,
				checkedAt: Date.now()
			}));
			if (demoted) {
				console.warn('[Calling] Transport fallback:', chain[0], '->', transport,
					'(after', attempts.length - 1, 'failure(s))');
			}
			return { active: transport, attempts, demoted };
		} catch (error) {
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
