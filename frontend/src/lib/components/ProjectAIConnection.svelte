<script lang="ts">
 import { getAuthToken, onAuthSessionCleared } from '$lib/authSession';
 import { getServerUrl } from '$lib/serverUrl';
 import { currentUser } from '$lib/presenceIdentity';
 import { onMount } from 'svelte';
 let { channelId, onConnected = () => {} }: { channelId: string; onConnected?: () => void } = $props();
 type Connection = { version: number; serverUrl: string; channelId: string; botUserId: number; botToken: string; runtime: { harness: 'codex'; mode: 'existing_harness'; name: string; computer: string; workspace: string } };
 let expanded = $state(false), busy = $state(false), consent = $state(false), name = $state('codex-project');
 let connection: Connection | null = $state(null), error = $state(''), checked = $state(false);
 let computer = $state(''), workspace = $state('');
 let epoch = 0;
 let setupProject = '', setupToken: string | null = null;
 const setupCommand = 'codex mcp add wabi-project -- node /path/to/wabi/scripts/wabi-project-mcp.mjs --connection /path/to/wabi-project-connection.json';
 function retire() { epoch++; connection = null; setupToken = null; consent = false; checked = false; busy = false; error = ''; }
 $effect(() => { if (channelId !== setupProject) { setupProject = channelId; retire(); } });
 onMount(() => onAuthSessionCleared(retire));
 function currentConnection() {
  if (!connection || connection.channelId !== channelId || connection.serverUrl !== getServerUrl() || setupToken !== getAuthToken()) {
   retire(); error = 'Your Project, server or account changed. Reopen connection setup.'; return null;
  }
  return connection;
 }
 async function connect() {
  if (busy || !consent) return;
  busy = true; error = ''; const ticket = ++epoch, origin = getServerUrl(), token = getAuthToken(), project = channelId;
  const current = () => ticket === epoch && origin === getServerUrl() && token === getAuthToken() && project === channelId;
  async function post(path: string, body: unknown) {
   if (!current()) throw new Error('Your server or account changed. Reopen connection setup.');
   const response = await fetch(`${origin}/api/bot/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
   const data = await response.json().catch(() => null);
   if (!response.ok) throw new Error(response.status === 403 ? 'Only the server owner can connect an AI.' : data?.error ?? 'Connection setup failed.');
   return data;
  }
  let created: { botUserId: number; botToken: string } | undefined;
  try {
   const url = new URL(origin);
   if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('The connector needs HTTPS, or localhost for a disposable test.');
   created = await post('create', { username: name.trim() });
   await post('project-access', { botUserId: created!.botUserId, channelId: project, allow: true });
   if (!current()) return;
   connection = { version: 1, serverUrl: origin, channelId: project, botUserId: created!.botUserId, botToken: created!.botToken,
    runtime: { harness: 'codex', mode: 'existing_harness', name: name.trim(), computer: computer.trim(), workspace: workspace.trim() } };
   setupToken = token;
   checked = false; onConnected();
  } catch (cause) {
   if (created && current()) await post('disable', { botUserId: created.botUserId }).catch(() => {});
   if (current()) error = cause instanceof Error ? cause.message : 'Connection setup failed.';
  } finally { if (ticket === epoch) busy = false; }
 }
 function download() {
  const captured = currentConnection(); if (!captured) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(captured, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'wabi-project-connection.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
 }
 async function testAccess() {
  if (busy) return;
  const captured = currentConnection(); if (!captured) return;
  busy = true; error = ''; const ticket = epoch;
  try {
   for (const path of [`projects/${encodeURIComponent(captured.channelId)}/tasks`, `wiki/${encodeURIComponent(captured.channelId)}/pages`]) {
    const response = await fetch(`${captured.serverUrl}/api/${path}`, { headers: { Authorization: `Bot ${captured.botToken}` } });
    if (!response.ok) throw new Error('Project access was refused. Ask the owner to check or reconnect this service.');
    await response.body?.cancel();
   }
   if (ticket === epoch && captured === connection && captured.serverUrl === getServerUrl() && setupToken === getAuthToken()) checked = true;
  } catch (cause) { if (ticket === epoch) { checked = false; error = cause instanceof Error ? cause.message : 'Could not check access.'; } }
  finally { if (ticket === epoch) busy = false; }
 }
 async function disconnect() {
  if (busy) return;
  const captured = currentConnection(); if (!captured) return;
  busy = true; error = ''; const ticket = epoch, token = getAuthToken();
  try {
   const response = await fetch(`${captured.serverUrl}/api/bot/disable`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ botUserId: captured.botUserId }) });
   if (!response.ok) throw new Error('Could not revoke the connection. Keep its ID and ask the owner to disable it.');
   if (ticket === epoch) { connection = null; checked = false; consent = false; onConnected(); }
  } catch (cause) { if (ticket === epoch) error = cause instanceof Error ? cause.message : 'Could not disconnect.'; }
  finally { if (ticket === epoch) busy = false; }
 }
</script>

<section class="ai-connection" aria-label="Connect your AI">
 <button type="button" class="connection-toggle" aria-expanded={expanded} onclick={() => expanded = !expanded}>Connect Codex <span>Existing chat · Project tools</span></button>
 {#if expanded}
 <div class="connection-body">
  <p>Keep working in your Codex chat. This connection gives it tools for this Project’s cards and wiki, and its work appears here.</p>
  <dl class="connection-facts"><div><dt>AI app / harness</dt><dd>Codex</dd></div><div><dt>Connection type</dt><dd>Existing chat using Project tools</dd></div><div><dt>Model and billing</dt><dd>Your current Codex setup</dd></div></dl>
  <p class="connection-note">Your native commands and session controls stay in Codex. Wabi adds tools; it does not intercept commands, forward them, launch subagents or start another model.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if connection}
   <p role="status"><strong>{connection.runtime.name}</strong> · Project access granted{checked ? ' · read access checked' : ''}</p>
   <dl class="connection-facts"><div><dt>Computer you named</dt><dd>{connection.runtime.computer || 'Not specified'}</dd></div><div><dt>Local workspace you named</dt><dd>{connection.runtime.workspace || 'Not specified'}</dd></div><div><dt>Service identity</dt><dd>#{connection.botUserId}</dd></div></dl>
   <ol>
    <li><button type="button" onclick={download}>Download connection file</button> Keep it private: it contains the service credential. Wabi keeps it on this screen only.</li>
    <li>Add the connection in Codex’s MCP settings using the Wabi connector and downloaded file.<details><summary>Command-line setup</summary>Replace both paths:<pre>{setupCommand}</pre></details></li>
    <li>Restart the MCP connection, then ask: <blockquote>Use Wabi project_brief. Read and claim one test card, put your plan and check results in its notes, then leave it ready for my review.</blockquote></li>
   </ol>
   <div class="connection-actions"><button type="button" disabled={busy} onclick={() => void testAccess()}>Check Project access</button><button type="button" disabled={busy} onclick={() => void disconnect()}>Revoke this connection</button></div>
   <p class="connection-note">The access check verifies this credential, not whether your chat is online. Computer and workspace are your labels, not a verified Lore link. Sending requests from Wabi requires a separately running worker.</p>
  {:else if $currentUser?.highestRole === 'owner'}
   <label>Connection name<input bind:value={name} maxlength="80" placeholder="ronin-codex-design" /></label>
   <details><summary>Computer and workspace (optional)</summary><label>Computer<input bind:value={computer} maxlength="120" placeholder="Ronin" /></label><label>Local workspace<input bind:value={workspace} maxlength="500" placeholder="/home/ironin/wabi" /></label></details>
   <label class="grant"><input type="checkbox" bind:checked={consent} />Allow this service to read and edit this Project’s cards and wiki. Content you ask Codex to use goes to its model provider.</label>
   <button type="button" disabled={busy || !consent || !name.trim()} onclick={() => void connect()}>{busy ? 'Connecting…' : 'Create Project connection'}</button>
  {:else}<p>The server owner can create a connection for this Project. Your own personal Planner stays separate.</p>{/if}
 </div>
 {/if}
</section>

<style>
 .ai-connection {border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--surface-raised);max-width:62rem;margin:1rem 0;}
 button,input {font:inherit;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:.6rem .8rem;} button {cursor:pointer;} button:disabled {opacity:.5;cursor:default;}
 .connection-toggle {width:100%;text-align:left;border:0;background:transparent;font-weight:650;display:flex;justify-content:space-between;gap:.7rem;flex-wrap:wrap;}
 .connection-toggle span,.connection-note {font-size:.75rem;color:var(--text-secondary);font-weight:400;}
 .connection-body {padding:0 1rem 1rem;font-size:.82rem;line-height:1.6;} label {display:grid;gap:.35rem;margin:.7rem 0;} .grant {display:flex;align-items:flex-start;gap:.5rem;} .grant input {margin-top:.3rem;}
 pre {white-space:pre-wrap;overflow-wrap:anywhere;padding:.7rem;background:var(--surface-base);border-radius:var(--radius-md);font-size:.72rem;} li {margin:.8rem 0;} ol {padding-left:1.3rem;} blockquote {margin:.4rem 0;padding-left:.7rem;border-left:2px solid var(--accent-primary);color:var(--text-secondary);}
 .connection-actions {display:flex;flex-wrap:wrap;gap:.5rem;} [role=alert] {color:var(--text-danger);}
 .connection-facts {display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.7rem;margin:1rem 0;} .connection-facts div {min-width:0;} dt {font-size:.7rem;color:var(--text-secondary);} dd {margin:.15rem 0 0;overflow-wrap:anywhere;} details {margin:.7rem 0;} summary {cursor:pointer;}
</style>
