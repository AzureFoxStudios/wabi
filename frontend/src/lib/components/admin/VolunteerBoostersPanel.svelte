<script lang="ts">
    import { onMount } from 'svelte';
    import { activeServerUrl } from '$lib/serverUrl';
    import { getAuthToken } from '$lib/authSession';
    import { infrastructureRequest } from '$lib/api/infrastructure';
    type Session = { id: string; owner: number; name: string; heartbeatAt: number; sentBytes: number; verifiedBytes: number; cachedFiles: number; cachedBytes: number; uploadKiBPerSecond: number; cacheMiB: number; sessionMiB: number };
    type Snapshot = { observedAt: number; enabled: boolean; sessions: Session[]; recipientConfirmedBytes: number; completedTransfers: number };
    let data: Snapshot | null = $state(null); let busy = $state(false); let error = $state(''); let at = $state(0); let epoch = 0; let scope = '';
    function mib(n: number) { return `${(n / 1048576).toFixed(2)} MiB`; }
    async function refresh() { const server = $activeServerUrl; const n = ++epoch; try { const result = await infrastructureRequest<Snapshot>(getAuthToken(server), '/api/boosters/admin'); if (n === epoch && server === $activeServerUrl) { data = result; at = result.observedAt; error = ''; } } catch (e) { if (n === epoch) error = e instanceof Error ? e.message : String(e); } }
    async function change(path: string, method: string, body?: unknown) { busy = true; try { await infrastructureRequest(getAuthToken($activeServerUrl), path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); await refresh(); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; } }
    $effect(() => { if (scope !== $activeServerUrl) { scope = $activeServerUrl; data = null; epoch++; void refresh(); } });
    onMount(() => { void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); return () => { epoch++; clearInterval(timer); }; });
</script>
<section class="boosters" aria-label="Volunteer boosters">
    <header><div><h3>Volunteer boosters</h3><p>Optional file delivery. The Authority keeps the community and the original files.</p></div><button disabled={busy} onclick={refresh}>Refresh</button></header>
    {#if error}<p class="error" role="alert">{error}. {data ? 'Showing the last known sample.' : ''}</p>{/if}
    {#if data}
        <button disabled={busy || !!error} onclick={() => change('/api/boosters/policy', 'PUT', { enabled: !data?.enabled })}>{data.enabled ? 'Disable volunteer boosting' : 'Allow members to volunteer'}</button>
        <p>{data.enabled ? 'Members can opt in from Settings → Server. No one contributes automatically.' : 'Volunteer boosting is disabled.'}</p>
        <dl><div><dt>Available volunteers</dt><dd>{data.sessions.length}</dd></div><div><dt>Recipient-confirmed file bytes</dt><dd>{mib(data.recipientConfirmedBytes)}</dd></div><div><dt>Completed transfers</dt><dd>{data.completedTransfers}</dd></div></dl>
        <p>Updated {new Date(at).toLocaleTimeString()}. Confirmation comes from signed-in recipients after a hash check. These are payload bytes, not an independent measurement of bandwidth saved. Counters reset when the server restarts.</p>
        {#each data.sessions as s (s.id)}
            <article><header><strong>{s.name}</strong><span>{s.verifiedBytes > 0 ? 'Has delivered files' : s.cachedFiles > 0 ? 'Available · waiting for a request' : 'Ready · no cached files'}</span></header>
                <p>Member {s.owner} · heartbeat {Math.max(0, Math.round((at-s.heartbeatAt)/1000))}s ago</p>
                <p>{s.cachedFiles} cached files ({mib(s.cachedBytes)}). Reported sent: {mib(s.sentBytes)}. Recipient confirmed: {mib(s.verifiedBytes)}.</p>
                <p>Volunteer limits: {s.uploadKiBPerSecond} KiB/s upload, {s.cacheMiB} MiB memory, {s.sessionMiB} MiB per session.</p>
                <button disabled={busy} onclick={() => change(`/api/boosters/sessions/${s.id}`, 'DELETE')}>Stop this session</button>
            </article>
        {:else}<p>No volunteers currently available. Normal server downloads continue.</p>{/each}
    {:else if !error}<p>Loading volunteer status…</p>{/if}
</section>
<style>
.boosters{padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2);display:grid;gap:var(--space-3)}header{display:flex;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}h3,p,dl{margin:0}p,dt,header span{color:var(--w-mute)}dl{display:flex;gap:var(--space-5);flex-wrap:wrap}dd{margin:var(--space-2) 0;font-weight:600}article{padding:var(--space-3);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));display:grid;gap:var(--space-2)}button{justify-self:start;align-self:start;padding:var(--space-2) var(--space-3);background:var(--w-raise);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));cursor:pointer}.error{color:var(--w-danger)}
</style>
