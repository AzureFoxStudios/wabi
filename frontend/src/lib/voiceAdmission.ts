import type { Socket } from 'socket.io-client';

type AdmissionSocket = Pick<Socket, 'id' | 'connected' | 'on' | 'off' | 'emit'>;
type Reply = { channelId?: string; requestId?: string; error?: string; message?: string; established?: boolean };
let nextRequest = 0;

/** Control-plane admission must finish before either media transport starts.
 * Never infer admission from a global roster broadcast or a local emit. */
export async function requestVoiceAdmission(
  socket: AdmissionSocket,
  channelId: string,
  listeningOnly: boolean,
  ensureMembership: (channelId: string) => Promise<unknown>,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<void> {
  await requestAdmission(socket, channelId, listeningOnly ? 'voice-channel-subscribe' : 'voice-channel-join',
    'voice-channel-admitted', 'voice-channel-error', {}, ensureMembership, signal, timeoutMs);
}

export function requestGroupCallAnswer(
  socket: AdmissionSocket, channelId: string, callerId: string, isVideoCall: boolean,
  ensureMembership: (channelId: string) => Promise<unknown>, signal?: AbortSignal,
): Promise<void> {
  return requestAdmission(socket, channelId, 'call-answer', 'group-call-admitted', 'call-error',
    { callerId, isVideoCall }, ensureMembership, signal, 10_000).then(() => {});
}

export function requestGroupCallStart(
  socket: AdmissionSocket, channelId: string, isVideoCall: boolean,
  ensureMembership: (channelId: string) => Promise<unknown>, signal?: AbortSignal,
): Promise<boolean> {
  return requestAdmission(socket, channelId, 'call-initiate', 'group-call-started', 'call-error',
    { isVideoCall }, ensureMembership, signal, 10_000).then(reply => reply.established === true);
}

/** Resume only the membership incarnation the user actually joined. This is
 * deliberately non-ringing, including after an empty server runtime restart. */
export function requestGroupCallReadmission(
  socket: AdmissionSocket, channelId: string, membershipRevision: string,
  ensureMembership: (channelId: string) => Promise<unknown>, signal?: AbortSignal,
): Promise<void> {
  return requestAdmission(socket, channelId, 'call-initiate', 'group-call-started', 'call-error',
    { rejoin: true, membershipRevision }, ensureMembership, signal, 10_000).then(() => {});
}

async function requestAdmission(
  socket: AdmissionSocket, channelId: string, event: string, successEvent: string, errorEvent: string,
  data: Record<string, unknown>, ensureMembership: (channelId: string) => Promise<unknown>,
  signal: AbortSignal | undefined, timeoutMs: number,
): Promise<Reply> {
  signal?.throwIfAborted();
  const socketId = socket.id;
  if (!socket.connected) throw new Error('Voice admission requires a connection');
  await ensureMembership(channelId);
  signal?.throwIfAborted();
  if (!socket.connected || socket.id !== socketId) throw new Error('Connection changed during voice admission');
  const requestId = `voice-${++nextRequest}`;
  return new Promise<Reply>((resolve, reject) => {
    let settled = false;
    const matches = (reply: Reply) => reply?.channelId === channelId && reply.requestId === requestId;
    const finish = (error?: Error, reply: Reply = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off(successEvent, admitted);
      socket.off(errorEvent, denied);
      socket.off('disconnect', disconnected);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(reply);
    };
    const admitted = (reply: Reply) => {
      if (matches(reply)) finish(socket.connected && socket.id === socketId
        ? undefined : new Error('Connection changed during voice admission'), reply);
    };
    const denied = (reply: Reply) => { if (matches(reply)) finish(new Error(reply.error || reply.message || 'Voice admission denied')); };
    const disconnected = () => finish(new Error('Disconnected during voice admission'));
    const aborted = () => finish(new DOMException('Voice admission cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Voice admission timed out')), timeoutMs);
    socket.on(successEvent, admitted);
    socket.on(errorEvent, denied);
    socket.on('disconnect', disconnected);
    signal?.addEventListener('abort', aborted, { once: true });
    try { socket.emit(event, { ...data, channelId, requestId }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
