import { get, writable } from 'svelte/store';
import { activeServerUrl, getServerUrl } from './serverUrl';
import { authSessionGeneration, getAuthToken, getStoredDbUserId, onAuthSessionCleared } from './authSession';
import { getStunServers } from './turnConfig';
import { BoosterCache, boosterPath, contentHash, MAX_BOOST_FILE, type BoostFile } from './boosterBudget';

export const boosterState = writable({ active: false, receiving: false, cachedBytes: 0, cachedFiles: 0, sentBytes: 0, receivedBytes: 0, notice: 'Boosting is off.' });
export interface BoostLimits { name: string; uploadKiBPerSecond: number; cacheMiB: number; sessionMiB: number }
interface Scope { server: string; account: number | null; generation: number }
interface Running { id: string; scope: Scope; limits: BoostLimits; cache: BoosterCache; timer: ReturnType<typeof setInterval>; sent: number; polling: boolean; sending: boolean; peers: Set<RTCPeerConnection>; abort: AbortController }
let running: Running | null = null;
let receiverScope: Scope | null = null;
let receiveAbort = new AbortController();
let observed = false;
let starting = false;
let generation = 0;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function scope(): Scope { const server = getServerUrl(); return { server, account: getStoredDbUserId(server), generation: authSessionGeneration(server) }; }
function valid(s: Scope) { const current = scope(); return s.server === current.server && s.account === current.account && s.generation === current.generation; }
async function request<T>(s: Scope, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
    if (!valid(s)) throw new Error('Account or server changed');
    const token = getAuthToken(s.server); if (!token) throw new Error('Sign in to this server');
    const response = await fetch(`${s.server}/api/boosters${path}`, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!valid(s)) throw new Error('Account or server changed');
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `Booster request failed (${response.status})`);
    return response.json();
}
function observe() {
    if (observed || typeof window === 'undefined') return; observed = true;
    const changed = () => { if ((running && !valid(running.scope)) || (receiverScope && !valid(receiverScope))) { void stopBoosting('Boosting stopped when the account or server changed.'); setPeerDownloads(false); boosterState.update(s => ({ ...s, sentBytes: 0, receivedBytes: 0 })); } };
    const a = activeServerUrl.subscribe(changed); const b = onAuthSessionCleared(() => { void stopBoosting('Signed out.'); setPeerDownloads(false); boosterState.update(s => ({ ...s, sentBytes: 0, receivedBytes: 0 })); });
    window.addEventListener('pagehide', () => { void stopBoosting('App closed.'); setPeerDownloads(false); });
    import.meta.hot?.dispose(() => { a(); b(); void stopBoosting('App updated.'); setPeerDownloads(false); });
}
export function canBoost() { return typeof RTCPeerConnection !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle; }
export function setPeerDownloads(on: boolean) {
    observe(); receiveAbort.abort(); receiveAbort = new AbortController(); receiverScope = on ? scope() : null;
    boosterState.update(s => ({ ...s, receiving: on }));
}
export async function startBoosting(limits: BoostLimits) {
    observe(); if (running || starting) throw new Error('A booster is already starting or running');
    if (!canBoost()) throw new Error('This browser needs a secure connection and WebRTC support');
    const captured = scope(); const turn = ++generation; starting = true;
    try {
        const { id } = await request<{ id: string }>(captured, '/sessions', { ...limits, consent: true });
        if (turn !== generation || !valid(captured)) { void request(captured, `/sessions/${id}`, undefined, 'DELETE').catch(() => {}); return; }
        const session: Running = { id, scope: captured, limits, cache: new BoosterCache(limits.cacheMiB * 1048576), sent: 0, polling: false, sending: false, peers: new Set(), abort: new AbortController(), timer: setInterval(() => { void poll(session); }, 2000) };
        running = session;
        boosterState.set({ active: true, receiving: get(boosterState).receiving, cachedBytes: 0, cachedFiles: 0, sentBytes: 0, receivedBytes: get(boosterState).receivedBytes, notice: 'Ready. Eligible files you download can be shared for five minutes while Wabi stays open.' });
        void poll(session);
    } finally { starting = false; }
}
export async function stopBoosting(notice = 'Boosting stopped. Cached files cleared.') {
    generation++; const session = running; running = null;
    if (session) { clearInterval(session.timer); session.abort.abort(); session.peers.forEach(p => p.close()); session.cache.clear(); }
    boosterState.update(s => ({ ...s, active: false, cachedBytes: 0, cachedFiles: 0, notice }));
    if (session && valid(session.scope)) await request(session.scope, `/sessions/${session.id}`, undefined, 'DELETE').catch(() => {});
}
function publish(session: Running) {
    if (running !== session) return;
    boosterState.update(s => ({ ...s, cachedBytes: session.cache.size, cachedFiles: session.cache.files.length, sentBytes: session.sent }));
}
async function poll(session: Running) {
    if (running !== session || session.polling) return; session.polling = true;
    try {
        const result = await request<{ acceptedPaths: string[] }>(session.scope, `/sessions/${session.id}/heartbeat`, { files: session.cache.files, sentBytes: session.sent }, 'POST', session.abort.signal);
        if (running !== session) return;
        session.cache.retain(result.acceptedPaths); publish(session);
        const { offers } = await request<{ offers: { id: string; file: BoostFile; offer: string }[] }>(session.scope, `/sessions/${session.id}/offers`, undefined, 'GET', session.abort.signal);
        if (offers.length && !session.sending && running === session) void serve(session, offers[0]);
    } catch { if (running === session) await stopBoosting('Boosting paused because the server could not renew access. Start again when connected.'); }
    finally { session.polling = false; }
}
async function gather(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
    const end = Date.now() + 3000;
    while (peer.iceGatheringState !== 'complete' && Date.now() < end) { if (signal.aborted || peer.connectionState === 'closed') throw new Error('Stopped'); await sleep(30); }
}
function peer() { return new RTCPeerConnection({ iceServers: getStunServers() }); } // No TURN: never move booster traffic through the Authority's relay.
async function serve(session: Running, offer: { id: string; file: BoostFile; offer: string }) {
    session.sending = true;
    const connection = peer(); session.peers.add(connection);
    const timeout = setTimeout(() => connection.close(), 22000);
    try {
        const bytes = session.cache.get(offer.file);
        if (!bytes || session.sent + bytes.byteLength > session.limits.sessionMiB * 1048576 || bytes.byteLength > session.limits.uploadKiBPerSecond * 1024 * 15) return;
        let sending: Promise<void> | null = null;
        let channelClosed = false;
        connection.ondatachannel = event => {
            const channel = event.channel;
            if (channel.label !== 'wabi-file-boost') { channel.close(); return; }
            channel.onclose = () => { channelClosed = true; };
            channel.onopen = () => {
                if (sending) return;
                sending = (async () => {
                    for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024) {
                        const chunk = bytes.slice(offset, offset + 16 * 1024);
                        await sleep(chunk.byteLength * 1000 / (session.limits.uploadKiBPerSecond * 1024));
                        while (channel.bufferedAmount > 64 * 1024 && channel.readyState === 'open' && running === session) await sleep(20);
                        if (running !== session || !valid(session.scope) || channel.readyState !== 'open') throw new Error('Stopped');
                        if (session.sent + chunk.byteLength > session.limits.sessionMiB * 1048576) throw new Error('Session limit reached');
                        channel.send(chunk); session.sent += chunk.byteLength; publish(session);
                    }
                    if (channel.readyState === 'open') channel.send('complete');
                })().catch(() => connection.close());
            };
        };
        await connection.setRemoteDescription({ type: 'offer', sdp: offer.offer });
        await connection.setLocalDescription(await connection.createAnswer()); await gather(connection, session.abort.signal);
        await request(session.scope, `/tickets/${offer.id}/answer`, { answer: connection.localDescription?.sdp }, 'POST', session.abort.signal);
        const end = Date.now() + 20000;
        while (running === session && !channelClosed && connection.connectionState !== 'closed' && connection.connectionState !== 'failed' && Date.now() < end) await sleep(100);
    } catch { /* Recipient uses the Authority when a direct path is unavailable. */ }
    finally { clearTimeout(timeout); connection.close(); session.peers.delete(connection); session.sending = false; }
}
async function receive(captured: Scope, source: string, file: BoostFile, signal: AbortSignal): Promise<ArrayBuffer> {
    const connection = peer(); const channel = connection.createDataChannel('wabi-file-boost'); channel.binaryType = 'arraybuffer';
    const deadline = Date.now() + 22000;
    const transfer = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cancel = () => {};
    const result = new Promise<ArrayBuffer>((resolve, reject) => {
        let size = 0; const chunks: ArrayBuffer[] = [];
        cancel = () => { transfer.abort(); reject(new Error('Peer download stopped')); };
        timer = setTimeout(() => { transfer.abort(); reject(new Error('Peer download timed out')); }, 22000);
        signal.addEventListener('abort', cancel, { once: true });
        channel.onclose = () => reject(new Error('Booster left'));
        channel.onerror = () => reject(new Error('Booster connection failed'));
        channel.onmessage = event => {
            if (event.data === 'complete') {
                if (size !== file.size) { reject(new Error('Incomplete peer file')); return; }
                const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(new Uint8Array(part), offset); offset += part.byteLength; }
                resolve(bytes.buffer); return;
            }
            if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 65536 || size + event.data.byteLength > file.size || chunks.length > 8192) { reject(new Error('Invalid peer payload')); connection.close(); return; }
            chunks.push(event.data); size += event.data.byteLength;
        };
    });
    // Mark the promise handled while signaling is still in flight.
    void result.catch(() => {});
    try {
        if (signal.aborted) throw new Error('Stopped');
        await connection.setLocalDescription(await connection.createOffer()); await gather(connection, transfer.signal);
        const { id } = await request<{ id: string }>(captured, '/tickets', { source, path: file.path, offer: connection.localDescription?.sdp }, 'POST', transfer.signal);
        // Tailcat/NAT discovery can take longer than six seconds. Keep polling
        // within the same bounded transfer deadline; timeout also cancels HTTP.
        while (Date.now() < deadline) {
            if (signal.aborted || transfer.signal.aborted) throw new Error('Stopped');
            const { answer } = await request<{ answer: string | null }>(captured, `/tickets/${id}`, undefined, 'GET', transfer.signal);
            if (answer) { await connection.setRemoteDescription({ type: 'answer', sdp: answer }); break; }
            await sleep(300);
        }
        const bytes = await result;
        if (!valid(captured) || signal.aborted || await contentHash(bytes) !== file.hash) throw new Error('Peer file failed verification');
        void request(captured, `/tickets/${id}/receipt`, { hash: file.hash }).catch(() => {});
        boosterState.update(s => ({ ...s, receivedBytes: s.receivedBytes + bytes.byteLength }));
        return bytes;
    } finally { clearTimeout(timer!); transfer.abort(); signal.removeEventListener('abort', cancel); connection.close(); }
}
/** Used by explicit attachment downloads. Inline media remains on its normal origin path. */
export async function downloadWithBoosters(url: string): Promise<Blob> {
    observe(); const captured = scope(); const path = boosterPath(url, captured.server);
    const receiving = !!receiverScope && valid(receiverScope); const source = running;
    const receiveSignal = receiveAbort.signal; const requestedReceiver = receiverScope;
    let descriptor: { file: BoostFile; candidates: string[] } | null = null;
    if (path && canBoost() && (receiving || source)) {
        descriptor = await request<typeof descriptor>(captured, '/file', { path }).catch(() => null);
    }
    let bytes: ArrayBuffer | null = null;
    if (receiving && receiverScope === requestedReceiver && !receiveSignal.aborted && descriptor?.candidates.length && descriptor.file.size <= MAX_BOOST_FILE) {
        try { bytes = await receive(captured, descriptor.candidates[0], descriptor.file, receiveSignal); }
        catch { if (!valid(captured)) throw new Error('Account or server changed'); }
    }
    let blob: Blob;
    if (bytes) blob = new Blob([bytes]);
    else {
        // Request the supplied origin URL. Never forward account credentials to a peer.
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        blob = await response.blob();
    }
    if (!valid(captured)) throw new Error('Account or server changed');
    if (source && source === running && descriptor && blob.size <= MAX_BOOST_FILE) {
        const payload = bytes || await blob.arrayBuffer();
        if (await contentHash(payload) === descriptor.file.hash && source === running) { source.cache.put(descriptor.file, payload); publish(source); void poll(source); }
    }
    return blob;
}
