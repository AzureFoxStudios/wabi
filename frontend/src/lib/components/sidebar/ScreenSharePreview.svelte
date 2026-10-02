<script lang="ts">
 import { screenShares, localScreenStream, localScreenShareSessionId } from '$lib/callingStateStores';
 import { wabidbRemoteVideoSessions } from '$lib/wabidbVideoLane';
 import { callSessions } from '$lib/callSessionManager';
 import { portal } from '$lib/actions/portal';
 import VideoSink from '../VideoSink.svelte';
 export let channelId: string;
 export let userId: string;
 export let username: string;
 export let announced = false;
 export let self = false;
 let open = false;
 let button: HTMLButtonElement;
 let left = 0, top = 0;
 $: session = [...$callSessions.values()].find(session => session.channelId === channelId);
 $: sessionId = session?.id || channelId;
 $: stream = self && $localScreenShareSessionId === sessionId ? $localScreenStream : $wabidbRemoteVideoSessions.get(sessionId)?.get(`${userId}:screen`) || $screenShares.find(share => share.userId === userId && share.channelId === channelId)?.stream || null;
 $: live = announced || Boolean(stream);
 function show() {
  const rect = button.getBoundingClientRect();
  left = Math.max(12, Math.min(rect.right + 8, window.innerWidth - 332));
  top = Math.max(12, Math.min(rect.top, window.innerHeight - 250)); open = true;
 }
</script>
{#if live}
 <button bind:this={button} type="button" class="live-tag" aria-label={`${username} is sharing a screen`} aria-expanded={open} on:mouseenter={show} on:mouseleave={() => open = false} on:focus={show} on:blur={() => open = false} on:click={() => open ? open = false : show()} on:keydown={(event) => { if (event.key === 'Escape') open = false; }}>LIVE</button>
 {#if open}<div use:portal class="share-preview" style:left={`${left}px`} style:top={`${top}px`} role="tooltip"><strong>{username}’s screen</strong>{#if stream}<div class="preview-video"><VideoSink {stream} /></div>{:else}<p>Join this voice channel to receive the screen share.</p>{/if}<small>Muted preview · does not join the call</small></div>{/if}
{/if}
<style>
 .live-tag { border: 0; border-radius: 5px; padding: 3px 6px; background: var(--color-danger, #b91c1c); color: white; font-size: 10px; font-weight: 700; line-height: 1.4; cursor: pointer; }
 .share-preview { position: fixed; z-index: 1600; width: min(300px, calc(100vw - 48px)); padding: 12px; border-radius: 12px; border: 1px solid var(--border-subtle); box-shadow: 0 10px 40px #0005; background: var(--bg-primary, #172326); color: var(--text-heading); pointer-events: none; }
 .preview-video { aspect-ratio: 16 / 9; margin-block: 10px; background: black; border-radius: 8px; overflow: hidden; }
 .preview-video :global(video) { width: 100%; height: 100%; object-fit: contain; }
 p, small { font-size: 12px; color: var(--text-muted); }
</style>
