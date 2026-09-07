/** Negotiation started is not a connected transport. Bounded wait with no
 * replacement of the connection owner's event handlers. */
export function waitForPeerConnection(pc: RTCPeerConnection, timeoutMs = 15000): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			pc.removeEventListener('connectionstatechange', changed);
			if (error) reject(error); else resolve();
		};
		const changed = () => {
			if (pc.connectionState === 'connected') finish();
			else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
				finish(new Error(`Peer connection ${pc.connectionState}`));
			}
		};
		const timer = setTimeout(() => finish(new Error('Peer connection timed out')), timeoutMs);
		pc.addEventListener('connectionstatechange', changed);
		changed();
	});
}
