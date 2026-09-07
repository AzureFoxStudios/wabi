import type { ScreenShare } from './callingTypes';

export type ChannelMediaSharers = Map<string, { screenIds: Set<string>; cameraIds: Set<string> }>;

/** A stable account can send different media in several calls. Badges must
 * follow the channel-owned feed, not a global union of that account's media. */
export function buildChannelMediaSharers(
  sessions: ReadonlyMap<string, ReadonlyMap<string, MediaStream>>,
  shares: Pick<ScreenShare, 'channelId' | 'userId'>[],
): ChannelMediaSharers {
  const result: ChannelMediaSharers = new Map();
  const row = (id: string) => {
    let value = result.get(id);
    if (!value) { value = { screenIds: new Set(), cameraIds: new Set() }; result.set(id, value); }
    return value;
  };
  const stable = (id: string) => /^\d+$/.test(id) ? `user-${id}` : id;
  for (const [channelId, streams] of sessions) {
    for (const key of streams.keys()) {
      const match = key.match(/^(.*):(camera|screen)$/);
      if (!match || !match[1]) continue;
      const target = row(channelId);
      (match[2] === 'screen' ? target.screenIds : target.cameraIds).add(stable(match[1]));
    }
  }
  for (const share of shares) {
    // Unscoped direct-call shares are not voice-channel media.
    if (share.channelId) row(share.channelId).screenIds.add(stable(share.userId));
  }
  return result;
}
