/**
 * Built-in transport adapters (calling-audit T4).
 *
 * The three existing transports registered through the same interface a
 * third-party plugin would use — proving the seam by construction. Each
 * adapter wraps the existing connect functions; no behavior change, only
 * indirection.
 */
import type { CallTransportAdapter } from './registry';
import { registerCallTransport } from './registry';

// Dynamic imports keep this module side-effect-light and avoid pulling the
// whole calling stack into anything that only wants the registry.
const wabidb: CallTransportAdapter = {
	id: 'wabidb',
	label: 'Local relay',
	isAvailable: () => true, // offline-friendly by design; runtime reachability is the connect step's problem
	connect: async (ctx) => {
		const { connectWabidbCall } = await import('../callingWabidb');
		await connectWabidbCall(ctx.socket, ctx.channelId ?? ctx.peerUserId ?? 'direct-call', ctx.displayName, undefined, ctx.peerUserId, ctx.listenOnly);
	},
	destroy: async () => {
		const { disconnectWabidbCall } = await import('../callingWabidb');
		await disconnectWabidbCall();
	},
	health: () => Boolean((globalThis as any).__wabidbProbePrimary?.('wabidb') ?? false)
};

const p2p: CallTransportAdapter = {
	id: 'p2p',
	label: 'P2P direct',
	isAvailable: () => true,
	// P2P has no central "connect" — offers/answers flow through the call
	// signaling handlers. The chain treats reaching the p2p link as success;
	// actual media negotiation proceeds via createCallOffer/answerCall.
	connect: async () => {},
	health: () => true
};

const sfu: CallTransportAdapter = {
	id: 'sfu',
	label: 'SFU media server',
	isAvailable: (runtime) =>
		runtime?.media?.sfu?.provider === 'livekit' &&
		Boolean(runtime?.media?.livekit?.configured && runtime?.media?.livekit?.url),
	connect: async (ctx) => {
		if (!ctx.channelId) throw new Error('LiveKit requires a channel id (DM rooms not wired)');
		const { connectLivekitSfu } = await import('../callingLivekit');
		await connectLivekitSfu(ctx.channelId, ctx.displayName);
	}
};

export function registerBuiltinTransports(): void {
	registerCallTransport(wabidb);
	registerCallTransport(p2p);
	registerCallTransport(sfu);
}

let registered = false;
/** Idempotent entry point for app bootstrap. */
export function ensureBuiltinTransports(): void {
	if (registered) return;
	registered = true;
	registerBuiltinTransports();
}
