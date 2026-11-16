<script lang="ts">
	import { _ } from '$lib/i18n';
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
<section class="boosters" aria-label={$_('boosters.label')}>
    <header><div><h3>{$_('boosters.title')}</h3><p>{$_('boosters.intro')}</p></div><button disabled={busy} onclick={refresh}>{$_('boosters.refresh')}</button></header>
    {#if error}<p class="error" role="alert">{error}. {data ? $_('boosters.last_sample') : ''}</p>{/if}
    {#if data}
        <button disabled={busy || !!error} onclick={() => change('/api/boosters/policy', 'PUT', { enabled: !data?.enabled })}>{data.enabled ? $_('boosters.disable') : $_('boosters.allow')}</button>
        <p>{data.enabled ? $_('boosters.opt_in_note') : $_('boosters.disabled_note')}</p>
        <dl><div><dt>{$_('boosters.available')}</dt><dd>{data.sessions.length}</dd></div><div><dt>{$_('boosters.confirmed_bytes')}</dt><dd>{mib(data.recipientConfirmedBytes)}</dd></div><div><dt>{$_('boosters.completed')}</dt><dd>{data.completedTransfers}</dd></div></dl>
        <p>{$_('boosters.updated', { values: { time: new Date(at).toLocaleTimeString() } })}</p>
        {#each data.sessions as s (s.id)}
            <article><header><strong>{s.name}</strong><span>{s.verifiedBytes > 0 ? $_('boosters.status_delivered') : s.cachedFiles > 0 ? $_('boosters.status_waiting') : $_('boosters.status_ready')}</span></header>
                <p>{$_('boosters.member_heartbeat', { values: { owner: s.owner, seconds: Math.max(0, Math.round((at-s.heartbeatAt)/1000)) } })}</p>
                <p>{$_('boosters.session_stats', { values: { cached: s.cachedFiles, cachedBytes: mib(s.cachedBytes), sent: mib(s.sentBytes), verified: mib(s.verifiedBytes) } })}</p>
                <p>{$_('boosters.limits', { values: { upload: s.uploadKiBPerSecond, cacheMiB: s.cacheMiB, sessionMiB: s.sessionMiB } })}</p>
                <button disabled={busy} onclick={() => change(`/api/boosters/sessions/${s.id}`, 'DELETE')}>{$_('boosters.stop_session')}</button>
            </article>
        {:else}<p>{$_('boosters.none')}</p>{/each}
    {:else if !error}<p>{$_('boosters.loading')}</p>{/if}
</section>
<style>
.boosters{padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2);display:grid;gap:var(--space-3)}header{display:flex;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}h3,p,dl{margin:0}p,dt,header span{color:var(--w-mute)}dl{display:flex;gap:var(--space-5);flex-wrap:wrap}dd{margin:var(--space-2) 0;font-weight:600}article{padding:var(--space-3);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));display:grid;gap:var(--space-2)}button{justify-self:start;align-self:start;padding:var(--space-2) var(--space-3);background:var(--w-raise);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));cursor:pointer}.error{color:var(--w-danger)}
</style>
