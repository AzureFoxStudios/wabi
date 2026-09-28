<script lang="ts">
 import { onMount } from 'svelte';
 import { getAuthToken, onAuthSessionCleared } from '$lib/authSession';
 import { getServerUrl } from '$lib/serverUrl';
 import { fetchChannel } from '$lib/api/channelAccess';
 let { channelId }: { channelId: string } = $props();
 type Step = { operationId:string; tool:string; arguments:unknown; result:unknown };
 type Run = { runId:string; botUserId:number; createdByUserId:number; mode:string; prompt:string; reply:string; status:string; revision:number; attempt:number; leaseUntilMicros:number; provider:string; model:string; checkpoint:string; pending:Step|null; steps:Step[] };
 type Member = { id:number; name:string; isBot:boolean };
 let runs:Run[] = $state([]), members:Member[] = $state([]);
 let prompt = $state(''), bot = $state(''), mode = $state('chat'), consent = $state(false);
 let error = $state(''), loading = $state(true), busy = $state(false), epoch = 0;
 let operationId:string|null = null;
 let bots = $derived(members.filter(m => m.isBot));
 const active = (r:Run) => ['queued','running','paused'].includes(r.status);
 const base = () => `${getServerUrl()}/api/projects/${encodeURIComponent(channelId)}`;
 const headers = () => ({ 'Content-Type':'application/json', Authorization:`Bearer ${getAuthToken()}` });
 function name(id:number) { return members.find(m => m.id === id)?.name ?? `Member #${id}`; }
 async function call(path:string, body?:unknown) {
  const response = await fetchChannel(channelId, `${base()}${path}`, { method:body===undefined?'GET':'POST', headers:headers(), ...(body===undefined?{}:{body:JSON.stringify(body)}) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status===409?'This run changed. Refresh and review before trying again.':data?.error ?? `Could not reach the Project assistant (${response.status}).`);
  return data;
 }
 async function load() {
  const current = ++epoch;
  try {
   const [data, roster] = await Promise.all([call('/runs'),call('/members')]);
   if (current!==epoch) return;
   runs=data.runs??[]; members=roster.members??[]; if (!bot && bots.length) bot=String(bots[0].id);
  } catch (cause) { if (current===epoch) { runs=[]; members=[]; error=cause instanceof Error?cause.message:'Could not load assistant.'; } }
  finally { if (current===epoch) loading=false; }
 }
 async function send() {
  if (busy || !consent || !prompt.trim() || !bot) return;
  busy=true; error=''; operationId ??= crypto.randomUUID();
  try { await call('/runs',{operationId,botUserId:Number(bot),mode,prompt:prompt.trim(),providerConsent:consent}); prompt=''; operationId=null; consent=false; await load(); }
  catch (cause) { error=cause instanceof Error?cause.message:'Could not send the request.'; }
  finally { busy=false; }
 }
 async function control(run:Run, action:string) {
  busy=true; error='';
  try { await call(`/runs/${encodeURIComponent(run.runId)}/control`,{expectedRevision:run.revision,action}); await load(); }
  catch (cause) { error=cause instanceof Error?cause.message:'Could not control the run.'; await load(); }
  finally { busy=false; }
 }
 onMount(() => {
  void load(); const poll=setInterval(() => { if (!busy && document.visibilityState==='visible') void load(); },2500);
  const stop=onAuthSessionCleared(() => { epoch++; runs=[]; members=[]; prompt=''; bot=''; consent=false; operationId=null; error='Sign in to view the assistant.'; });
  return () => { clearInterval(poll); stop(); epoch++; };
 });
</script>
<section class="assistant" aria-label="Project assistant">
 <header><div><p class="eyebrow">A CONVERSATION WITH THE WORK</p><h2>Your Project assistant</h2><p>Ask a question, or give a worker a small piece of the Project.</p></div><button type="button" onclick={() => void load()} disabled={busy}>Refresh</button></header>
 <div class="scope"><strong>This Project only</strong><span>Work mode reads and edits cards and wiki pages, up to 12 tool steps. Human estimates are excluded. No terminal access.</span></div>
 {#if error}<p class="error" role="alert">{error}</p>{/if}
 {#if loading}<p role="status">Loading assistant…</p>{:else}
 <div class="conversation" aria-label="Assistant conversations">
  {#if !runs.length}<div class="empty"><span aria-hidden="true">✧</span><h3>A small beginning</h3><p>Ask a question, or try “Make a card and document the plan in the wiki.”</p></div>{/if}
  {#each runs as run (run.runId)}<article class="run">
   <div class="run-heading"><strong>{name(run.botUserId)}</strong><span>{run.mode==='work'?'Project work':'Conversation'} · {run.status.replace('_',' ')}</span></div>
   <div class="human-message"><span>{name(run.createdByUserId)} asked</span><p>{run.prompt}</p></div>
   {#if run.reply}<div class="reply"><span>{name(run.botUserId)}</span><p>{run.reply}</p></div>{/if}
   <div class="checkpoint" role="status">{run.checkpoint}{#if run.status==='queued'}<span> · Start the assigned worker to pick this up.</span>{/if}{#if run.status==='running' && run.leaseUntilMicros < Date.now()*1000}<span> · Worker lease expired. Review before resuming.</span>{/if}</div>
   {#if run.provider}<p class="model">{run.provider} / {run.model} · attempt {run.attempt}</p>{/if}
   {#if run.steps.length || run.pending}<details><summary>{run.steps.length} recorded steps{run.pending?' · uncertain pending action':''}</summary>{#each run.steps as step (step.operationId)}<div class="step"><strong>{step.tool.replace('_',' ')}</strong><pre>{JSON.stringify({arguments:step.arguments,result:step.result},null,2)}</pre></div>{/each}{#if run.pending}<div class="error"><strong>Review before continuing</strong><p>Check whether the pending action completed, then take over or cancel this run.</p><pre>{JSON.stringify(run.pending,null,2)}</pre></div>{/if}</details>{/if}
   {#if run.status==='completed'}<button class="continue" type="button" onclick={() => { bot=String(run.botUserId); mode='chat'; consent=false; operationId=null; prompt=`Previous question:\n${run.prompt}\nAssistant reply:\n${run.reply}\n\nFollow-up:\n`; }}>Continue this conversation</button>{/if}
   {#if active(run)}<div class="run-controls">{#if run.status!=='paused'}<button type="button" disabled={busy} onclick={() => void control(run,'pause')}>Pause</button>{/if}{#if !run.pending && (run.status==='paused' || run.status==='running' && run.leaseUntilMicros < Date.now()*1000)}<button type="button" disabled={busy} onclick={() => void control(run,'resume')}>Resume</button>{/if}<button type="button" disabled={busy} onclick={() => void control(run,'takeover')}>Take over</button><button type="button" disabled={busy} onclick={() => void control(run,'cancel')}>Cancel run</button></div>{/if}
  </article>{/each}
 </div>
 <form onsubmit={(e) => {e.preventDefault();void send();}}>
  {#if !bots.length}<p>No bot has Project access yet. The server owner can grant an installed worker access through the bot setup API.</p>{/if}
  <div class="composer-options"><label>Assistant<select bind:value={bot} onchange={() => {operationId=null;consent=false;}} disabled={!bots.length}>{#each bots as member (member.id)}<option value={String(member.id)}>{member.name}</option>{/each}</select></label><label>What it can do<select bind:value={mode} onchange={() => {operationId=null;consent=false;}}><option value="chat">Reply only</option><option value="work">Work on cards and wiki</option></select></label></div>
  <label class="prompt-label">Your request<textarea bind:value={prompt} maxlength="16000" rows="3" placeholder="Give it a clear, bounded request…" oninput={() => {operationId=null;}} required></textarea></label>
  <label class="consent"><input type="checkbox" bind:checked={consent} /><span>Send this request{mode==='work'?' and the Project content it chooses to read':''} to the assigned worker’s model provider. Requests and replies are shared and stored in this Project.</span></label>
  <div class="composer-footer"><span>Reply only uses this prompt. Work mode reads Project content through the listed tools.</span><button class="send" type="submit" disabled={busy || !bot || !prompt.trim() || !consent}>{busy?'Sending…':mode==='work'?'Start Project work':'Send request'}</button></div>
 </form>
 {/if}
</section>
<style>
 .assistant {height:100%;overflow:auto;padding:1.4rem 4rem 2rem clamp(1rem,3vw,2.25rem);box-sizing:border-box;background:var(--surface-base);color:var(--text-primary);}
 header {display:flex;justify-content:space-between;align-items:center;gap:1rem;} h2 {margin:0;font-size:1.5rem;letter-spacing:-.025em;} header p {color:var(--text-secondary);font-size:.8rem;}
 .eyebrow {font-size:.65rem!important;letter-spacing:.13em;color:var(--accent-primary)!important;font-weight:700;} button {font:inherit;cursor:pointer;border:1px solid var(--border-default);background:var(--surface-raised);color:var(--text-primary);border-radius:var(--radius-md);padding:.5rem .75rem;} button:disabled {opacity:.5;cursor:default;}
 .scope {display:flex;gap:.8rem;flex-wrap:wrap;background:color-mix(in srgb,var(--accent-primary) 8%,var(--surface-raised));border:1px solid var(--border-subtle);padding:.8rem 1rem;border-radius:var(--radius-lg);font-size:.76rem;} .scope span {color:var(--text-secondary);}
 .conversation {display:grid;gap:1rem;padding:1.2rem 0;max-width:62rem;} .empty {text-align:center;padding:2rem;color:var(--text-secondary);} .empty>span {font-size:2rem;color:var(--accent-primary);} .empty h3 {color:var(--text-primary);margin:.6rem 0;}
 .run {border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:1rem;background:var(--surface-raised);} .run-heading {display:flex;justify-content:space-between;flex-wrap:wrap;gap:.4rem;font-size:.8rem;} .run-heading>span,.model {color:var(--text-secondary);font-size:.7rem;}
 .human-message,.reply {margin-top:.8rem;padding:.75rem 1rem;border-radius:var(--radius-md);background:var(--surface-base);} .reply {border-left:2px solid var(--accent-primary);} .human-message>span,.reply>span {font-size:.65rem;color:var(--text-secondary);font-weight:700;} .human-message p,.reply p {white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;line-height:1.6;margin:.3rem 0 0;}
 .checkpoint {margin-top:.8rem;color:var(--text-secondary);font-size:.75rem;line-height:1.5;} .model {margin:.3rem 0;} details {margin-top:.8rem;font-size:.75rem;} summary {cursor:pointer;} pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem;overflow:auto;font-size:.7rem;} .step {margin:.7rem 0;padding:.7rem;background:var(--surface-base);border-radius:var(--radius-md);} .run-controls {display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.8rem;font-size:.75rem;}
 form {max-width:62rem;padding:1rem;border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--surface-raised);} .composer-options {display:flex;gap:.8rem;flex-wrap:wrap;} label {font-size:.75rem;color:var(--text-secondary);} .composer-options label,.prompt-label {display:grid;gap:.4rem;flex:1;} select,textarea {font:inherit;border:1px solid var(--border-default);border-radius:var(--radius-md);padding:.6rem .7rem;background:var(--surface-base);color:var(--text-primary);} textarea {width:100%;box-sizing:border-box;resize:vertical;} .prompt-label {margin-top:.8rem;}
 .consent {display:flex;align-items:flex-start;gap:.5rem;margin-top:.8rem;line-height:1.5;} .consent input {margin-top:.2rem;} .composer-footer {display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.8rem;margin-top:.8rem;} .composer-footer>span {font-size:.7rem;color:var(--text-secondary);} .send {background:var(--accent-primary);color:var(--text-on-accent,#fff);border:0;font-weight:650;} .error {padding:.7rem;border-radius:var(--radius-md);background:color-mix(in srgb,var(--text-danger,#ef4444) 12%,var(--surface-base));color:var(--text-danger,#ef4444);font-size:.8rem;}
 @media(max-width:700px) {.assistant {padding:1rem 3rem 1.5rem 1rem;} header {align-items:flex-start;} .run-heading {flex-direction:column;}}
</style>
