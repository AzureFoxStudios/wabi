<script lang="ts">
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
    function value(n: number | null | undefined, suffix = '') { return n == null ? 'Not measured' : `${n.toFixed(1)}${suffix}`; }
    function bytes(n: number | null | undefined) { return n == null ? 'Not measured' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`; }
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
<section class="health-panel" aria-label="Network health">
    <header><div><h3>Network health</h3><p>Fresh observations every five seconds while this view is open.</p></div><button onclick={refresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button></header>
    <div class="endpoint-role">
        <strong>Selected entry point: {endpoint ? (endpoint.role === 'authority' ? 'Authority' : 'Anchor') : 'Unverified'}</strong>
        {#if endpoint?.role === 'authority'}
            <p>This process owns community state. Its health check reports {endpoint.status}.</p>
        {:else if endpoint?.role === 'anchor'}
            <p>This process forwards chat and API work to the Authority. Its health check only confirms that the Anchor process responds; it cannot keep the community writable if the Authority stops.</p>
        {:else}
            <p>The selected address has not returned a recognized Wabi role.{endpointError ? ` ${endpointError}` : ''}</p>
        {/if}
    </div>
    {#if error}<p class="error" role="alert">Measurements unavailable: {error}. {snapshot ? 'Values below are from the last successful check.' : ''}</p>{/if}
    {#if snapshot}
        <p class="stamp">{error ? 'Last known sample' : 'Observed'} {new Date(snapshot.observedAt).toLocaleTimeString()}</p>
        <dl>
            <div><dt>This device → server</dt><dd>{value(latency, ' ms')}</dd></div>
            <div><dt>Authority process CPU</dt><dd>{value(snapshot.processCpuPercent, '% of one core')}</dd></div>
            <div><dt>Authority process memory</dt><dd>{bytes(snapshot.processMemoryBytes)}</dd></div>
            <div><dt>Authority HTTP requests since start</dt><dd>{snapshot.httpRequestsTotal.toLocaleString()}</dd></div>
        </dl>
        <p>Request time includes this device’s network, any Anchor, and the Authority response. It does not measure call delay. CPU needs two samples; 100% represents one logical core. These process and interface measurements come from the Authority even when this device connects through an Anchor.</p>
        <h4>Network interfaces</h4>
        <p>Traffic belongs to the server’s network namespace, including other applications. Overlay and physical interfaces may count the same traffic; these rows are never added together.</p>
        {#if snapshot.interfaces.length}
            <div class="table-wrap"><table><thead><tr><th>Interface</th><th>Receiving</th><th>Sending</th></tr></thead><tbody>
            {#each snapshot.interfaces as item (item.name)}<tr><td>{item.name}</td><td>{item.receivedBytesPerSecond == null ? 'Waiting for sample' : `${bytes(item.receivedBytesPerSecond)}/s`}</td><td>{item.sentBytesPerSecond == null ? 'Waiting for sample' : `${bytes(item.sentBytesPerSecond)}/s`}</td></tr>{/each}
            </tbody></table></div>
        {:else}<p>Interface measurements are unavailable on this host.</p>{/if}
        <details><summary>Measurement boundaries</summary><p>Available upload capacity, Wabi-only bandwidth, direct versus relayed private-access routing, and community-wide call loss/jitter are not measured here. Helper-reported figures below are separate observations.</p></details>
    {:else if !error}<p>Waiting for the server’s measurements…</p>{/if}
</section>
<style>
.health-panel{padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2)}header{display:flex;justify-content:space-between;gap:var(--space-3)}h3,h4,p{margin:0 0 var(--space-3)}p,dt,.stamp{color:var(--w-mute)}.endpoint-role{padding:var(--space-3);margin-bottom:var(--space-3);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));background:var(--w-raise)}.endpoint-role strong{display:block;margin-bottom:var(--space-2);color:var(--w-text)}.endpoint-role p{margin:0}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}dd{margin:var(--space-2) 0;font-weight:600;color:var(--w-text)}button{align-self:start;padding:var(--space-2) var(--space-3);background:var(--w-raise);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));cursor:pointer}.table-wrap{overflow:auto}table{width:100%;text-align:left;border-collapse:collapse}th,td{padding:var(--space-2);border-bottom:1px solid var(--w-line-strong)}details{margin-top:var(--space-3)}summary{cursor:pointer}.error{color:var(--w-danger)}@media(max-width:480px){dl{grid-template-columns:1fr}}
</style>
