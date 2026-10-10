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
	<div class="summary">{#each [...summary].sort((a,b)=>b.bytes-a.bytes) as row (row.kind)}<button class:active={kind===row.kind} onclick={()=>kind=kind===row.kind?'all':row.kind}><span>{row.kind}</span><strong>{formatBytes(row.bytes)}</strong><small>{row.count} files</small></button>{/each}</div>
	{#if error}<div class="error" role="alert">{error}</div>{/if}
	<section class="explorer">
		<header><div><h3>Upload explorer</h3><p>Revoke makes a file return 410 without destroying its audit metadata. Permanent byte deletion is owner-only.</p></div><div class="filters"><input bind:value={query} aria-label="Search uploads" placeholder="Search files or channel…"/><select bind:value={kind} aria-label="Upload type"><option value="all">All types</option>{#each summary as row}<option value={row.kind}>{row.kind}</option>{/each}</select></div></header>
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
	.storage-center { display: grid; gap: 16px; font-family: var(--w-sans); color: var(--w-text); }
	.hero, .meter-card, .explorer { padding: 20px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-bg2); }
	.hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
	.eyebrow { font: 600 calc(11px * var(--w-fs, 1)) var(--w-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--w-faint); }
	.hero h2 { margin: 4px 0 6px; font: 600 calc(26px * var(--w-fs, 1))/1.15 var(--w-serif); color: var(--w-text); }
	.hero p, .meter-card p, .explorer header p { margin: 0; font: 400 calc(13.5px * var(--w-fs, 1))/1.55 var(--w-sans); color: var(--w-mute); max-width: 62ch; }
	.meter-card > div:first-child { display: grid; gap: 2px; }
	.meter-card span, .meter-card small { font: 500 calc(12.5px * var(--w-fs, 1)) var(--w-mono); color: var(--w-mute); }
	.meter-card strong { font: 500 calc(30px * var(--w-fs, 1))/1.1 var(--w-mono); color: var(--w-text); }
	.bar { height: 4px; margin: 14px 0 12px; border-radius: 2px; background: var(--w-line); overflow: hidden; }
	.bar span { display: block; height: 100%; background: linear-gradient(to right, var(--w-line-strong), var(--w-accent)); }
	.summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
	.summary button { display: grid; gap: 2px; text-align: left; padding: 10px 12px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-bg2); color: var(--w-text); cursor: pointer; }
	.summary button:hover { border-color: var(--w-accent); }
	.summary button.active { border-color: var(--w-accent); background: var(--w-accent-soft); }
	.summary span { font: 600 calc(11px * var(--w-fs, 1)) var(--w-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--w-mute); }
	.summary strong { font: 500 calc(17px * var(--w-fs, 1)) var(--w-mono); }
	.summary small { font: 500 calc(11.5px * var(--w-fs, 1)) var(--w-mono); color: var(--w-faint); }
	.error { padding: 10px 14px; border: var(--w-bw, 1px) solid color-mix(in srgb, var(--w-danger) 60%, transparent); border-radius: calc(10px * var(--w-rs, 1)); color: var(--w-danger); }
	.explorer header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
	.explorer h3 { margin: 0 0 4px; font: 600 calc(18px * var(--w-fs, 1)) var(--w-serif); color: var(--w-text); text-transform: none; letter-spacing: 0.01em; }
	.filters { display: flex; gap: 8px; flex: 1 1 340px; min-width: 0; flex-wrap: wrap; max-width: 100%; justify-content: flex-end; }
	.filters input, .filters select { min-height: 36px; padding: 6px 10px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-sink); color: var(--w-text); font: 400 calc(13.5px * var(--w-fs, 1)) var(--w-sans); }
	.filters input { flex: 1 1 180px; min-width: 0; }
	.filters select { flex: 0 1 140px; min-width: 0; }
	.empty { margin: 16px 0 4px; font: 400 calc(14px * var(--w-fs, 1)) var(--w-sans); color: var(--w-mute); }
	.files { display: grid; }
	article { display: grid; grid-template-columns: minmax(0, 3fr) 90px 150px auto; gap: 14px; align-items: center; padding: 11px 2px; border-top: var(--w-bw, 1px) solid var(--w-line); }
	.file-main { display: flex; gap: 12px; align-items: center; min-width: 0; }
	.icon { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(8px * var(--w-rs, 1)); background: var(--w-sink); font: 600 calc(13px * var(--w-fs, 1)) var(--w-mono); color: var(--w-mute); }
	.file-main > div:last-child { display: grid; min-width: 0; }
	.file-main strong { font: 600 calc(14px * var(--w-fs, 1)) var(--w-sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.file-main span, .file-main small { font: 500 calc(11.5px * var(--w-fs, 1)) var(--w-mono); color: var(--w-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.file-size { display: grid; text-align: right; }
	.file-size strong { font: 500 calc(13.5px * var(--w-fs, 1)) var(--w-mono); }
	.file-size span { font: 500 calc(11px * var(--w-fs, 1)) var(--w-mono); color: var(--w-faint); }
	.state { display: flex; gap: 6px; flex-wrap: wrap; }
	.state span { padding: 1px 8px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: var(--w-pill, 999px); font: 600 calc(11px * var(--w-fs, 1)) var(--w-sans); color: var(--w-mute); }
	.state span.bad { border-color: color-mix(in srgb, var(--w-danger) 60%, transparent); color: var(--w-danger); }
	.actions { display: flex; gap: 6px; justify-content: flex-end; }
	button { min-height: 32px; padding: 5px 12px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(9px * var(--w-rs, 1)); background: transparent; color: var(--w-text); font: 600 calc(12.5px * var(--w-fs, 1)) var(--w-sans); cursor: pointer; }
	button:hover:not(:disabled) { background: var(--w-raise); border-color: var(--w-accent); }
	button:disabled { opacity: 0.45; cursor: not-allowed; }
	button.danger { border-color: color-mix(in srgb, var(--w-danger) 60%, transparent); color: var(--w-danger); }
	button.danger:hover:not(:disabled) { background: var(--w-danger); color: var(--w-bg); }
	@media (max-width: 760px) { article { grid-template-columns: 1fr; gap: 6px; } .file-size { text-align: left; } .actions { justify-content: flex-start; } .hero { flex-direction: column; } }
</style>
