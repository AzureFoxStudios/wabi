<script lang="ts">
	import { _ } from '$lib/i18n';
 import { onMount } from 'svelte';
 import { getAuthToken, onAuthSessionCleared } from '$lib/authSession';
 import { getServerUrl } from '$lib/serverUrl';
 import { fetchChannel } from '$lib/api/channelAccess';
 let { channelId }: {channelId:string}=$props();
 type Worker={workerId:string;botUserId:number;name:string;harness:string;provider:string;model:string;lastSeenMicros:number;canRemove:boolean};
 type Run={runId:string;workerId?:string;targetWorkerId?:string;status:string;checkpoint:string;recoveryPolicy?:{automatic:boolean;backupWorkerIds:string[]}};
 let workers:Worker[]=$state([]),runs:Run[]=$state([]),members:{id:number;name:string}[]=$state([]);
 let loading=$state(true),busy=$state(false),enabled=$state(false),error=$state(''),offset=$state(0),windowMicros=$state(180_000_000),epoch=0;
 const ready=(w:Worker)=>w.lastSeenMicros>Date.now()*1000+offset-windowMicros;
 const owner=(id:number)=>members.find(m=>m.id===id)?.name??$_('pjc.service_n', { values: { id } });
 const current=(w:Worker)=>runs.find(r=>r.workerId===w.workerId && r.status==='running');
 const standby=(w:Worker)=>runs.some(r=>['queued','running','paused'].includes(r.status) && r.recoveryPolicy?.automatic && r.recoveryPolicy.backupWorkerIds.includes(w.workerId));
 async function call(path:string,method='GET'){
  const result=await fetchChannel(channelId,`${getServerUrl()}/api/projects/${encodeURIComponent(channelId)}${path}`,{method,headers:{Authorization:`Bearer ${getAuthToken()}`}});
  if(!result.ok)throw new Error(result.status===403?$_('pjc.err_perm'):$_('pjc.err_load_status', { values: { status: result.status } }));
  return result.json();
 }
 async function load(){
  const version=++epoch;
  try{
   const [computers,history,roster]=await Promise.all([call('/workers'),call('/runs'),call('/members')]);
   if(version!==epoch)return;
   enabled=computers.enabled===true;workers=computers.workers??[];runs=history.runs??[];members=roster.members??[];
   offset=computers.serverNowMicros-Date.now()*1000;windowMicros=computers.contactWindowMicros??180_000_000;error='';
  }catch(cause){if(version===epoch){workers=[];runs=[];members=[];error=cause instanceof Error?cause.message:$_('pjc.err_load');}}
  finally{if(version===epoch)loading=false;}
 }
 async function remove(worker:Worker){
  busy=true;error='';
  try{await call(`/workers/${encodeURIComponent(worker.workerId)}`,'DELETE');await load();}
  catch(cause){error=cause instanceof Error?cause.message:$_('pjc.err_remove');}
  finally{busy=false;}
 }
 onMount(()=>{
  void load();const poll=setInterval(()=>{if(!busy && document.visibilityState==='visible')void load();},5000);
  const clear=onAuthSessionCleared(()=>{epoch++;workers=[];runs=[];members=[];enabled=false;error=$_('pjc.sign_in');});
  return()=>{clearInterval(poll);clear();epoch++;};
 });
