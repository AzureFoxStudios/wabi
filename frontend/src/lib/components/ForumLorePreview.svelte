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
 let { channelId, filePath, lines = undefined }: { channelId:string; filePath:string; lines?: { start:number; end:number } } = $props();
 let content = $state(''), status = $state('Loading file preview…'), size = $state<number | null>(null);
 let firstLine = $state(1), totalLines = $state(0), shownCount = $state(0);
 const filename = $derived(filePath.split('/').pop() || filePath);
 const project = $derived($channels.find(channel => channel.id === channelId)?.name || 'Lore');
 $effect(() => {
  const server = $activeServerUrl || getServerUrl(), owner = $currentUser?.dbUserId;
  const generation = authSessionGeneration(server), token = getAuthToken(server), id = parseLoreChannelId(channelId), path = filePath;
  const available = $channels.some(channel=>channel.id===channelId && channel.type==='lore'), access = captureGroupAccess(channelId);
  let active = true;
  const current = () => active && access() && get(channels).some(channel=>channel.id===channelId && channel.type==='lore') && getServerUrl() === server && get(currentUser)?.dbUserId === owner && authSessionGeneration(server) === generation;
  content=''; size=null; totalLines=0; shownCount=0; status='Loading file preview…';
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
    const all = result.content.split('\n');
    totalLines = all.length;
    if (lines) {
     // A post can point at the exact lines worth reading, so nobody has to scroll a huge file.
     const start = Math.min(lines.start, all.length), end = Math.min(lines.end, all.length);
     firstLine = start; content = all.slice(start - 1, end).join('\n').slice(0, 12000); shownCount = end - start + 1;
    } else {
     firstLine = 1; content = loreTextExcerpt(result.content); shownCount = Math.min(12, all.length);
    }
    status='';
   } catch {if(current()) status='Preview unavailable. Open the project to try again.';}
  })();
  return () => {active=false;};
 });
 async function open(event: MouseEvent) {if (event.altKey) {openGlance({kind:'lore_file',channelId,filePath});return;} try {await navigateToRef({kind:'lore_file',channelId,filePath});} catch {status='Could not open this file.';}}
</script>
<article class="lore-preview">
 <button type="button" onclick={open} title="Alt-click to preview"><strong>{filename}</strong><span>{project} · {filePath}{#if size !== null} · {size.toLocaleString()} bytes{/if}</span></button>
 {#if content}
  <div class="code-frame">
   <ol class="gutter" aria-hidden="true">{#each content.split('\n') as _line, index}<li>{firstLine + index}</li>{/each}</ol>
   <pre><code>{content}</code></pre>
  </div>
  <footer>
   <span>{#if lines}Lines {firstLine}–{firstLine + shownCount - 1} of {totalLines.toLocaleString()}{:else if totalLines > shownCount}First {shownCount} of {totalLines.toLocaleString()} lines · add <code>&amp;lines=40-72</code> to the link to point at a section{:else}{totalLines.toLocaleString()} lines{/if}</span>
   <button type="button" onclick={open}>Jump to file →</button>
  </footer>
 {:else}<p role="status">{status}</p>{/if}
</article>
<style>
 .lore-preview {margin:.8rem 0;border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));overflow:hidden;background:var(--w-raise);color:var(--w-text);}
 button {display:flex;flex-direction:column;gap:.3rem;width:100%;text-align:left;padding:.8rem;border:0;background:none;color:inherit;cursor:pointer;}
 span,p {font-size:.8rem;color:var(--w-mute);}p {padding:0 .8rem .8rem;margin:0;}
 .code-frame {display:flex;border-top:1px solid var(--w-line);background:var(--w-bg2);max-height:22rem;overflow:auto;}
 .gutter {margin:0;padding:.8rem .6rem .8rem .8rem;list-style:none;text-align:right;user-select:none;color:var(--w-faint);font:500 .75rem/1.5 var(--w-mono);border-right:1px solid var(--w-line);}
 pre {margin:0;padding:.8rem;overflow:visible;flex:1;min-width:0;font:400 .8rem/1.5 var(--w-mono);}
 footer {display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between;padding:.5rem .8rem;border-top:1px solid var(--w-line);font:500 .75rem var(--w-mono);color:var(--w-mute);}
 footer button {width:auto;flex-direction:row;padding:.25rem .7rem;border:1px solid var(--w-line-strong);border-radius:calc(8px * var(--w-rs, 1));color:var(--w-text);font:600 .78rem var(--w-sans);}
 footer button:hover {border-color:var(--w-accent);}
 footer code {font:inherit;color:var(--w-text);}
</style>
