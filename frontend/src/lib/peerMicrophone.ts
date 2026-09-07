/** Each WebRTC destination owns a clone of the processed microphone track.
 * Mute/routing uses track.enabled synchronously, not fallible setParameters.
 * The original stays available to local monitoring/recording and the relay.
 */
interface MicrophoneSender {
	track: MediaStreamTrack;
	pending: Set<MediaStreamTrack>;
	enabled: boolean;
	closed: boolean;
	queue: Promise<void>;
}
const microphones = new WeakMap<RTCRtpSender, MicrophoneSender>();

export function addPeerMicrophone(pc: RTCPeerConnection, source: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
	const track = source.clone();
	track.enabled = false; // fail closed until this destination's routing is applied
	try {
		const sender = pc.addTrack(track, stream);
		microphones.set(sender, { track, pending: new Set(), enabled: false, closed: false, queue: Promise.resolve() });
		return sender;
	} catch (error) { track.stop(); throw error; }
}

export function gatePeerMicrophone(pc: RTCPeerConnection, enabled: boolean): void {
	for (const sender of pc.getSenders()) {
		const state = microphones.get(sender);
		if (!state || state.closed) continue;
		state.enabled = enabled;
		state.track.enabled = enabled;
		for (const track of state.pending) track.enabled = enabled;
	}
}

export function replacePeerMicrophone(sender: RTCRtpSender, source: MediaStreamTrack): Promise<void> {
	const state = microphones.get(sender);
	if (!state || state.closed) return Promise.reject(new Error('Microphone sender no longer owned'));
	const next = source.clone();
	next.enabled = state.enabled;
	state.pending.add(next);
	const run = state.queue.then(async () => {
		if (state.closed) return;
		try {
			await sender.replaceTrack(next);
			if (!state.closed) {
				state.track.stop();
				state.track = next;
			}
		} catch (error) {
			// Do not silently keep transmitting the old selected device after
			// replacement failed. The caller reports the failed update.
			state.track.enabled = false;
			state.track.stop();
			throw error;
		} finally {
			state.pending.delete(next);
			if (state.closed || state.track !== next) next.stop();
		}
	});
	state.queue = run.catch(() => {});
	return run;
}

export function releasePeerMicrophones(pc: RTCPeerConnection): void {
	for (const sender of pc.getSenders()) {
		const state = microphones.get(sender);
		if (!state) continue;
		state.closed = true;
		state.track.enabled = false;
		state.track.stop();
		for (const track of state.pending) { track.enabled = false; track.stop(); }
		state.pending.clear();
		microphones.delete(sender);
	}
}