</script>
<section class="connections" aria-label={$_('pjc.aria')}>
 <header><div><p class="eyebrow">{$_('pjc.eyebrow')}</p><h2>{$_('user.popout.connections')}</h2><p>{$_('pjc.subtitle')}</p></div><button type="button" onclick={()=>void load()} disabled={busy}>{$_('pjc.refresh')}</button></header>
 <div class="scope"><strong>{$_('pjc.workers_only')}</strong><p>{$_('pjc.scope_desc')}</p></div>
 {#if error}<p class="error" role="alert">{error}</p>{/if}
 {#if loading}<p role="status">{$_('pjc.loading')}</p>{:else if !enabled}<div class="empty"><h3>{$_('pjc.off_title')}</h3><p>{$_('pjc.off_desc')}</p></div>{:else}
  {#if !workers.length}<div class="empty"><h3>{$_('pjc.first_title')}</h3><p>{$_('pjc.first_desc')}</p><p>{$_('pjc.no_network')}</p><details><summary>{$_('pjc.setup_details')}</summary><p>{$_('pjc.setup_text')}</p></details></div>{/if}
  <div class="grid">{#each workers as worker (worker.workerId)}{@const run=current(worker)}<article>
   <div class="identity"><span class="contact" class:recent={ready(worker)} aria-hidden="true"></span><div><h3>{worker.name}</h3><p>{ready(worker)?$_('pjc.contact_recent'):$_('pjc.contact_lost')}</p></div></div>
   <dl><div><dt>{$_('pjc.ai_connection')}</dt><dd>{worker.harness.replaceAll('_',' ')}</dd></div><div><dt>{$_('pjc.provider_model')}</dt><dd>{worker.provider} / {worker.model}</dd></div><div><dt>{$_('project_assistant.worker_service')}</dt><dd>{owner(worker.botUserId)}</dd></div><div><dt>{$_('pjc.last_work')}</dt><dd>{run?run.checkpoint:$_('pjc.no_attempt')}</dd></div><div><dt>{$_('wb.export_backup')}</dt><dd>{!ready(worker)?$_('pjc.unavail_contact'):standby(worker)?$_('pjc.selected_recovery'):$_('pjc.available_manual')}</dd></div></dl>
   <p class="boundary">{$_('pjc.boundary')}</p>
   {#if worker.canRemove}<button type="button" class="remove" disabled={busy} onclick={()=>void remove(worker)}>{$_('pjc.remove')}</button>{/if}
  </article>{/each}</div>
  <p class="footnote">{$_('pjc.footnote')}</p>
 {/if}
</section>
<style>
 .connections{height:100%;overflow:auto;box-sizing:border-box;padding:1.4rem clamp(1rem,3vw,2.25rem) 2rem;color:var(--w-text);background:var(--w-bg2);}header{display:flex;justify-content:space-between;align-items:center;gap:1rem;}h2{font-size:1.65rem;letter-spacing:-.03em;margin:0;}header p{font-size:.82rem;color:var(--w-mute);}.eyebrow{font-size:.65rem;letter-spacing:.12em;color:var(--w-accent);font-weight:700;}button{font:inherit;font-size:.75rem;cursor:pointer;border:1px solid var(--w-line-strong);background:var(--w-raise);color:var(--w-text);border-radius:calc(10px * var(--w-rs, 1));padding:.6rem .8rem;}button:disabled{opacity:.5;cursor:default;}.scope{max-width:62rem;background:color-mix(in srgb,var(--w-accent) 7%,var(--w-raise));border:1px solid var(--w-line);padding:.9rem 1rem;border-radius:calc(14px * var(--w-rs, 1));font-size:.78rem;}.scope p{margin:.4rem 0 0;color:var(--w-mute);line-height:1.6;}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));max-width:62rem;gap:1rem;margin-top:1.25rem;}article{background:var(--w-raise);border:1px solid var(--w-line);border-radius:calc(14px * var(--w-rs, 1));padding:1.1rem;min-width:0;}.identity{display:flex;gap:.7rem;align-items:center;}.identity h3{margin:0;font-size:1rem;}.identity p{margin:.25rem 0;font-size:.75rem;color:var(--w-mute);}.contact{width:.6rem;height:.6rem;border-radius:50%;background:var(--w-mute);}.contact.recent{background:var(--w-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--w-accent) 12%,transparent);}dl{margin:1rem 0;}dl div{padding:.55rem 0;border-top:1px solid var(--w-line);display:grid;grid-template-columns:7rem 1fr;gap:.8rem;}dt{color:var(--w-mute);font-size:.7rem;}dd{margin:0;font-size:.76rem;overflow-wrap:anywhere;}.boundary,.footnote{font-size:.75rem;color:var(--w-mute);line-height:1.6;}.footnote{max-width:62rem;}.remove{margin-top:.3rem;}.empty{max-width:42rem;margin:2rem 0;padding:1rem;border:1px dashed var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));}.empty p,.empty details{font-size:.8rem;color:var(--w-mute);line-height:1.6;}.empty h3{font-size:1rem;}.error{color:var(--w-danger);font-size:.8rem;}@media(max-width:700px){header{align-items:flex-start;}dl div{grid-template-columns:1fr;gap:.2rem;}}
</style>
