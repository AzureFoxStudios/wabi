<script lang="ts">
	import { _ } from '$lib/i18n';
    import { onMount } from 'svelte';
    import { activeServerUrl } from '$lib/serverUrl';
    import { getAuthToken } from '$lib/authSession';
    import { infrastructureRequest, type NetworkHealth } from '$lib/api/infrastructure';
    import { readEndpointHealth, type EndpointHealth } from '$lib/api/endpointHealth';
    let snapshot: NetworkHealth | null = $state(null);
    let endpoint: EndpointHealth | null = $state(null);
    let endpointError = $state('');
    let latency: number | null = $state(null);
    let error = $state('');
    let loading = $state(false);
    let epoch = 0;
    let currentScope = '';
    function value(n: number | null | undefined, suffix = '') { return n == null ? $_('network_health.not_measured') : `${n.toFixed(1)}${suffix}`; }
    function bytes(n: number | null | undefined) { return n == null ? $_('network_health.not_measured') : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`; }
    async function refresh() {
        if (loading) return;
        loading = true;
        const scope = $activeServerUrl;
        const request = ++epoch;
        const start = performance.now();
        const [measurement, endpointProbe] = await Promise.allSettled([
            infrastructureRequest<NetworkHealth>(getAuthToken(scope), '/api/admin/network-health')
                .then(data => ({ data, elapsed: performance.now() - start })),
            readEndpointHealth(scope)
        ]);
        if (request !== epoch || scope !== $activeServerUrl) return;
        if (measurement.status === 'fulfilled') {
            snapshot = measurement.value.data; latency = measurement.value.elapsed; error = '';
        } else {
            const cause = measurement.reason;
            error = cause instanceof Error ? cause.message : String(cause); latency = null;
        }
        if (endpointProbe.status === 'fulfilled') {
            endpoint = endpointProbe.value; endpointError = '';
        } else {
            const cause = endpointProbe.reason;
            endpoint = null; endpointError = cause instanceof Error ? cause.message : String(cause);
        }
        loading = false;
    }
    $effect(() => {
        if (currentScope !== $activeServerUrl) { currentScope = $activeServerUrl; epoch++; snapshot = null; endpoint = null; endpointError = ''; latency = null; loading = false; error = ''; void refresh(); }
    });
    onMount(() => { void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); return () => { epoch++; clearInterval(timer); }; });
</script>
<section class="health-panel" aria-label={$_('network_health.title')}>
    <header><div><h3>{$_('network_health.title')}</h3><p>{$_('network_health.desc')}</p></div><button onclick={refresh} disabled={loading}>{loading ? $_('network_health.checking') : $_('network_health.refresh')}</button></header>
    <div class="endpoint-role">
        <strong>{$_('network_health.selected_entry')}: {endpoint ? (endpoint.role === 'authority' ? $_('network_health.authority') : $_('network_health.anchor')) : $_('network_health.unverified')}</strong>
        {#if endpoint?.role === 'authority'}
            <p>{$_('network_health.authority_desc', { values: { status: endpoint.status } })}</p>
        {:else if endpoint?.role === 'anchor'}
            <p>{$_('network_health.anchor_desc')}</p>
        {:else}
            <p>{$_('network_health.no_role')}{endpointError ? ` ${endpointError}` : ''}</p>
        {/if}
    </div>
    {#if error}<p class="error" role="alert">{$_('network_health.unavailable', { values: { error } })} {snapshot ? $_('network_health.last_ok') : ''}</p>{/if}
    {#if snapshot}
        <p class="stamp">{error ? $_('network_health.last_known') : $_('network_health.observed')} {new Date(snapshot.observedAt).toLocaleTimeString()}</p>
        <dl>
            <div><dt>{$_('network_health.device_to_server')}</dt><dd>{value(latency, ' ms')}</dd></div>
            <div><dt>{$_('network_health.cpu')}</dt><dd>{value(snapshot.processCpuPercent, $_('network_health.cpu_suffix'))}</dd></div>
            <div><dt>{$_('network_health.memory')}</dt><dd>{bytes(snapshot.processMemoryBytes)}</dd></div>
            <div><dt>{$_('network_health.http_requests')}</dt><dd>{snapshot.httpRequestsTotal.toLocaleString()}</dd></div>
        </dl>
        <p>{$_('network_health.timing_note')}</p>
        <h4>{$_('network_health.interfaces')}</h4>
        <p>{$_('network_health.scope_note')}</p>
        {#if snapshot.interfaces.length}
            <div class="table-wrap"><table><thead><tr><th>{$_('network_health.interface')}</th><th>{$_('network_health.receiving')}</th><th>{$_('network_health.sending')}</th></tr></thead><tbody>
            {#each snapshot.interfaces as item (item.name)}<tr><td>{item.name}</td><td>{item.receivedBytesPerSecond == null ? $_('network_health.waiting_sample') : `${bytes(item.receivedBytesPerSecond)}/s`}</td><td>{item.sentBytesPerSecond == null ? $_('network_health.waiting_sample') : `${bytes(item.sentBytesPerSecond)}/s`}</td></tr>{/each}
            </tbody></table></div>
        {:else}<p>{$_('network_health.interfaces_unavailable')}</p>{/if}
        <details><summary>{$_('network_health.boundaries_summary')}</summary><p>{$_('network_health.boundaries')}</p></details>
    {:else if !error}<p>{$_('network_health.waiting')}</p>{/if}
</section>
<style>
.health-panel{padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2)}header{display:flex;justify-content:space-between;gap:var(--space-3)}h3,h4,p{margin:0 0 var(--space-3)}p,dt,.stamp{color:var(--w-mute)}.endpoint-role{padding:var(--space-3);margin-bottom:var(--space-3);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));background:var(--w-raise)}.endpoint-role strong{display:block;margin-bottom:var(--space-2);color:var(--w-text)}.endpoint-role p{margin:0}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}dd{margin:var(--space-2) 0;font-weight:600;color:var(--w-text)}button{align-self:start;padding:var(--space-2) var(--space-3);background:var(--w-raise);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));cursor:pointer}.table-wrap{overflow:auto}table{width:100%;text-align:left;border-collapse:collapse}th,td{padding:var(--space-2);border-bottom:1px solid var(--w-line-strong)}details{margin-top:var(--space-3)}summary{cursor:pointer}.error{color:var(--w-danger)}@media(max-width:480px){dl{grid-template-columns:1fr}}
</style>
