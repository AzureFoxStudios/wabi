/** Session-memory drafts only. Never serializes text, replies or files to disk. */
export class ComposerDraftMemory<T> {
  private realm: string | null = null;
  private entries = new Map<string, {
    value: T | undefined; owner: object; channel: string; send: object | null;
    listeners: Set<(pending: boolean, update?: (draft: T) => T) => void>;
  }>();
  constructor(private context: () => string | null) {}
  private sync() {
    const realm = this.context();
    if (realm !== this.realm) { this.entries.clear(); this.realm = realm; }
    return realm;
  }
  clear() { this.entries.clear(); }
  remove(channel: string) {
    for (const [key, entry] of this.entries) if (entry.channel === channel) this.entries.delete(key);
  }
  open(channel: string, allowed: () => boolean = () => true, surface = 'main') {
    const realm = this.sync();
    const key = JSON.stringify([channel, surface]);
    const owner = {};
    const entry = this.entries.get(key) ?? { value: undefined, owner, channel, send: null,
      listeners: new Set<(pending: boolean, update?: (draft: T) => T) => void>() };
    entry.owner = owner;
    this.entries.set(key, entry);
    const slotCurrent = () => this.sync() === realm && realm !== null && this.entries.get(key) === entry && allowed();
    const current = () => slotCurrent() && entry.owner === owner;
    const notify = (update?: (draft: T) => T) => {
      for (const listener of entry.listeners) listener(entry.send !== null, update);
    };
    return {
      initial: entry.value,
      read: () => current() ? entry.value : undefined,
      current,
      save: (value: T) => { if (current()) entry.value = value; },
      clear: () => { if (current()) { entry.value = undefined; entry.send = null; notify(); } },
      isSending: () => slotCurrent() && entry.send !== null,
      onSendState: (listener: (pending: boolean, update?: (draft: T) => T) => void) => {
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
      },
      beginSend: () => {
        if (!current() || entry.send) return null;
        const transaction = {};
        entry.send = transaction;
        notify();
        const canSettle = () => slotCurrent() && entry.send === transaction;
        return {
          // A handoff already in flight can settle after editor remount. It may
          // never start more work there or alter another realm/revoked slot.
          settle: (update: (draft: T) => T) => {
            if (!canSettle()) return;
            if (entry.value !== undefined) entry.value = update(entry.value);
            notify(update);
          },
          finish: () => {
            if (!canSettle()) return;
            entry.send = null;
            notify();
          }
        };
      }
    };
  }
}
