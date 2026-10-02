<script lang="ts">
 import { initializeTheme } from '$lib/theme/initTheme';
 import { onMount } from 'svelte';
 import NotesWorkspace from '$lib/components/NotesWorkspace.svelte';
 import MapWorkspace from '$lib/components/MapWorkspace.svelte';
 import ModelViewportTab from '$lib/components/ModelViewportTab.svelte';
 import CallStage from '$lib/components/CallStage.svelte';
 import WhiteboardTab from '$lib/components/WhiteboardTab.svelte';
 import WhiteboardLayerPanel from '$lib/components/WhiteboardLayerPanel.svelte';
 import { chooseOfflineNotebook } from '$lib/notes/scope';
 import { wabidbRemoteVideoSessions } from '$lib/wabidbVideoLane';
 import { voiceChannelMembers, currentUser } from '$lib/socket';
 import { activeServerUrl } from '$lib/serverUrl';
 import type { CallSession } from '$lib/callSessionTypes';
 let view = 'notes';
 const session: CallSession = {id:'review',channelId:'review',name:'Design review',kind:'channel',direction:'listen',focus:'focused',volume:100,muted:false,lifecycle:'connected',transport:'wabidb',participants:[],spatialSeats:{},joinedAt:Date.now(),lastActivityAt:Date.now()};
 onMount(() => {
  if (!import.meta.env.DEV) return;
  void initializeTheme(); activeServerUrl.set(location.origin);
  const streams = new Map<string,MediaStream>();
  const participants = ['Alice','Bryn','Charlie'].map((username,index)=>({userId:`user-${index+1}`,username,isMuted:false,isDeafened:false,isSpeaking:index===0,profilePicture:`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${['#bd554b','#448477','#796cc2'][index]}"/><text x="40" y="55" text-anchor="middle" font-size="40" fill="white">${username[0]}</text></svg>`)}`}));
  currentUser.set({id:'user-1',dbUserId:1,isRegistered:true,username:'Alice',highestRole:'owner',color:'#448477',profilePicture:participants[0].profilePicture} as any); voiceChannelMembers.set({review:participants}); void chooseOfflineNotebook();
  for (let index=0;index<3;index++) {
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
   const ctx=canvas.getContext('2d')!;ctx.fillStyle=['#bd554b','#448477','#796cc2'][index];ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='32px sans-serif';ctx.fillText(`${participants[index].username}'s screen`,40,180);
   streams.set(`user-${index+1}:screen`,canvas.captureStream());
  }
  wabidbRemoteVideoSessions.set(new Map([['review',streams]]));
  return ()=>{for(const stream of streams.values())for(const track of stream.getTracks())track.stop();wabidbRemoteVideoSessions.set(new Map());};
 });
</script>
<nav>{#each ['notes','map','model','call','whiteboard'] as name}<button on:click={()=>view=name}>{name}</button>{/each}</nav>
<main>
 {#if view==='notes'}<NotesWorkspace/>{:else if view==='map'}<MapWorkspace/>{:else if view==='model'}<ModelViewportTab/>{:else if view==='call'}<CallStage {session} spatialEnabled/>{:else}<div class="board"><WhiteboardTab channelId="review"/></div><aside><WhiteboardLayerPanel/></aside>{/if}
</main>
<style>nav{display:flex;gap:8px;height:48px;align-items:center;padding:8px;background:var(--bg-primary)}button{padding:8px 16px;color:var(--text-primary);background:var(--bg-secondary);border:1px solid var(--border-subtle)}main{height:calc(100vh - 64px);display:flex;background:var(--bg-primary);color:var(--text-primary)}.board{flex:1;min-width:0}aside{width:300px}</style>
