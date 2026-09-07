import { expect, test } from 'bun:test';
import { registerPeerAudioReceiver, releasePeerAudioReceivers, selectRelayAudio } from './peerAudioPlayback';

test('relay receive selection is per participant/session and never touches outbound mic or video', () => {
	const pc = {} as RTCPeerConnection;
	const track = () => ({ kind: 'audio', enabled: true }) as MediaStreamTrack;
	const a = track(), b = track(), otherChannel = track();
	const video = { kind: 'video', enabled: true } as MediaStreamTrack;
	registerPeerAudioReceiver(pc, 'one', 'a', a);
	registerPeerAudioReceiver(pc, 'one', 'b', b);
	registerPeerAudioReceiver(pc, 'two', 'a', otherChannel);
	registerPeerAudioReceiver(pc, 'one', 'a', video);
	const relay = {};
	selectRelayAudio(relay, 'one', 'a', true);
	expect([a.enabled, b.enabled, otherChannel.enabled, video.enabled]).toEqual([false, true, true, true]);
	selectRelayAudio(relay, 'one', 'a', false);
	expect(a.enabled).toBe(true);
	releasePeerAudioReceivers(pc);
});

test('replacement P2P receivers inherit selection; stale relay teardown cannot unmute duplicates', () => {
	const pc = {} as RTCPeerConnection;
	const track = { kind: 'audio', enabled: true } as MediaStreamTrack;
	const old = {}, current = {};
	selectRelayAudio(old, 'session', 'user', true);
	registerPeerAudioReceiver(pc, 'session', 'user', track);
	expect(track.enabled).toBe(false);
	selectRelayAudio(current, 'session', 'user', true);
	selectRelayAudio(old, 'session', 'user', false);
	expect(track.enabled).toBe(false);
	selectRelayAudio(current, 'session', 'user', false);
	expect(track.enabled).toBe(true);
	releasePeerAudioReceivers(pc);
	selectRelayAudio(current, 'session', 'user', true);
	expect(track.enabled).toBe(true); // closed PC is no longer owned
	selectRelayAudio(current, 'session', 'user', false);
});
