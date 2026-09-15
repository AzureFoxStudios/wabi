<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { currentUser } from '$lib/socket';

	type StorageFile = { filename:string; originalName:string; channelId:string|null; uploaderId:number|null; kind:string; size:number; createdAt:string; revoked:boolean; onDisk:boolean };
	type StorageSummary = { kind:string; count:number; bytes:number };
	let files: StorageFile[] = $state([]);
	let summary: StorageSummary[] = $state([]);
	let totalBytes = $state(0);
	let fileCount = $state(0);
	let loading = $state(true);
	let busy = $state<string | null>(null);
	let error = $state('');
	let query = $state('');
	let kind = $state('all');
	const isOwner = $derived(($currentUser?.highestRole ?? '').toLowerCase() === 'owner');
	const visibleFiles = $derived(files.filter(file => (kind === 'all' || file.kind === kind) && (!query.trim() || `${file.originalName} ${file.filename} ${file.channelId ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))));

	function formatBytes(bytes:number){ if(bytes < 1024) return `${bytes} B`; const units=['KB','MB','GB','TB']; let n=bytes/1024,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++;} return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`; }
	function token(){ return getAuthToken($activeServerUrl); }
	async function api(path:string, init:RequestInit={}){ const auth=token(); if(!auth) throw new Error('Sign in again to manage storage.'); const res=await fetch(`${$activeServerUrl}${path}`,{...init,credentials:'include',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json',...(init.headers??{})}}); const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error||`Storage request failed (${res.status}).`); return data; }
	async function refresh(){ loading=true; error=''; try{const data=await api('/api/server-center/storage');files=data.files??[];summary=data.summary??[];totalBytes=data.totalBytes??0;fileCount=data.fileCount??0;}catch(cause){error=cause instanceof Error?cause.message:'Could not read storage.';}finally{loading=false;} }
	async function revoke(file:StorageFile){ busy=file.filename; error=''; try{await api('/api/admin/uploads/revoke',{method:'POST',body:JSON.stringify({filename:file.filename})}); files=files.map(item=>item.filename===file.filename?{...item,revoked:true}:item);}catch(cause){error=cause instanceof Error?cause.message:'Could not revoke file.';}finally{busy=null;} }
	async function deleteBytes(file:StorageFile){ if(!isOwner) return; if(!confirm(`Permanently delete ${file.originalName} from disk? Existing messages or links may stop loading.`)) return; busy=file.filename; error=''; try{await api(`/api/server-center/storage/${encodeURIComponent(file.filename)}`,{method:'DELETE'});files=files.map(item=>item.filename===file.filename?{...item,onDisk:false,revoked:true}:item);await refresh();}catch(cause){error=cause instanceof Error?cause.message:'Could not delete file.';}finally{busy=null;} }
	onMount(()=>{void refresh();});
</script>

<div class="storage-center">
	<section class="hero"><div><span class="eyebrow">Storage</span><h2>Know what is actually on the server.</h2><p>Uploads are grouped by purpose, with their original name, owner/channel metadata, revocation state, and whether bytes still exist on disk.</p></div><button onclick={refresh} disabled={loading}>{loading?'Scanning…':'Refresh'}</button></section>
	<div class="meter-card"><div><span>Recorded uploads</span><strong>{formatBytes(totalBytes)}</strong><small>{fileCount.toLocaleString()} files in the upload registry</small></div><div class="bar"><span style={`width:${Math.min(100, Math.max(2, fileCount ? 100 : 0))}%`}></span></div><p>This number is registry-accounted upload size, not invented free-disk capacity. Untracked files are not silently counted as known content.</p></div>
	<div class="summary">{#each summary.sort((a,b)=>b.bytes-a.bytes) as row (row.kind)}<button class:active={kind===row.kind} onclick={()=>kind=kind===row.kind?'all':row.kind}><span>{row.kind}</span><strong>{formatBytes(row.bytes)}</strong><small>{row.count} files</small></button>{/each}</div>
	{#if error}<div class="error" role="alert">{error}</div>{/if}
	<section class="explorer">
		<header><div><h3>Upload explorer</h3><p>Revoke makes a file return 410 without destroying its audit metadata. Permanent byte deletion is owner-only.</p></div><div class="filters"><input bind:value={query} placeholder="Search files or channel…"/><select bind:value={kind}><option value="all">All types</option>{#each summary as row}<option value={row.kind}>{row.kind}</option>{/each}</select></div></header>
		{#if loading}<p class="empty">Reading upload registry…</p>{:else if visibleFiles.length===0}<p class="empty">No matching uploads.</p>{:else}
			<div class="files">{#each visibleFiles as file (file.filename)}<article>
				<div class="file-main"><div class="icon">{file.kind.slice(0,1).toUpperCase()}</div><div><strong>{file.originalName}</strong><span>{file.filename}</span><small>{file.channelId ? `Channel ${file.channelId}` : 'No channel attached'} · {new Date(file.createdAt).toLocaleString()}</small></div></div>
				<div class="file-size"><strong>{formatBytes(file.size)}</strong><span>{file.kind}</span></div>
				<div class="state"><span class:bad={!file.onDisk}>{file.onDisk?'On disk':'Bytes missing'}</span>{#if file.revoked}<span class="bad">Revoked</span>{/if}</div>
				<div class="actions">{#if !file.revoked}<button onclick={()=>revoke(file)} disabled={busy===file.filename}>Revoke</button>{/if}{#if isOwner && file.onDisk}<button class="danger" onclick={()=>deleteBytes(file)} disabled={busy===file.filename}>Delete bytes</button>{/if}</div>
			</article>{/each}</div>
		{/if}
	</section>
</div>

<style>
	.storage-center{display:grid;gap:16px}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:24px;border:1px solid var(--border-default);border-radius:18px;background:linear-gradient(135deg,var(--surface-raised),var(--surface-base))}.hero h2{margin:4px 0 7px;font-size:1.7rem}.hero p,.meter-card p,.explorer header p{margin:0;color:var(--text-secondary)}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--text-muted)}button,input,select{font:inherit;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:9px;padding:9px 11px}button{cursor:pointer}button:hover{background:var(--surface-hover)}button:disabled{opacity:.5}.meter-card,.explorer{padding:18px;border:1px solid var(--border-default);border-radius:15px;background:var(--surface-raised)}.meter-card>div:first-child{display:grid}.meter-card strong{font-size:1.8rem}.meter-card small{color:var(--text-secondary)}.bar{height:8px;margin:13px 0;background:var(--surface-base);border-radius:999px;overflow:hidden}.bar span{display:block;height:100%;background:currentColor;opacity:.5}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.summary button{display:grid;text-align:left;gap:3px;padding:13px}.summary button.active{outline:2px solid var(--border-default)}.summary span,.summary small{color:var(--text-secondary)}.explorer header{display:flex;justify-content:space-between;gap:18px;align-items:end}.explorer h3{margin:0 0 4px}.filters{display:flex;gap:8px}.files{display:grid;margin-top:14px}.files article{display:grid;grid-template-columns:minmax(260px,1fr) 110px 130px auto;gap:14px;align-items:center;padding:12px 2px;border-top:1px solid var(--border-default)}.file-main{display:flex;gap:10px;min-width:0}.file-main>div:last-child{display:grid;min-width:0}.file-main span,.file-main small,.file-size span{color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.icon{width:36px;height:36px;border-radius:9px;background:var(--surface-hover);display:grid;place-items:center;font-weight:700}.file-size{display:grid}.state{display:flex;gap:5px;flex-wrap:wrap}.state span{font-size:.76rem;padding:3px 7px;border-radius:999px;border:1px solid var(--border-default)}.state .bad{opacity:.72}.actions{display:flex;gap:6px}.danger{border-color:var(--danger)}.error{padding:11px;border:1px solid var(--danger);border-radius:10px}.empty{color:var(--text-secondary);padding:18px 0}@media(max-width:900px){.files article{grid-template-columns:1fr auto}.state,.actions{grid-column:1/-1}.explorer header,.hero{display:grid}.filters{flex-wrap:wrap}}@media(max-width:560px){.files article{grid-template-columns:1fr}.file-size,.state,.actions{grid-column:auto}.filters{display:grid}}
</style>
