interface AddCallPeerOptions {
	onLinked?: (socketIds: string[]) => void;
}

interface RemoveAllCallPeersOptions {
	onPeerRemoved?: (socketId: string) => void;
}

export function createDirectCallRuntime() {
	const activeCallPeers = new Map<string, Set<string>>();

	const addCallPeer = (socketId: string, peerId: string, options: AddCallPeerOptions = {}): void => {
		if (!activeCallPeers.has(socketId)) activeCallPeers.set(socketId, new Set());
		if (!activeCallPeers.has(peerId)) activeCallPeers.set(peerId, new Set());
		activeCallPeers.get(socketId)!.add(peerId);
		activeCallPeers.get(peerId)!.add(socketId);
		options.onLinked?.([socketId, peerId]);
	};

	const removeAllCallPeers = (socketId: string, options: RemoveAllCallPeersOptions = {}): Set<string> => {
		const peers = activeCallPeers.get(socketId) || new Set<string>();
		for (const peerId of peers) {
			activeCallPeers.get(peerId)?.delete(socketId);
			if (activeCallPeers.get(peerId)?.size === 0) activeCallPeers.delete(peerId);
			options.onPeerRemoved?.(peerId);
		}
		activeCallPeers.delete(socketId);
		return peers;
	};

	return {
		activeCallPeers,
		addCallPeer,
		removeAllCallPeers
	};
}
