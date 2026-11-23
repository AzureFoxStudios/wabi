import { afterEach, describe, expect, mock, test } from 'bun:test';
import { parkedStreamSourceCount, retireStreamSource, sweepParkedStreamSources } from './streamSourceRetire';

const allTracks: Array<{ readyState: string }> = [];
function fakeSource(trackState: 'live' | 'ended' = 'live', contextState = 'running') {
	const track: { readyState: string } = { readyState: trackState };
	allTracks.push(track);
	const sink = { fftSize: 2048 };
	const context = { state: contextState, createAnalyser: mock(() => sink) };
	const source = {
		context,
		mediaStream: { getAudioTracks: () => [track] },
		connect: mock(),
		disconnect: mock()
	};
	return { source: source as unknown as MediaStreamAudioSourceNode, raw: source, track, sink, context };
}

describe('retireStreamSource', () => {
	afterEach(() => { for (const track of allTracks) track.readyState = 'ended'; allTracks.length = 0; sweepParkedStreamSources(); });

	test('keeps a source with a live track connected to a sink until the track ends', () => {
		const { source, raw, track, sink } = fakeSource();
		retireStreamSource(source);
		expect(raw.disconnect).toHaveBeenCalledTimes(1);
		expect(raw.connect).toHaveBeenCalledWith(sink);
		expect(sink.fftSize).toBe(32);
		expect(parkedStreamSourceCount()).toBe(1);

		sweepParkedStreamSources();
		expect(parkedStreamSourceCount()).toBe(1);

		track.readyState = 'ended';
		sweepParkedStreamSources();
		expect(parkedStreamSourceCount()).toBe(0);
		expect(raw.disconnect).toHaveBeenCalledTimes(2);
	});

	test('just disconnects a source whose track has ended or whose context is closed', () => {
		const ended = fakeSource('ended');
		retireStreamSource(ended.source);
		expect(ended.raw.connect).not.toHaveBeenCalled();
		const closed = fakeSource('live', 'closed');
		retireStreamSource(closed.source);
		expect(closed.raw.connect).not.toHaveBeenCalled();
		expect(parkedStreamSourceCount()).toBe(0);
	});

	test('releases a parked source when its context closes', () => {
		const { source, context } = fakeSource();
		retireStreamSource(source);
		context.state = 'closed';
		sweepParkedStreamSources();
		expect(parkedStreamSourceCount()).toBe(0);
	});
});
