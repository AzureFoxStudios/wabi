<script lang="ts">
	import { _ } from '$lib/i18n';
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
    function health(n: HelperNode) { if (n.status === 'revoked') return $_('storage_center.revoked'); if (!n.lastHeartbeatAt) return $_('infra.health_no_heartbeat'); return n.status === 'online' && now - Date.parse(n.lastHeartbeatAt) <= 90000 ? $_('infra.health_fresh') : $_('infra.health_stale'); }
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
    <header><div><h2>{$_('infra.title')}</h2><p>{$_('infra.health_desc')}</p></div><button onclick={refresh} disabled={loading}>{loading ? $_('privacy.state.checking_short') : $_('infra.refresh_helpers')}</button></header>
    <NetworkHealthPanel />
    <CommunityEntryPointsPanel {owner} />
    <VolunteerBoostersPanel />
    <section class="helper-panel">
        <h3>{$_('infra.operator_helpers')}</h3><p>{$_('infra.helpers_desc')}</p>
        {#if error}<p class="error" role="alert">{$_('infra.helper_unavailable', { values: { error } })}</p>{/if}
        {#each nodes as node (node.nodeId)}
            {@const work = workload.find(w => w.nodeId === node.nodeId)}
            <article><header><strong>{node.displayName || node.nodeId}</strong><span>{health(node)}</span></header>
                <p>{node.capabilities.join(', ').replaceAll('_', ' ') || $_('infra.no_capabilities')}</p>
                <dl><div><dt>{$_('infra.last_heartbeat')}</dt><dd>{node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).toLocaleString() : $_('infra.not_reported')}</dd></div>
                <div><dt>{$_('infra.reported_cpu')}</dt><dd>{node.load.cpuPercent == null ? $_('infra.not_reported') : `${node.load.cpuPercent.toFixed(1)}%`}</dd></div>
                <div><dt>{$_('infra.reported_memory')}</dt><dd>{node.load.memoryUsedMb == null ? $_('infra.not_reported') : `${node.load.memoryUsedMb} MB`}</dd></div>
                <div><dt>{$_('infra.reported_upload')}</dt><dd>{node.load.uploadMbps == null ? $_('infra.not_reported') : `${node.load.uploadMbps.toFixed(2)} Mbps`}</dd></div></dl>
                <p>{$_('infra.media_counts', { values: { assigned: work?.assignedMediaRooms ?? $_('network_health.not_measured'), active: work?.reportedActiveMediaRooms ?? $_('network_health.not_measured') } })}</p>
                <details><summary>{$_('shell.call.toggle_diagnostics')}</summary><p>{node.reachability.replaceAll('_', ' ')} · {node.endpoint || $_('infra.no_endpoint')}</p><p>{$_('infra.node_note', { values: { id: node.nodeId } })}</p></details>
            </article>
        {:else}{#if !error}<p>{loading ? $_('infra.reading_roster') : $_('infra.no_helpers')}</p>{/if}{/each}
    </section>
</div>
<style>
.infra-center{display:grid;gap:var(--space-5)}header{display:flex;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}h2,h3,p{margin:0 0 var(--space-3)}p,dt,header span{color:var(--w-mute)}.helper-panel{padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2)}article{padding:var(--space-3);margin-top:var(--space-3);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1))}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}dd{margin:var(--space-2) 0;overflow-wrap:anywhere}button{align-self:start;padding:var(--space-2) var(--space-3);background:var(--w-raise);color:var(--w-text);border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));cursor:pointer}summary{cursor:pointer}.error{color:var(--w-danger)}@media(max-width:480px){dl{grid-template-columns:1fr}}
</style>
