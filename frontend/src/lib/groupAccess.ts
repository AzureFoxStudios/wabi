import { getAuthToken } from './authSession';
import { getServerUrl, normalizeServerUrl } from './serverUrl';
import { GroupMembership, type MembershipContext } from './groupMembership';

// The token is decoded only to CANCEL stale client work, never to authenticate.
export function groupContext(): MembershipContext | null {
  const server = normalizeServerUrl(getServerUrl());
  const token = getAuthToken();
  if (!server || !token) return null;
  try {
    const { sub } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof sub === 'string' && /^[1-9][0-9]*$/.test(sub) ? { server, account: sub } : null;
  } catch { return null; }
}

export const groupMembership = new GroupMembership({
  context: groupContext,
  storage: {
    getItem: (key) => typeof localStorage === 'undefined' ? null : localStorage.getItem(key),
    setItem: (key, value) => { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
  }
});

/** Capture before an await/import; a re-add must never revive old work. */
export function captureGroupAccess(channelId: string): () => boolean {
  if (!groupMembership.tracks(channelId)) return () => true;
  const lease = groupMembership.capture(channelId);
  return () => groupMembership.current(lease);
}
