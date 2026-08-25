/**
 * CallTransportAdapter registry — the plugin door (calling-audit T4).
 *
 * Goal: third-party/plugin transports arrive as DATA + one adapter module —
 * no core edits. The T2 chain executor and the watchdog consume ONLY this
 * interface; built-in transports (wabidb, p2p, livekit) are registered here as
 * the first three adapters, proving the seam by construction.
 *
 * Server side: /api/media/runtime can advertise arbitrary entries under a
 * transports array; isAvailable() receives that runtime snapshot so an
 * adapter can decide availability from server-declared capability rather than
 * hardcoded knowledge.
 */
import type { EffectiveCallTransport } from '../mediaRuntime';
import type { ServerMediaRuntimeResponse } from '../mediaRuntime';

export interface TransportConnectContext {
	/** Channel id for channel/group calls; undefined for DMs. */
	channelId?: string;
	/** Stable peer user id for DM calls. */
	peerUserId?: string;
	/** Socket.io signaling socket. */
	socket: any;
	/** Display name for roster entries. */
	displayName: string;
	/** Listen-only join (no capture). */
	listenOnly?: boolean;
}

export interface CallTransportAdapter {
	/** Unique id matching EffectiveCallTransport values ('wabidb' | 'p2p' | 'sfu' | custom string). */
	id: string;
	/** Human label for badges/menus. */
	label: string;
	/**
	 * Is this transport usable right now? Receives the last runtime snapshot
	 * (may be null when unreachable) — adapters must soft-fail, never throw.
	 */
	isAvailable: (runtime: ServerMediaRuntimeResponse | null) => boolean | Promise<boolean>;
	/** Establish the transport for one call. Throws to signal failure (chain moves on). */
	connect: (ctx: TransportConnectContext) => Promise<void>;
	/** Tear down this transport's call state. Best-effort; must not throw. */
	destroy?: () => Promise<void> | void;
	/** Liveness probe for the watchdog. Defaults to true. */
	health?: () => boolean;
}

const registry = new Map<string, CallTransportAdapter>();

export function registerCallTransport(adapter: CallTransportAdapter): void {
	if (registry.has(adapter.id)) {
		console.warn(`[Transports] Adapter '${adapter.id}' re-registered — overwriting`);
	}
	registry.set(adapter.id, adapter);
}

export function getCallTransport(id: string): CallTransportAdapter | null {
	return registry.get(id) ?? null;
}

export function listCallTransports(): CallTransportAdapter[] {
	return Array.from(registry.values());
}

/**
 * Resolve an EffectiveCallTransport value to its adapter. Unknown ids return
 * null so callers can degrade gracefully instead of crashing on a transport
 * advertised by the server but not installed client-side.
 */
export async function resolveAvailable(
	id: string,
	runtime: ServerMediaRuntimeResponse | null
): Promise<CallTransportAdapter | null> {
	const adapter = registry.get(id);
	if (!adapter) return null;
	try {
		return (await adapter.isAvailable(runtime)) ? adapter : null;
	} catch {
		return null;
	}
}
