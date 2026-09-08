export type ComposerSendResult = { ok: boolean; reason?: string } | void;

/** A successful result is a message-store handoff, not a server persistence receipt. */
export async function sendComposerBatch<T>(options: {
  payloads: T[];
  canContinue: () => boolean;
  send: (payload: T) => Promise<ComposerSendResult> | ComposerSendResult;
  accepted: (sent: number) => void;
}): Promise<{ sent: number; reason?: string; interrupted?: boolean }> {
  let sent = 0;
  for (const payload of options.payloads) {
    if (!options.canContinue()) return { sent, interrupted: true };
    let result: ComposerSendResult;
    try { result = await options.send(payload); }
    catch { return { sent, reason: 'enqueue_failed' }; }
    if (result && result.ok === false) return { sent, reason: result.reason || 'send_failed' };
    options.accepted(++sent);
  }
  return { sent };
}
