// Actual calling entry points; only HTTP/Socket.IO are fixture boundaries.
import { get } from 'svelte/store';
import { joinVoiceChannel, leaveVoiceChannel, isInCall, localStream } from '../src/lib/calling_impl_core';
import { setAuthToken } from '../src/lib/authSession';
import { callSessions } from '../src/lib/callSessionManager';

function assert(value: unknown, label: string) { if (!value) throw new Error(label); }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function run() {
  const results: string[] = [];
  let microphoneRequests = 0;
  navigator.mediaDevices.getUserMedia = async () => { microphoneRequests++; throw new Error('Unexpected microphone acquisition'); };
  setAuthToken('voice-test-only');
  const originalFetch = window.fetch;
  try {
    for (const outcome of ['membership-denied', 'server-denied', 'cancel-membership', 'cancel-admission']) {
      let finishMembership!: () => void;
      const listeners = new Map<string, Set<(data: any) => void>>();
      const sent: [string, any][] = [];
      const socket = {
        id: 'voice-fixture', connected: true,
        on(event: string, fn: (data: any) => void) { const set = listeners.get(event) ?? new Set(); set.add(fn); listeners.set(event, set); return this; },
        off(event: string, fn: (data: any) => void) { listeners.get(event)?.delete(fn); return this; },
        emit(event: string, data: any) {
          sent.push([event, data]);
          if (event === 'voice-channel-join' && outcome === 'server-denied') {
            queueMicrotask(() => listeners.get('voice-channel-error')?.forEach(fn => fn({ ...data, error: 'Fixture access denied' })));
          }
          return this;
        }
      };
      window.fetch = (async (url: RequestInfo | URL) => {
        assert(String(url).includes(`/api/channels/${outcome}/join`), `unexpected HTTP ${url}`);
        if (outcome === 'cancel-membership') await new Promise<void>(resolve => { finishMembership = resolve; });
        return new Response(JSON.stringify(outcome === 'membership-denied'
          ? { error: 'Fixture access denied' } : { joined: true, channelId: outcome }),
          { status: outcome === 'membership-denied' ? 403 : 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const joining = joinVoiceChannel(socket as any, outcome);
      assert(joinVoiceChannel(socket as any, outcome) === joining, 'duplicate clicks coalesce');
      const result = joining.then(() => 'unexpected success', error => String(error));
      await tick();
      if (outcome.startsWith('cancel-')) {
        await leaveVoiceChannel(socket as any, outcome);
        if (outcome === 'cancel-membership') finishMembership();
      }
      assert(await result !== 'unexpected success', `${outcome} must reject`);
      assert(!get(isInCall) && !get(localStream), `${outcome} leaves no fake call/microphone`);
      assert(get(callSessions).size === 0, `${outcome} leaves no session`);
      assert([...listeners.values()].every(set => set.size === 0), `${outcome} cleans admission waiters`);
      if (outcome === 'membership-denied' || outcome === 'cancel-membership') {
        assert(!sent.some(([event]) => event === 'voice-channel-join'), `${outcome} never requests admission`);
      }
      results.push(`${outcome}: actual call entry rejects, coalesces and cleans up without capture`);
    }
    assert(microphoneRequests === 0, 'no microphone requested before admission');
    return results;
  } finally { window.fetch = originalFetch; setAuthToken(null); }
}
(window as any).__audioSmoke = { status: 'ready' };
document.querySelector('#run')!.addEventListener('click', () => {
  (window as any).__audioSmoke = { status: 'running' };
  void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; },
    error => { (window as any).__audioSmoke = { status: 'failed', error: String(error) }; });
});
