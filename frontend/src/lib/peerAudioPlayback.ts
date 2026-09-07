/** Select one receive path without destroying the other direction of a
 * bidirectional PeerConnection. Relay rendering proves only reception; a
 * P2P sender/camera must survive until its own call lifecycle ends.
 */
const relayOwners = new Map<string, object>();
const receivers = new Map<string, Set<MediaStreamTrack>>();
const peerTracks = new WeakMap<RTCPeerConnection, Map<MediaStreamTrack, string>>();
const keyFor = (sessionId: string, userId: string) => JSON.stringify([sessionId, userId]);

export function registerPeerAudioReceiver(pc: RTCPeerConnection, sessionId: string, userId: string, track: MediaStreamTrack): void {
	if (track.kind !== 'audio') return;
	const key = keyFor(sessionId, userId);
	let tracks = receivers.get(key);
	if (!tracks) receivers.set(key, tracks = new Set());
	tracks.add(track);
	let owned = peerTracks.get(pc);
	if (!owned) peerTracks.set(pc, owned = new Map());
	owned.set(track, key);
	track.enabled = !relayOwners.has(key);
}

export function releasePeerAudioReceivers(pc: RTCPeerConnection): void {
	for (const [track, key] of peerTracks.get(pc) ?? []) {
		const tracks = receivers.get(key);
		tracks?.delete(track);
		if (!tracks?.size) receivers.delete(key);
	}
	peerTracks.delete(pc);
}

export function selectRelayAudio(owner: object, sessionId: string, userId: string, ready: boolean): void {
	const key = keyFor(sessionId, userId);
	if (ready) relayOwners.set(key, owner);
	else {
		if (relayOwners.get(key) !== owner) return; // stale relay teardown
		relayOwners.delete(key);
	}
	for (const track of receivers.get(key) ?? []) track.enabled = !ready;
}
