import type { Channel } from './socket-types';

export type MembershipContext = { server: string; account: string };
type Entry = { revision: string; removed: boolean; epoch: number };
export type MembershipLease = { realm: string; channelId: string; epoch: number; generation: number };
export type GroupRevocation = MembershipLease & { revision: string };

export function membershipRevision(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  return BigInt(value) <= 18446744073709551615n ? value : null;
}

export function validGroupSnapshot(value: unknown): value is Channel {
  const channel = value as Channel | null;
  return !!channel && typeof channel.id === 'string' && channel.id.length > 0 && channel.type === 'group' &&
    typeof channel.name === 'string' && membershipRevision(channel.membershipRevision) !== null &&
    typeof channel.ownerId === 'string' && Array.isArray(channel.members) &&
    channel.members.includes(channel.ownerId) &&
    channel.members.every(id => typeof id === 'string' && /^user-[1-9][0-9]*$/.test(id)) &&
    new Set(channel.members).size === channel.members.length;
}

/** Local stale-work fence, NOT an authorization cache. The server still checks
 * every request. Persistent tombstones also fence old archives after reload. */
export class GroupMembership {
  private entries = new Map<string, Entry>();
  private activeRealm: string | null = null;
  private initialized = false;
  private generation = 0;
  private listeners = new Set<(event: GroupRevocation) => void>();
  private contextListeners = new Set<(previousGroups: string[]) => void>();

  constructor(private deps: {
    context: () => MembershipContext | null;
    storage?: Pick<Storage, 'getItem' | 'setItem'>;
  }) {}

  realm(): string | null {
    const context = this.deps.context();
    const realm = context ? JSON.stringify([context.server, context.account]) : null;
    if (realm !== this.activeRealm) {
      const previousGroups = [...this.entries.keys()];
      this.generation++;
      this.activeRealm = realm;
      this.initialized = false;
      this.entries.clear();
      if (realm) {
        try {
          const stored: unknown = JSON.parse(this.deps.storage?.getItem(this.storageKey(realm)) || '[]');
          if (Array.isArray(stored)) for (const item of stored) {
            if (Array.isArray(item) && typeof item[0] === 'string' && item[0].length <= 128 &&
                membershipRevision(item[1]?.revision) !== null && typeof item[1]?.removed === 'boolean') {
              this.entries.set(item[0], { revision: item[1].revision, removed: item[1].removed, epoch: 0 });
            }
          }
        } catch { /* no stored hint grants server access */ }
      }
      for (const listener of this.contextListeners) {
        try { listener(previousGroups); }
        catch (error) { console.error('[group] Context cleanup failed:', error); }
      }
    }
    return realm;
  }

  private storageKey(realm: string): string { return `wabi:group-membership:${realm}`; }
  private persist(): void {
    if (!this.activeRealm) return;
    try { this.deps.storage?.setItem(this.storageKey(this.activeRealm), JSON.stringify([...this.entries])); }
    catch { /* live revocation still applies; unknown groups are fenced at boot */ }
  }

  beginConnection(): void { this.realm(); this.initialized = false; }
  finishInit(realm: string): void { if (this.realm() === realm) this.initialized = true; }
  ready(): boolean { return this.realm() !== null && this.initialized; }
  knownGroups(): string[] { this.realm(); return [...this.entries.keys()]; }

  revision(id: string): string | null {
    this.realm();
    const entry = this.entries.get(id);
    return entry && !entry.removed ? entry.revision : null;
  }

  acceptsContent(id: string): boolean {
    if (!this.realm()) return !id.startsWith('group-');
    const entry = this.entries.get(id);
    return entry ? !entry.removed : !id.startsWith('group-');
  }

  capture(id: string): MembershipLease {
    const realm = this.realm();
    if (!realm || !this.acceptsContent(id)) throw new Error('Group is unavailable; reconnect to refresh membership');
    return { realm, channelId: id, epoch: this.entries.get(id)?.epoch ?? 0, generation: this.generation };
  }
  current(lease: MembershipLease): boolean {
    return this.realm() === lease.realm && this.generation === lease.generation && this.acceptsContent(lease.channelId) &&
      (this.entries.get(lease.channelId)?.epoch ?? 0) === lease.epoch;
  }

  /** Returns false for malformed, stale or nonmember snapshots. Never guess the
   * owner from array order; old servers must upgrade before group management. */
  apply(channel: Channel, realm: string): boolean {
    if (this.realm() !== realm || !validGroupSnapshot(channel)) return false;
    const revision = channel.membershipRevision!;
    const previous = this.entries.get(channel.id);
    if (previous && (BigInt(revision) < BigInt(previous.revision) ||
        (previous.removed && revision === previous.revision))) return false;
    if (!channel.members!.includes(`user-${this.deps.context()!.account}`)) {
      this.revoke(channel.id, revision, realm);
      return false;
    }
    this.entries.set(channel.id, { revision, removed: false,
      epoch: (previous?.epoch ?? 0) + (previous?.removed ? 1 : 0) });
    this.persist();
    return true;
  }

  revoke(id: string, revision: string | null, realm: string): boolean {
    if (this.realm() !== realm) return false;
    const previous = this.entries.get(id);
    const next = revision ?? previous?.revision ?? '0';
    if (membershipRevision(next) === null || (previous && BigInt(next) < BigInt(previous.revision))) return false;
    if (previous?.removed && previous.revision === next) return false;
    const entry = { revision: next, removed: true, epoch: (previous?.epoch ?? 0) + 1 };
    this.entries.set(id, entry);
    this.persist();
    for (const listener of this.listeners) {
      try { listener({ realm, channelId: id, epoch: entry.epoch, generation: this.generation, revision: next }); }
      catch (error) { console.error('[group] Revocation cleanup failed:', error); }
    }
    return true;
  }

  onRevoked(listener: (event: GroupRevocation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onContextChanged(listener: (previousGroups: string[]) => void): () => void {
    this.contextListeners.add(listener);
    return () => { this.contextListeners.delete(listener); };
  }

  tracks(id: string): boolean { this.realm(); return this.entries.has(id) || id.startsWith('group-'); }
}
