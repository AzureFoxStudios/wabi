// Runs inside the isolated group browser fixture: actual SocketManager,
// messageStore, session boundaries and IndexedDB; only transport is synthetic.
import { get } from 'svelte/store';
import { channelMessages, sendMessage } from '../src/lib/messageStore';
import { currentUser } from '../src/lib/presenceIdentity';
import { connected } from '../src/lib/socketConnectionState';
import { clearAuthSession, getAuthToken, setAuthToken } from '../src/lib/authSession';
import { groupMembership } from '../src/lib/groupAccess';
import { messageDeliveries, UNCONFIRMED_MESSAGE } from '../src/lib/messageDelivery';
import { openWabiDB, getWabiDB } from '../src/lib/wabidb';
import { QueueDB } from '../src/lib/wabidb/queue/db';
import { drainOutboundQueue } from '../src/lib/wabidb/drain';

export async function messageDeliveryContract(controls: { socket: () => any; install: () => void; init: () => void; owner: any }): Promise<boolean> {
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Delivery IndexedDB transaction did not settle');
  };
  const previous = { messages: get(channelMessages), user: get(currentUser), token: getAuthToken()! };
  await openWabiDB(); const db = getWabiDB()!; const raw = new QueueDB();
  const ids: string[] = [];
  const queueRow = async (id: string) => (await db.listQueue()).find(action => action.id === id)!;
  const row = (id: string) => get(channelMessages).general?.find(message => message.clientMessageId === id);
  const send = async (text: string, options = {}) => {
    const result = await sendMessage('general', text, 'text', options);
    assert(result.ok, 'message handoff failed');
    return (result as { clientMessageId: string }).clientMessageId;
  };
  const receive = (event: string, payload: any) => controls.socket().receive(event, payload);
  const receipt = (id: string) => ({ channelId: 'general', clientMessageId: id, messageId: `msg_${id}`, timestamp: Date.now() });
  const gate = () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    return { wait, release };
  };
  const emitCount = (id: string) => controls.socket().sent.filter(([event, payload]: [string, any]) =>
    event === 'message' && payload?.clientMessageId === id).length;
  try {
    currentUser.set(controls.owner); channelMessages.set({ general: [] });
    const id = await send('original', { channelId: 'wrong', clientMessageId: 'wrong', text: 'wrong' });
    const emitted = controls.socket().sent.filter(([event]: [string]) => event === 'message').at(-1)[1];
    assert(emitted.channelId === 'general' && emitted.clientMessageId === id && emitted.text === 'original', 'options redirected captured intent');
    const peer = { id: 'msg_peer', user: 'Peer', userId: 'user-2', senderStableId: 'user-2', clientMessageId: id,
      type: 'text', text: 'Peer content', timestamp: Date.now() };
    receive('message', { channelId: 'general', message: peer });
    assert(row(id)?.text === 'original' && row(id)?.deliveryState === 'sending', 'peer nonce replaced pending intent');
    receive('channel-messages', { channelId: 'general', messages: [peer] });
    assert(row(id)?.text === 'original', 'peer history nonce discarded pending intent');
    receive('message-accepted', { ...receipt(id), timestamp: undefined });
    assert(row(id)?.deliveryState === 'sending', 'partial acceptance cleared delivery');
    receive('message-error', { ...receipt(id), channelId: 'other', outcome: 'rejected', error: 'Wrong channel' });
    assert(row(id)?.deliveryState === 'sending', 'wrong-channel rejection changed intent');
    receive('message-error', { ...receipt(id), outcome: 'rejected', error: 'Access denied' });
    assert(row(id)?.deliveryError === 'Not sent: Access denied', 'correlated rejection is not visible');
    receive('message-error', { ...receipt(id), outcome: 'unknown', error: 'storage internals' });
    assert(row(id)?.deliveryOutcome === 'rejected', 'uncertainty replaced definitive rejection');
    receive('message-accepted', receipt(id));
    receive('message-error', { ...receipt(id), outcome: 'rejected', error: 'late' });
    assert(row(id)?.deliveryState === undefined && row(id)?.clientMessageId === id, 'late failure overwrote acceptance/stable identity');
    assert(!messageDeliveries.has(controls.socket(), { channelId: 'general', clientMessageId: id }), 'settled timer leaked');

    const lost = await send('uncertain');
    const oldHandlers = [...controls.socket().listeners.get('message-accepted')];
    controls.socket().disconnect();
    assert(row(lost)?.deliveryError === UNCONFIRMED_MESSAGE, 'disconnect left online intent sending');
    controls.install(); controls.init(); currentUser.set(controls.owner);
    oldHandlers.forEach((handler: any) => handler(receipt(lost)));
    assert(row(lost)?.deliveryState === 'failed', 'retired socket receipt crossed replacement');
    receive('message-accepted', receipt(lost));
    assert(row(lost)?.deliveryState === undefined, 'valid late receipt could not confirm uncertain intent');

    const aba = await send('logout boundary');
    clearAuthSession(); setAuthToken(previous.token); // same-account ABA before old callback resumes
    receive('message-accepted', receipt(aba));
    assert(row(aba)?.deliveryState === 'sending', 'old receipt crossed explicit session boundary');
    assert(!messageDeliveries.has(controls.socket(), { channelId: 'general', clientMessageId: aba }), 'logout retained deadline');
    controls.install(); controls.init(); currentUser.set(controls.owner);

    connected.set(false);
    const offline = await send('waiting offline is not a failure');
    const offlineQueue = (await db.listQueue()).find(action => (action.payload as any)?.clientMessageId === offline)!;
    ids.push(offlineQueue.id);
    assert(row(offline)?.deliveryState === 'queued' && row(offline)?.deliveryError === undefined, 'successful offline handoff looked like a failed send');
    receive('channel-messages', { channelId: 'general', messages: [] });
    assert(row(offline)?.deliveryState === 'queued', 'history replacement lost the queued optimistic row');
    connected.set(true); await drainOutboundQueue();
    assert(row(offline)?.deliveryState === 'sending', 'queued message did not enter its submitted state');
    receive('message-accepted', receipt(offline));
    await until(async () => (await queueRow(offlineQueue.id)).status === 'synced');
    assert(row(offline)?.deliveryState === undefined, 'accepted offline message stayed pending');

    const realm = groupMembership.realm()!;
    const queuedId = await db.enqueue({ scopeId: 'corechat', type: 'send-message', payload: {
      channelId: 'general', clientMessageId: 'receipt-queue', text: 'queued', type: 'text' } }); ids.push(queuedId);
    receive('message-accepted', receipt('receipt-queue'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert((await queueRow(queuedId)).status === 'pending', 'unattempted queue row accepted by stray receipt');
    await drainOutboundQueue();
    assert((await queueRow(queuedId)).attemptedAt !== undefined, 'queue attempt not durable before emit');
    // Cross-account/type/channel ID collisions may not settle with this receipt.
    for (const [suffix, overrides] of Object.entries({
      account: { authority: { realm: 'another-account' } },
      channel: { payload: { channelId: 'another-channel', clientMessageId: 'receipt-queue' } },
      type: { type: 'edit-message' }
    })) {
      const copy = { ...await queueRow(queuedId), ...overrides, id: `receipt-${suffix}`, key: `corechat:receipt-${suffix}` };
      ids.push(copy.id); await raw.put(copy.key, copy);
    }
    messageDeliveries.unconfirm(controls.socket(), { channelId: 'general', clientMessageId: 'receipt-queue' });
    await until(async () => (await queueRow(queuedId)).deliveryOutcome === 'unknown');
    receive('message-error', { ...receipt('receipt-queue'), outcome: 'rejected', error: 'Denied before write' });
    await until(async () => (await queueRow(queuedId)).deliveryOutcome === 'rejected');
    receive('message-error', { ...receipt('receipt-queue'), outcome: 'unknown' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert((await queueRow(queuedId)).error === 'Not sent: Denied before write', 'late uncertainty replaced classified queue result');
    receive('message-accepted', receipt('receipt-queue'));
    await until(async () => (await queueRow(queuedId)).status === 'synced');
    await db.settleMessageReceipt('general', 'receipt-queue', realm, { status: 'failed', error: 'late timeout', outcome: 'unknown' });
    assert((await queueRow(queuedId)).status === 'synced', 'timeout overwrote committed acceptance');
    for (const suffix of ['account', 'channel', 'type']) assert((await queueRow(`receipt-${suffix}`)).status === 'pending', 'receipt adopted another queue owner');

    // Remove only these isolated collision fixtures before general drain.
    for (const suffix of ['account', 'channel', 'type']) await raw.delete(`corechat:receipt-${suffix}`);

    // Reconnect can finish both its drains while the original enqueue is still
    // waiting to commit. The enqueue handoff itself must schedule the next pass.
    {
      const originalEnqueue = db.enqueue; const commitGate = gate();
      let clientId = ''; let storedId = ''; let handoff: ReturnType<typeof sendMessage> | undefined;
      db.enqueue = async action => {
        clientId = (action.payload as { clientMessageId: string }).clientMessageId;
        await commitGate.wait;
        storedId = await originalEnqueue.call(db, action); ids.push(storedId);
        return storedId;
      };
      try {
        connected.set(false);
        handoff = sendMessage('general', 'commit after reconnect drains');
        await until(async () => !!clientId);
        controls.install(); controls.init(); currentUser.set(controls.owner);
        await drainOutboundQueue();
        assert(emitCount(clientId) === 0, 'uncommitted queue intent reached transport');
        commitGate.release();
        assert((await handoff).ok, 'delayed enqueue handoff failed');
        // Do not manually drain here: only production post-enqueue scheduling
        // can make this assertion pass after the reconnect drains saw nothing.
        await until(async () => emitCount(clientId) === 1);
        assert((await queueRow(storedId)).attemptedAt !== undefined, 'post-commit send was not durably claimed');
        receive('message-accepted', receipt(clientId));
        await until(async () => (await queueRow(storedId)).status === 'synced');
        await drainOutboundQueue();
        assert(emitCount(clientId) === 1, 'post-commit replay duplicated the message');
      } finally {
        commitGate.release(); db.enqueue = originalEnqueue;
        await handoff?.catch(() => undefined);
      }
    }

    // The inverse race: persistence finishes and reconnect delivers/accepts
    // the message before the caller's enqueue promise finishes returning.
    {
      const originalEnqueue = db.enqueue; const returnGate = gate();
      let clientId = ''; let storedId = ''; let handoff: ReturnType<typeof sendMessage> | undefined;
      db.enqueue = async action => {
        storedId = await originalEnqueue.call(db, action); ids.push(storedId);
        clientId = (action.payload as { clientMessageId: string }).clientMessageId;
        await returnGate.wait;
        return storedId;
      };
      try {
        connected.set(false);
        handoff = sendMessage('general', 'accepted before enqueue returns');
        await until(async () => !!storedId);
        controls.install(); controls.init(); currentUser.set(controls.owner);
        await drainOutboundQueue();
        assert(emitCount(clientId) === 1, 'committed queue intent did not drain during suspended handoff');
        receive('message-accepted', receipt(clientId));
        await until(async () => (await queueRow(storedId)).status === 'synced');
        assert(row(clientId)?.deliveryState === undefined, 'acceptance did not settle suspended handoff');
        returnGate.release();
        assert((await handoff).ok, 'accepted queue handoff failed');
        await drainOutboundQueue();
        assert(row(clientId)?.deliveryState === undefined && row(clientId)?.deliveryError === undefined,
          'late enqueue continuation downgraded accepted message to queued');
        assert(emitCount(clientId) === 1, 'accepted enqueue continuation duplicated transport');
      } finally {
        returnGate.release(); db.enqueue = originalEnqueue;
        await handoff?.catch(() => undefined);
      }
    }

    // A real atomic claim can finish while logout/re-login restores the same
    // realm and leaves the same socket alive. Its old epoch must still retire.
    {
      await drainOutboundQueue();
      const clientId = `claim-aba-${crypto.randomUUID()}`;
      const storedId = await db.enqueue({ scopeId: 'corechat', type: 'send-message', payload: {
        channelId: 'general', clientMessageId: clientId, text: 'claim before logout', type: 'text' } }); ids.push(storedId);
      const originalClaim = db.claimMessage; const claimGate = gate();
      let paused = false; let pendingDrain: Promise<void> | undefined;
      db.claimMessage = async id => {
        const claimed = await originalClaim.call(db, id);
        if (id === storedId) { paused = true; await claimGate.wait; }
        return claimed;
      };
      try {
        pendingDrain = drainOutboundQueue();
        await until(async () => paused);
        assert((await queueRow(storedId)).attemptedAt !== undefined, 'ABA fixture did not perform its actual IndexedDB claim');
        const sameSocket = controls.socket();
        clearAuthSession(); setAuthToken(previous.token);
        assert(controls.socket() === sameSocket && sameSocket.connected, 'ABA fixture accidentally replaced its transport');
        claimGate.release(); await pendingDrain;
        assert(emitCount(clientId) === 0, 'claimed intent crossed explicit logout/re-login epoch');
        assert(!messageDeliveries.has(sameSocket, { channelId: 'general', clientMessageId: clientId }), 'retired claim registered a new deadline');
        assert((await queueRow(storedId)).status === 'failed' && (await queueRow(storedId)).retryable === false,
          'retired claimed intent remained eligible for replay');
      } finally {
        claimGate.release(); db.claimMessage = originalClaim;
        await pendingDrain?.catch(() => undefined);
        controls.install(); controls.init(); currentUser.set(controls.owner);
      }
    }

    // A previous attempt without this tab's tracker is uncertain, not an
    // unclassified permanent failure which discards a later definite rejection.
    {
      await drainOutboundQueue();
      const clientId = `prior-attempt-${crypto.randomUUID()}`;
      const storedId = await db.enqueue({ scopeId: 'corechat', type: 'send-message', payload: {
        channelId: 'general', clientMessageId: clientId, text: 'previous attempt', type: 'text' } }); ids.push(storedId);
      assert(await db.claimMessage(storedId), 'prior-attempt fixture could not claim its own record');
      await drainOutboundQueue();
      assert((await queueRow(storedId)).deliveryOutcome === 'unknown', 'prior-attempt drain did not record classified uncertainty');
      assert(emitCount(clientId) === 0, 'prior attempt was replayed without server idempotency');
      receive('message-error', { ...receipt(clientId), outcome: 'rejected', error: 'Rejected before write' });
      await until(async () => (await queueRow(storedId)).deliveryOutcome === 'rejected');
      assert((await queueRow(storedId)).error === 'Not sent: Rejected before write', 'late rejection could not clarify previous attempt');
    }

    // A new request may arrive after a pass has checked `requested`, before
    // a separate Promise.finally callback would release its in-flight owner.
    {
      await drainOutboundQueue();
      const clientId = `drain-tail-${crypto.randomUUID()}`;
      const storedId = await db.enqueue({ scopeId: 'corechat', type: 'send-message', payload: {
        channelId: 'general', clientMessageId: clientId, text: 'queued at drain tail', type: 'text' } }); ids.push(storedId);
      const originalList = db.listQueue;
      let passes = 0; let tailDrain: Promise<void> | undefined;
      db.listQueue = async filter => {
        const result = await originalList.call(db, filter);
        if (++passes === 1) {
          // First snapshot predates enqueue. Request a pass at the retiring
          // drain's microtask boundary, not manually after awaiting it.
          queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { tailDrain = drainOutboundQueue(); })));
          return [];
        }
        return result;
      };
      try {
        await drainOutboundQueue();
        await until(async () => emitCount(clientId) === 1);
        await tailDrain;
        receive('message-accepted', receipt(clientId));
        await until(async () => (await queueRow(storedId)).status === 'synced');
      } finally {
        db.listQueue = originalList;
        await tailDrain?.catch(() => undefined);
      }
    }

    const unowned = 'receipt-unowned'; ids.push(unowned);
    await raw.put(`corechat:${unowned}`, { id: unowned, key: `corechat:${unowned}`, scopeId: 'corechat', type: 'send-message',
      status: 'pending', createdAt: Date.now(), payload: { channelId: 'general', clientMessageId: unowned, text: 'unowned' } });
    const sentBefore = controls.socket().sent.filter(([event]: [string]) => event === 'message').length;
    await drainOutboundQueue(); await db.retryFailed(); await drainOutboundQueue();
    assert((await queueRow(unowned)).retryable === false, 'unowned legacy message remained retryable');
    assert(controls.socket().sent.filter(([event]: [string]) => event === 'message').length === sentBefore, 'unowned old intent replayed as new account');

    setAuthToken(null); connected.set(false);
    const noOwner = await sendMessage('general', 'guest offline draft');
    assert(!noOwner.ok, 'unowned offline message reported queued');
    assert(get(channelMessages).general.at(-1)?.deliveryError?.includes('signed-in account'), 'ownership failure falsely blamed storage');
    return true;
  } finally {
    for (const id of ids) await raw.delete(`corechat:${id}`);
    setAuthToken(previous.token); controls.install(); controls.init();
    channelMessages.set(previous.messages); currentUser.set(previous.user);
  }
}
