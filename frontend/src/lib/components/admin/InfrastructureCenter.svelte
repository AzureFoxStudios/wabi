<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { listAdminRelays, type AdminRelayNode } from '$lib/api';

	let relays: AdminRelayNode[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let now = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;

	function normalizePing(value:number|null):number|null { if(value===null || !Number.isFinite(value)) return null; return value < 10_000_000_000 ? value*1000 : value; }
	function ageMs(relay:AdminRelayNode){ const ping=normalizePing(relay.last_health_ping); return ping===null?null:Math.max(0,now-ping); }
	function health(relay:AdminRelayNode):'alive'|'stale'|'unknown'|'pending'{ if(!relay.approved) return 'pending'; const age=ageMs(relay); if(age===null) return 'unknown'; return age<=90_000?'alive':'stale'; }
	function relative(relay:AdminRelayNode){ const age=ageMs(relay); if(age===null) return 'No heartbeat recorded'; if(age<5_000) return 'just now'; if(age<60_000) return `${Math.floor(age/1000)}s ago`; if(age<3_600_000) return `${Math.floor(age/60_000)}m ago`; if(age<86_400_000) return `${Math.floor(age/3_600_000)}h ago`; return `${Math.floor(age/86_400_000)}d ago`; }
	function kind(relay:AdminRelayNode){ return relay.metadata?.kind?.replace('-', ' ') ?? 'relay'; }
	function capabilities(relay:AdminRelayNode){ const cap=relay.metadata?.capabilities; if(!cap) return []; return [cap.fileRelay?'files':null,cap.turn?'TURN':null,cap.sfu?'SFU':null,cap.gateway?'gateway':null].filter(Boolean) as string[]; }
	async function refresh(){ loading=true;error='';try{const token=getAuthToken($activeServerUrl);if(!token) throw new Error('Sign in again to inspect infrastructure.');relays=await listAdminRelays(token);}catch(cause){error=cause instanceof Error?cause.message:'Could not load connected nodes.';}finally{loading=false;} }
	onMount(()=>{void refresh();timer=setInterval(()=>{now=Date.now();},10_000);return()=>{if(timer)clearInterval(timer);};});
</script>

<div class="infra-center">
	<section class="hero"><div><span class="eyebrow">Infrastructure</span><h2>What is connected — and is it alive?</h2><p>Registration alone is not health. Wabi separates approved/configured nodes from nodes that are actually sending fresh heartbeats.</p></div><button onclick={refresh} disabled={loading}>{loading?'Checking…':'Refresh'}</button></section>
	<div class="summary"><div><strong>{relays.filter(r=>health(r)==='alive').length}</strong><span>Alive</span></div><div><strong>{relays.filter(r=>health(r)==='stale').length}</strong><span>Stale / offline</span></div><div><strong>{relays.filter(r=>health(r)==='pending').length}</strong><span>Awaiting approval</span></div><div><strong>{relays.length}</strong><span>Known nodes</span></div></div>
	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if loading && !relays.length}<p class="empty">Reading node roster…</p>{:else if !relays.length}<section class="empty"><strong>No auxiliary nodes registered.</strong><span>The origin server can still operate without a relay/helper.</span></section>{:else}
		<div class="nodes">{#each relays as relay (relay.relay_id)}<article>
			<header><div><span class={`dot ${health(relay)}`}></span><div><strong>{relay.name || `Node ${relay.relay_id}`}</strong><span>{kind(relay)}{relay.region ? ` · ${relay.region}` : ''}</span></div></div><span class={`badge ${health(relay)}`}>{health(relay)}</span></header>
			<div class="facts"><div><span>Last heartbeat</span><strong>{relative(relay)}</strong></div><div><span>Configured status</span><strong>{relay.status || 'unknown'}</strong></div><div><span>Bandwidth</span><strong>{relay.bandwidth_mbps ? `${relay.bandwidth_mbps} Mbps` : 'Not reported'}</strong></div><div><span>Storage</span><strong>{relay.storage_gb ? `${relay.storage_gb} GB` : 'Not reported'}</strong></div></div>
			{#if capabilities(relay).length}<div class="caps">{#each capabilities(relay) as capability}<span>{capability}</span>{/each}</div>{/if}
			{#if relay.metadata?.reason}<p class="reason">{relay.metadata.reason}</p>{/if}
			<details><summary>Node details</summary><dl><dt>URL</dt><dd>{relay.url}</dd><dt>Relay ID</dt><dd>{relay.relay_id}</dd><dt>Approved</dt><dd>{relay.approved?'Yes':'No'}</dd><dt>Syncthing device</dt><dd>{relay.syncthing_device_id || 'Not reported'}</dd>{#if relay.metadata?.updatedAt}<dt>Metadata updated</dt><dd>{relay.metadata.updatedAt}</dd>{/if}</dl></details>
		</article>{/each}</div>
	{/if}
</div>

<style>
	.infra-center{display:grid;gap:16px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:24px;border:1px solid var(--border-default);border-radius:18px;background:linear-gradient(135deg,var(--surface-raised),var(--surface-base))}.hero h2{margin:4px 0 7px;font-size:1.7rem}.hero p{margin:0;color:var(--text-secondary);max-width:700px}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--text-muted)}button{font:inherit;cursor:pointer;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:9px;padding:9px 12px}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.summary div{display:grid;gap:2px;padding:15px;border:1px solid var(--border-default);border-radius:13px;background:var(--surface-raised)}.summary strong{font-size:1.5rem}.summary span,.nodes header span,.facts span{color:var(--text-secondary)}.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px}.nodes article{padding:17px;border:1px solid var(--border-default);border-radius:15px;background:var(--surface-raised);display:grid;gap:14px}.nodes header,.nodes header>div{display:flex;align-items:center;justify-content:space-between;gap:10px}.nodes header>div>div{display:grid}.dot{width:10px;height:10px;border-radius:50%;background:var(--text-muted)}.dot.alive{background:#57b66b;box-shadow:0 0 0 4px color-mix(in srgb,#57b66b 18%,transparent)}.dot.stale{background:#c56a62}.dot.pending{background:#c59b57}.badge{padding:3px 8px;border:1px solid var(--border-default);border-radius:999px;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}.facts{display:grid;grid-template-columns:1fr 1fr;gap:9px}.facts div{display:grid;padding:9px 10px;background:var(--surface-base);border-radius:9px}.facts span{font-size:.76rem}.caps{display:flex;gap:6px;flex-wrap:wrap}.caps span{padding:4px 8px;border:1px solid var(--border-default);border-radius:999px;font-size:.76rem}.reason{margin:0;color:var(--text-secondary)}details{border-top:1px solid var(--border-default);padding-top:10px}summary{cursor:pointer;color:var(--text-secondary)}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:.82rem}dt{color:var(--text-secondary)}dd{margin:0;overflow-wrap:anywhere}.error{padding:11px;border:1px solid var(--danger);border-radius:10px}.empty{padding:25px;border:1px dashed var(--border-default);border-radius:14px;display:grid;text-align:center;gap:4px;color:var(--text-secondary)}.empty strong{color:var(--text-primary)}@media(max-width:760px){.hero{display:grid}.summary{grid-template-columns:1fr 1fr}}@media(max-width:460px){.summary{grid-template-columns:1fr}.facts{grid-template-columns:1fr}}
</style>
