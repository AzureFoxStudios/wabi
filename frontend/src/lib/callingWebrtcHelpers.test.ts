import { expect, test } from 'bun:test';
import { queueIceCandidate, flushOrphanIceCandidates, dropOrphanIceCandidates, flushIceCandidateQueue } from './callingIce';
import type { PeerConnectionState } from './callingTypes';

test('early ICE survives offer preparation only for its live call and share generation', () => {
  const peers = new Map<string, PeerConnectionState>();
  const key = 'scoped-peer:screen';
  let admitted = true;
  const candidate = { candidate: 'early-live' };
  queueIceCandidate(peers, key, candidate, state => admitted && state.channelId === 'group-a' && state.mediaRequestId === 'share-a');
  queueIceCandidate(peers, key, { candidate: 'other-call' }, state => state.channelId === 'group-b');
  queueIceCandidate(peers, key, { candidate: 'old-share' }, state => state.mediaRequestId === 'retired');
  const state = { channelId: 'group-a', mediaRequestId: 'share-a', iceCandidateQueue: [], hasRemoteDescription: false } as unknown as PeerConnectionState;
  peers.set(key, state); flushOrphanIceCandidates(peers, key);
  expect(state.iceCandidateQueue).toEqual([candidate]);
  peers.delete(key);
  queueIceCandidate(peers, key, candidate, state => admitted && state.channelId === 'group-a');
  admitted = false;
  state.iceCandidateQueue = []; peers.set(key, state); flushOrphanIceCandidates(peers, key);
  expect(state.iceCandidateQueue).toEqual([]);
  dropOrphanIceCandidates(key);
});

test('ICE queue draining stops when its peer is replaced during an await', async () => {
  const peers = new Map<string, PeerConnectionState>();
  const calls: string[] = [];
  const state = { pc: { addIceCandidate: async (candidate: RTCIceCandidateInit) => {
    calls.push(candidate.candidate!); peers.delete('peer');
  } }, iceCandidateQueue: [{ candidate: 'first' }, { candidate: 'stale' }] } as unknown as PeerConnectionState;
  peers.set('peer', state);
  await flushIceCandidateQueue(peers, 'peer');
  expect(calls).toEqual(['first']);
});
