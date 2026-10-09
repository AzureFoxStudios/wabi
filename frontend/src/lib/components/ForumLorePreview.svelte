<script lang="ts">
 import { canPreviewLoreText, loreTextExcerpt } from '$lib/forumPreview';
 import { get } from 'svelte/store';
 import { getAuthToken, authSessionGeneration } from '$lib/authSession';
 import { currentUser } from '$lib/presenceIdentity';
 import { captureGroupAccess } from '$lib/groupAccess';
 import { channels } from '$lib/channelStore';
 import { activeServerUrl, getServerUrl } from '$lib/serverUrl';
 import { parseLoreChannelId, listLoreFiles, downloadLoreFileText } from '$lib/api/lore';
 import { openGlance } from '$lib/glance';
 import { navigateToRef } from '$lib/navigateToRef';
 let { channelId, filePath }: { channelId:string; filePath:string } = $props();
 let content = $state(''), status = $state('Loading file preview…'), size = $state<number | null>(null);
 const filename = $derived(filePath.split('/').pop() || filePath);
 const project = $derived($channels.find(channel => channel.id === channelId)?.name || 'Lore');
 $effect(() => {
  const server = $activeServerUrl || getServerUrl(), owner = $currentUser?.dbUserId;
  const generation = authSessionGeneration(server), token = getAuthToken(server), id = parseLoreChannelId(channelId), path = filePath;
  const available = $channels.some(channel=>channel.id===channelId && channel.type==='lore'), access = captureGroupAccess(channelId);
  let active = true;
  const current = () => active && access() && get(channels).some(channel=>channel.id===channelId && channel.type==='lore') && getServerUrl() === server && get(currentUser)?.dbUserId === owner && authSessionGeneration(server) === generation;
  content=''; size=null; status='Loading file preview…';
  if (!available) {status='This project is unavailable.';return;}
  if (!token || id === null) { status='Open the project to view this file.'; return; }
  void (async () => {
   try {
    const files = await listLoreFiles(token,id), file=files.find(file=>file.path===path);
    if (!current()) return;
    if (!file) {status='File unavailable or access changed.';return;}
    size=file.size;
    if (!canPreviewLoreText(path,file.size)) {status='Open file to view its contents.';return;}
    const result=await downloadLoreFileText(token,id,path);
    if (!current()) return;
    content=loreTextExcerpt(result.content);status='';
   } catch {if(current()) status='Preview unavailable. Open the project to try again.';}
  })();
  return () => {active=false;};
 });
 async function open(event: MouseEvent) {if (event.altKey) {openGlance({kind:'lore_file',channelId,filePath});return;} try {await navigateToRef({kind:'lore_file',channelId,filePath});} catch {status='Could not open this file.';}}
</script>
<article class="lore-preview">
 <button type="button" onclick={open} title="Alt-click to preview"><strong>{filename}</strong><span>{project} · {filePath}{#if size !== null} · {size.toLocaleString()} bytes{/if}</span></button>
 {#if content}<pre><code>{content}</code></pre>{:else}<p role="status">{status}</p>{/if}
</article>
<style>
 .lore-preview {margin:.8rem 0;border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));overflow:hidden;background:var(--w-raise);color:var(--w-text);}
 button {display:flex;flex-direction:column;gap:.3rem;width:100%;text-align:left;padding:.8rem;border:0;background:none;color:inherit;cursor:pointer;}
 span,p {font-size:.8rem;color:var(--w-mute);}p {padding:0 .8rem .8rem;margin:0;}
 pre {margin:0;padding:.8rem;overflow:auto;border-top:1px solid var(--w-line);background:var(--w-bg2);font-size:.8rem;}
</style>
