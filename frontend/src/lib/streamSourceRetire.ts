/**
 * Take a MediaStreamAudioSourceNode out of use without leaving it unpulled.
 *
 * WebKitGTK (measured on 2.54) keeps queueing audio for a stream source that
 * nothing pulls from while its track is live: about 0.7 MB per second per
 * source, in native memory that is not returned when the call ends. Dropping
 * every reference does not help; the node is not collected. A source that
 * stays connected to any node, even one nobody reads, is drained normally.
 *
 * So a source whose track is still live is parked on a small analyser until
 * the track ends, and only then disconnected. Other engines lose nothing: the
 * parked node costs a 32-sample analyser.
 *
 * Not covered: a source in a suspended context queues in the same way, parked
 * or not. Close or resume a context that holds stream sources; do not leave
 * it suspended during a call.
 */
interface Parked {
	source: MediaStreamAudioSourceNode;
	sink: AnalyserNode;
}

const SWEEP_MS = 5000;
const parked = new Set<Parked>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function finished(entry: Parked): boolean {
	return entry.source.context.state === 'closed'
		|| entry.source.mediaStream.getAudioTracks().every(track => track.readyState !== 'live');
}

/** Releases parked sources whose tracks have ended. Runs on a timer; exported for tests. */
export function sweepParkedStreamSources(): void {
	for (const entry of Array.from(parked)) {
		if (!finished(entry)) continue;
		parked.delete(entry);
		try { entry.source.disconnect(); } catch { /* context already closed */ }
	}
	if (parked.size === 0 && sweepTimer !== null) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
}

export function retireStreamSource(source: MediaStreamAudioSourceNode): void {
	try { source.disconnect(); } catch { /* already detached */ }
	const entry = { source } as Parked;
	try {
		if (finished(entry)) return;
		entry.sink = source.context.createAnalyser();
		entry.sink.fftSize = 32;
		source.connect(entry.sink);
	} catch {
		return;
	}
	parked.add(entry);
	sweepTimer ??= setInterval(sweepParkedStreamSources, SWEEP_MS);
}

/** How many retired sources are still being drained. For diagnostics and tests. */
export function parkedStreamSourceCount(): number {
	return parked.size;
}
