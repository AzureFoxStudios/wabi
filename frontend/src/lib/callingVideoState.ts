// Compatibility surfaces still render one call. Select its feeds by session,
// not by user: the same participant may send different video in another call.
import { derived } from 'svelte/store';
import { activeGroupCall, activeCallSessionId, activeVoiceChannel, screenShares, localScreenStream, localScreenShareSessionId } from './callingStateStores';
import { wabidbRemoteVideoSessions, wabidbLocalPreviewSessions } from './wabidbVideoLane';

export const mediaViewSessionId = derived([activeGroupCall, activeCallSessionId, activeVoiceChannel],
  ([group, direct, voice]) => group?.id ?? direct ?? voice?.id ?? null);
export const selectedRemoteVideo = derived([wabidbRemoteVideoSessions, mediaViewSessionId],
  ([sessions, id]) => id ? sessions.get(id) ?? new Map<string, MediaStream>() : new Map<string, MediaStream>());
export const selectedLocalVideo = derived([wabidbLocalPreviewSessions, mediaViewSessionId],
  ([sessions, id]) => id ? sessions.get(id) ?? new Map<'camera' | 'screen', MediaStream>() : new Map<'camera' | 'screen', MediaStream>());
export const selectedLocalVideoActive = derived(selectedLocalVideo, streams => streams.size > 0);
export const selectedScreenShares = derived([screenShares, mediaViewSessionId], ([shares, id]) =>
  shares.filter(share => id !== null && (share.channelId ?? `direct:${share.userId}`) === id));
export const selectedLocalScreenStream = derived([localScreenStream, localScreenShareSessionId, mediaViewSessionId],
  ([stream, owner, id]) => owner !== null && owner === id ? stream : null);
