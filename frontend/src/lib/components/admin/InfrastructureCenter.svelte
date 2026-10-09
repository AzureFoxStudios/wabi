<script lang="ts">
    import { onMount } from 'svelte';
    import { activeServerUrl } from '$lib/serverUrl';
    import { getAuthToken } from '$lib/authSession';
    import { infrastructureRequest, type HelperNode } from '$lib/api/infrastructure';
    import NetworkHealthPanel from './NetworkHealthPanel.svelte';
    import CommunityEntryPointsPanel from './CommunityEntryPointsPanel.svelte';
    import VolunteerBoostersPanel from './VolunteerBoostersPanel.svelte';
    let { owner = false }: { owner?: boolean } = $props();
    let workload: { nodeId: string; assignedMediaRooms: number; reportedActiveMediaRooms: number }[] = $state([]);
    let nodes: HelperNode[] = $state([]); let error = $state(''); let loading = $state(false); let now = $state(Date.now()); let epoch = 0; let scope = ''; let clockOffset = 0;
    function health(n: HelperNode) { if (n.status === 'revoked') return 'Revoked'; if (!n.lastHeartbeatAt) return 'No heartbeat'; return n.status === 'online' && now - Date.parse(n.lastHeartbeatAt) <= 90000 ? 'Fresh heartbeat' : 'Stale / offline'; }
    async function refresh() {
        if (loading) return; loading = true; const server = $activeServerUrl; const request = ++epoch;
        try { const data = await infrastructureRequest<{ nodes: HelperNode[]; workload: typeof workload; observedAt: string }>(getAuthToken(server), '/api/nodes'); if (request === epoch && server === $activeServerUrl) { nodes = data.nodes; workload = data.workload ?? []; error = ''; clockOffset = Date.parse(data.observedAt) - Date.now(); now = Date.now() + clockOffset; } }
        catch (e) { if (request === epoch) error = e instanceof Error ? e.message : String(e); }
        finally { if (request === epoch) loading = false; }
    }
    $effect(() => { if (scope !== $activeServerUrl) { scope = $activeServerUrl; nodes = []; workload = []; loading = false; epoch++; void refresh(); } });
    onMount(() => { void refresh(); const timer = setInterval(() => { now = Date.now() + clockOffset; if (!document.hidden) void refresh(); }, 10000); return () => { epoch++; clearInterval(timer); }; });
</script>
<div class="infra-center">
    <header><div><h2>Infrastructure</h2><p>Understand the server’s health and what optional helpers contribute.</p></div><button onclick={refresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh helpers'}</button></header>
    <NetworkHealthPanel />
    <CommunityEntryPointsPanel {owner} />
    <VolunteerBoostersPanel />
    <section class="helper-panel">
        <h3>Operator helpers</h3><p>These are deliberately paired infrastructure. Volunteer boosters appear separately above. A fresh heartbeat confirms contact; it does not prove useful work or spare capacity.</p>
        {#if error}<p class="error" role="alert">Helper status unavailable: {error}. Any rows below are last known values.</p>{/if}
        {#each nodes as node (node.nodeId)}
            {@const work = workload.find(w => w.nodeId === node.nodeId)}
            <article><header><strong>{node.displayName || node.nodeId}</strong><span>{health(node)}</span></header>
                <p>{node.capabilities.join(', ').replaceAll('_', ' ') || 'No capabilities advertised'}</p>
                <dl><div><dt>Last heartbeat</dt><dd>{node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).toLocaleString() : 'Not reported'}</dd></div>
                <div><dt>Reported CPU</dt><dd>{node.load.cpuPercent == null ? 'Not reported' : `${node.load.cpuPercent.toFixed(1)}%`}</dd></div>
                <div><dt>Reported memory</dt><dd>{node.load.memoryUsedMb == null ? 'Not reported' : `${node.load.memoryUsedMb} MB`}</dd></div>
                <div><dt>Reported upload rate</dt><dd>{node.load.uploadMbps == null ? 'Not reported' : `${node.load.uploadMbps.toFixed(2)} Mbps`}</dd></div></dl>
                <p>Authority media assignments: {work?.assignedMediaRooms ?? 'Not measured'}. Rooms reported active: {work?.reportedActiveMediaRooms ?? 'Not measured'}. These counts do not verify media delivery or bandwidth savings.</p>
                <details><summary>Connection details</summary><p>{node.reachability.replaceAll('_', ' ')} · {node.endpoint || 'No endpoint advertised'}</p><p>Node {node.nodeId}. Values are helper-reported; completed jobs and bandwidth savings are not inferred from them.</p></details>
            </article>
        {:else}{#if !error}<p>{loading ? 'Reading helper roster…' : 'No operator helpers registered. The Authority can operate without them.'}</p>{/if}{/each}
    </section>
</div>
<style>
.infra-center{display:grid;gap:var(--space-5)}header{display:flex;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}h2,h3,p{margin:0 0 var(--space-3)}p,dt,header span{color:var(--w-mute)}.helper-panel{padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2)}article{padding:var(--space-3);margin-top:var(--space-3);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1))}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}dd{margin:var(--space-2) 0;overflow-wrap:anywhere}button{align-self:start;padding:var(--space-2) var(--space-3);background:var(--w-raise);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));cursor:pointer}summary{cursor:pointer}.error{color:var(--w-danger)}@media(max-width:480px){dl{grid-template-columns:1fr}}
</style>
