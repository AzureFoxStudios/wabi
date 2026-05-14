<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getSocket } from '$lib/socket';
  import ArtAssetsOverlay from './ArtAssetsOverlay.svelte';

  interface QueueItem {
    id: string;
    videoId: string;
    title?: string;
    requestedBy?: string;
  }

  interface VoteState {
    id: string;
    yes: string[];
    no: string[];
    threshold: number;
  }

  interface WatchRoomState {
    channelId: string;
    currentVideoId?: string;
    positionSec: number;
    isPlaying: boolean;
    playbackRate: number;
    controlMode: 'open' | 'presenter' | 'vote';
    presenterUserId?: string;
    queue: QueueItem[];
    videoRequestStats?: Record<string, { count: number; lastRequestedAt: number; lastRequestedBy?: string }>;
    queueModerated?: boolean;
    pendingQueue?: QueueItem[];
    pendingVote?: VoteState;
    updatedAt: number;
    updatedBy?: string;
  }

  type YTPlayerState = -1 | 0 | 1 | 2 | 3 | 5;

  export let url: string;
  export let channelId: string;

  const socket = getSocket();
  let room: WatchRoomState | null = null;
  let expanded = false;
  let overlayEnabled = false;
  let queued = false;
  let seekInput = '0';
  let infoMessage = '';

  let playerHost: HTMLDivElement | null = null;
  let player: any = null;
  let playerReady = false;
  let localPollTimer: ReturnType<typeof setInterval> | null = null;
  let suppressLocalEventsUntil = 0;
  let localState: YTPlayerState = -1;

  let videoTitles: Record<string, string> = {};
  const loadingTitles = new Set<string>();

  function extractVideoId(input: string): string | null {
    const raw = input.trim();
    if (!raw) return null;

    const idPattern = /^[a-zA-Z0-9_-]{11}$/;
    if (idPattern.test(raw)) return raw;

    try {
      const parsed = new URL(raw);
      if (parsed.hostname.includes('youtu.be')) {
        const shortId = parsed.pathname.replace('/', '').trim();
        return idPattern.test(shortId) ? shortId : null;
      }

      if (parsed.hostname.includes('youtube.com')) {
        const v = parsed.searchParams.get('v') || '';
        if (idPattern.test(v)) return v;
        const parts = parsed.pathname.split('/').filter(Boolean);
        const idx = parts.findIndex((p) => p === 'embed' || p === 'shorts');
        if (idx >= 0 && parts[idx + 1] && idPattern.test(parts[idx + 1])) return parts[idx + 1];
      }
    } catch {
      return null;
    }

    return null;
  }

  function thumbFor(videoId: string): string {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  function titleFor(item: QueueItem | null): string {
    if (!item) return 'Unknown video';
    return item.title || videoTitles[item.videoId] || `Video ${item.videoId}`;
  }

  function requestCountFor(videoId?: string): number {
    if (!videoId) return 0;
    return room?.videoRequestStats?.[videoId]?.count || 0;
  }

  function displayId(videoId?: string): string {
    if (!videoId) return '';
    return videoId.length > 8 ? `${videoId.slice(0, 8)}...` : videoId;
  }

  async function ensureVideoTitle(videoId: string): Promise<void> {
    if (!videoId || videoTitles[videoId] || loadingTitles.has(videoId)) return;
    loadingTitles.add(videoId);
    try {
      const target = `https://www.youtube.com/watch?v=${videoId}`;
      const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const data = await res.json();
      const title = typeof data?.title === 'string' ? data.title.trim() : '';
      if (title) {
        videoTitles = { ...videoTitles, [videoId]: title };
      }
    } catch {
      // Best-effort title fetch only.
    } finally {
      loadingTitles.delete(videoId);
    }
  }

  $: initialVideoId = extractVideoId(url);
  $: activeVideoId = room?.currentVideoId || initialVideoId;
  $: canPresent = Boolean(socket && room && (room.controlMode === 'open' || !room.presenterUserId || room.presenterUserId === socket.id));
  $: canManageQueue = Boolean(canPresent && room?.controlMode !== 'vote');
  $: canModerateQueue = Boolean(canManageQueue);
  $: nowPlayingItem = activeVideoId ? ({ id: activeVideoId, videoId: activeVideoId } as QueueItem) : null;

  $: if (activeVideoId) {
    void ensureVideoTitle(activeVideoId);
  }

  $: if (room?.queue?.length) {
    room.queue.forEach((item) => {
      void ensureVideoTitle(item.videoId);
    });
  }

  $: if (room?.pendingQueue?.length) {
    room.pendingQueue.forEach((item) => {
      void ensureVideoTitle(item.videoId);
    });
  }

  function emitWatch(event: string, payload: Record<string, any> = {}): void {
    if (!socket || !channelId) return;
    socket.emit(event, { channelId, ...payload });
  }

  function requestState(): void {
    emitWatch('watch:get-state');
  }

  function queueThisVideo(): void {
    if (!initialVideoId) return;
    emitWatch('watch:add', { url });
    queued = true;
    infoMessage = room?.queueModerated ? 'Submitted for moderator approval' : 'Queued in watch room';
  }

  function claimPresenter(): void {
    emitWatch('watch:presenter:set');
  }

  function setMode(mode: 'open' | 'presenter' | 'vote'): void {
    emitWatch('watch:mode:set', { mode });
  }

  function startVote(actionType: 'play' | 'pause' | 'seek' | 'skip'): void {
    const payload: Record<string, any> = { actionType };
    if (actionType === 'seek') {
      const positionSec = Number.parseFloat(seekInput);
      if (!Number.isFinite(positionSec)) return;
      payload.positionSec = positionSec;
    }
    emitWatch('watch:vote:start', payload);
  }

  function castVote(approve: boolean): void {
    emitWatch('watch:vote:cast', { approve });
  }

  function play(): void {
    if (room?.controlMode === 'vote') {
      startVote('play');
      return;
    }
    emitWatch('watch:play', { positionSec: room?.positionSec || 0 });
  }

  function pause(): void {
    if (room?.controlMode === 'vote') {
      startVote('pause');
      return;
    }
    emitWatch('watch:pause', { positionSec: room?.positionSec || 0 });
  }

  function seek(): void {
    const positionSec = Number.parseFloat(seekInput);
    if (!Number.isFinite(positionSec)) return;

    if (room?.controlMode === 'vote') {
      startVote('seek');
      return;
    }
    emitWatch('watch:seek', { positionSec });
  }

  function skip(): void {
    if (room?.controlMode === 'vote') {
      startVote('skip');
      return;
    }
    emitWatch('watch:skip');
  }

  function queuePlayNow(queueId: string): void {
    emitWatch('watch:queue:play-now', { queueId });
  }

  function queuePlayNext(queueId: string): void {
    emitWatch('watch:queue:play-next', { queueId });
  }

  function queueMove(queueId: string, direction: 'up' | 'down'): void {
    emitWatch('watch:queue:move', { queueId, direction });
  }

  function queueRemove(queueId: string): void {
    emitWatch('watch:queue:remove', { queueId });
  }

  function queueClear(): void {
    if (!room?.queue?.length) return;
    if (!window.confirm('Clear the entire watch queue?')) return;
    emitWatch('watch:queue:clear');
  }

  function setQueueModeration(enabled: boolean): void {
    emitWatch('watch:queue:moderation:set', { enabled });
  }

  function queueApprove(queueId: string): void {
    emitWatch('watch:queue:approve', { queueId });
  }

  function queueReject(queueId: string): void {
    emitWatch('watch:queue:reject', { queueId });
  }

  function applySuppressWindow(ms = 1400): void {
    suppressLocalEventsUntil = Date.now() + ms;
  }

  function shouldSuppressLocalEvents(): boolean {
    return Date.now() < suppressLocalEventsUntil;
  }

  function syncPlayer(state: WatchRoomState): void {
    if (!player || !playerReady) return;
    applySuppressWindow();

    try {
      const current = Number(player.getCurrentTime?.() || 0);
      const drift = Math.abs(current - state.positionSec);
      if (Number.isFinite(state.positionSec) && drift > 1.1) {
        player.seekTo?.(state.positionSec, true);
      }
      if (Number.isFinite(state.playbackRate)) {
        player.setPlaybackRate?.(state.playbackRate);
      }
      if (state.isPlaying) {
        player.playVideo?.();
      } else {
        player.pauseVideo?.();
      }
    } catch {
      // Keep UI responsive even if player API momentarily fails.
    }
  }

  function onPlayerStateChange(event: { data: number }): void {
    localState = (event.data ?? -1) as YTPlayerState;
    if (!room || shouldSuppressLocalEvents()) return;

    if (localState === 1) {
      const positionSec = Number(player?.getCurrentTime?.() || room.positionSec || 0);
      emitWatch('watch:play', { positionSec });
    } else if (localState === 2) {
      const positionSec = Number(player?.getCurrentTime?.() || room.positionSec || 0);
      emitWatch('watch:pause', { positionSec });
    }
  }

  async function ensureYouTubeAPI(): Promise<void> {
    if (typeof window === 'undefined') return;

    const yt = (window as any).YT;
    if (yt?.Player) return;

    await new Promise<void>((resolve) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-youtube-api="1"]');
      if (!existing) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.setAttribute('data-youtube-api', '1');
        document.head.appendChild(script);
      }

      const prev = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve();
      };

      const check = () => {
        if ((window as any).YT?.Player) {
          resolve();
          return true;
        }
        return false;
      };

      if (check()) return;
      const timer = setInterval(() => {
        if (check()) clearInterval(timer);
      }, 50);
    });
  }

  async function mountPlayer(): Promise<void> {
    if (!expanded || !playerHost || !activeVideoId) return;
    await ensureYouTubeAPI();
    if (!expanded || !playerHost || !activeVideoId) return;

    if (player) {
      try {
        const currentId = player.getVideoData?.()?.video_id;
        if (currentId !== activeVideoId) {
          applySuppressWindow();
          player.loadVideoById?.(activeVideoId);
        }
      } catch {
        // If an existing player is in a bad state, rebuild below.
      }
      return;
    }

    const YT = (window as any).YT;
    player = new YT.Player(playerHost, {
      videoId: activeVideoId,
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1
      },
      events: {
        onReady: () => {
          playerReady = true;
          if (room) syncPlayer(room);
        },
        onStateChange: onPlayerStateChange
      }
    });
  }

  function destroyPlayer(): void {
    playerReady = false;
    if (localPollTimer) {
      clearInterval(localPollTimer);
      localPollTimer = null;
    }
    if (player?.destroy) {
      try {
        player.destroy();
      } catch {
        // No-op on teardown.
      }
    }
    player = null;
  }

  function onWatchState(state: WatchRoomState): void {
    if (!state || state.channelId !== channelId) return;
    room = state;
    seekInput = String(Math.round(state.positionSec || 0));
    if (expanded) syncPlayer(state);
  }

  function onWatchAction(action: { channelId: string; type: string; payload?: Record<string, any> }): void {
    if (!action || action.channelId !== channelId) return;

    if (action.type === 'play') {
      applySuppressWindow();
      player?.playVideo?.();
    }
    if (action.type === 'pause') {
      applySuppressWindow();
      player?.pauseVideo?.();
    }
    if (action.type === 'seek' && Number.isFinite(action.payload?.positionSec)) {
      applySuppressWindow();
      player?.seekTo?.(action.payload?.positionSec, true);
      seekInput = String(Math.round(action.payload?.positionSec || 0));
    }
    if (action.type === 'skip') {
      infoMessage = 'Skipped to next item';
    }
  }

  function onWatchError(payload: { message?: string }): void {
    if (payload?.message) {
      infoMessage = payload.message;
    }
  }

  function onVoteResolved(payload: { channelId: string; passed: boolean; action: { type: string } }): void {
    if (!payload || payload.channelId !== channelId) return;
    infoMessage = payload.passed ? `Vote passed: ${payload.action.type}` : `Vote failed: ${payload.action.type}`;
  }

  function onQueuedPending(payload: { channelId: string }): void {
    if (!payload || payload.channelId !== channelId) return;
    infoMessage = 'Submitted for approval';
  }

  onMount(() => {
    if (!socket) return;

    socket.on('watch:state', onWatchState);
    socket.on('watch:action', onWatchAction);
    socket.on('watch:error', onWatchError);
    socket.on('watch:vote:resolved', onVoteResolved);
    socket.on('watch:queued:pending', onQueuedPending);
    requestState();

    localPollTimer = setInterval(() => {
      if (!expanded || !player || !playerReady) return;
      try {
        const t = Number(player.getCurrentTime?.() || 0);
        if (Number.isFinite(t)) {
          seekInput = String(Math.round(t));
        }
      } catch {
        // Ignore poll reads during transient player state.
      }
    }, 600);

    return () => {
      socket.off('watch:state', onWatchState);
      socket.off('watch:action', onWatchAction);
      socket.off('watch:error', onWatchError);
      socket.off('watch:vote:resolved', onVoteResolved);
      socket.off('watch:queued:pending', onQueuedPending);
    };
  });

  onDestroy(() => {
    destroyPlayer();
  });

  $: if (expanded) {
    void mountPlayer();
  } else {
    destroyPlayer();
  }

  $: if (expanded && player && playerReady && activeVideoId) {
    try {
      const currentId = player.getVideoData?.()?.video_id;
      if (currentId !== activeVideoId) {
        applySuppressWindow();
        player.loadVideoById?.(activeVideoId);
      }
    } catch {
      // Ignore reactive player update errors.
    }
  }
</script>

<div class="watch-embed">
  <div class="watch-topbar">
    <button type="button" class="primary" on:click={() => (expanded = !expanded)}>{expanded ? 'Hide Watch Panel' : 'Open Watch Panel'}</button>
    <button type="button" on:click={queueThisVideo} disabled={!initialVideoId || queued}>{queued ? 'Queued' : 'Queue This Video'}</button>
    <button type="button" on:click={requestState}>Refresh</button>
  </div>

  {#if expanded}
    <div class="watch-stage">
      {#if activeVideoId}
        <div bind:this={playerHost} class="player-host" aria-label="YouTube watch player"></div>
      {:else}
        <div class="no-video">Invalid YouTube link</div>
      {/if}

      <ArtAssetsOverlay channelId={channelId} enabled={overlayEnabled} />
    </div>

    <div class="watch-controls">
      <button type="button" on:click={play} disabled={!canPresent && room?.controlMode !== 'vote'}>Play</button>
      <button type="button" on:click={pause} disabled={!canPresent && room?.controlMode !== 'vote'}>Pause</button>
      <button type="button" on:click={skip} disabled={!canPresent && room?.controlMode !== 'vote'}>Skip</button>
      <input type="number" min="0" step="1" bind:value={seekInput} placeholder="Seek sec" />
      <button type="button" on:click={seek} disabled={!canPresent && room?.controlMode !== 'vote'}>Seek</button>
      <label class="overlay-toggle">
        <input type="checkbox" bind:checked={overlayEnabled} />
        <span>Enable Art Overlay Layer</span>
      </label>
    </div>

    <div class="watch-meta">
      <span>Mode: {room?.controlMode || 'presenter'}</span>
      <span>Playing: {room?.isPlaying ? 'Yes' : 'No'}</span>
      <span>Time: {Math.round(room?.positionSec || 0)}s</span>
      <span>Queue: {room?.queue?.length || 0}</span>
      <span>Moderation: {room?.queueModerated ? 'On' : 'Off'}</span>
    </div>

    <div class="watch-queue-panel">
      <div class="queue-section-head">
        <div class="queue-section-title">Now Playing</div>
      </div>
      {#if nowPlayingItem}
        <article class="queue-card current">
          <img src={thumbFor(nowPlayingItem.videoId)} alt="Now playing thumbnail" loading="lazy" />
          <div class="queue-card-meta">
            <div class="queue-card-title">{titleFor(nowPlayingItem)}</div>
            <div class="queue-card-sub">ID: {displayId(nowPlayingItem.videoId)}</div>
            {#if requestCountFor(nowPlayingItem.videoId) > 1}
              <div class="queue-card-trend">Requested {requestCountFor(nowPlayingItem.videoId)} times</div>
            {/if}
          </div>
        </article>
      {:else}
        <div class="queue-empty">Nothing is playing yet.</div>
      {/if}

      <div class="queue-section-head">
        <div class="queue-section-title">Up Next</div>
        <button type="button" class="queue-clear-btn" on:click={queueClear} disabled={!canManageQueue || !room?.queue?.length}>
          Clear Queue
        </button>
      </div>
      {#if room?.queue?.length}
        <div class="queue-list">
          {#each room.queue as item, idx (item.id)}
            <article class="queue-card">
              <img src={thumbFor(item.videoId)} alt="Queue thumbnail" loading="lazy" />
              <div class="queue-card-meta">
                <div class="queue-card-title">{titleFor(item)}</div>
                <div class="queue-card-sub">
                  {#if item.requestedBy}
                    Added by {item.requestedBy}
                  {:else}
                    Added by unknown
                  {/if}
                </div>
                {#if requestCountFor(item.videoId) > 1}
                  <div class="queue-card-trend">Requested {requestCountFor(item.videoId)} times</div>
                {/if}
                <div class="queue-card-actions">
                  <button type="button" on:click={() => queuePlayNow(item.id)} disabled={!canManageQueue}>Now</button>
                  <button type="button" on:click={() => queuePlayNext(item.id)} disabled={!canManageQueue}>Next</button>
                  <button type="button" on:click={() => queueMove(item.id, 'up')} disabled={!canManageQueue || idx === 0}>Up</button>
                  <button type="button" on:click={() => queueMove(item.id, 'down')} disabled={!canManageQueue || idx === (room?.queue?.length || 0) - 1}>Down</button>
                  <button type="button" on:click={() => queueRemove(item.id)} disabled={!canManageQueue}>Remove</button>
                </div>
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="queue-empty">Queue is empty.</div>
      {/if}

      {#if room?.queueModerated}
        <div class="queue-section-head">
          <div class="queue-section-title">Pending Approval</div>
          <div class="queue-pending-count">{room?.pendingQueue?.length || 0} pending</div>
        </div>
        {#if room?.pendingQueue?.length}
          <div class="queue-list">
            {#each room.pendingQueue as item (item.id)}
              <article class="queue-card pending">
                <img src={thumbFor(item.videoId)} alt="Pending queue thumbnail" loading="lazy" />
                <div class="queue-card-meta">
                  <div class="queue-card-title">{titleFor(item)}</div>
                  <div class="queue-card-sub">
                    {#if item.requestedBy}
                      Requested by {item.requestedBy}
                    {:else}
                      Requested by unknown
                    {/if}
                  </div>
                  {#if requestCountFor(item.videoId) > 1}
                    <div class="queue-card-trend">Requested {requestCountFor(item.videoId)} times</div>
                  {/if}
                  {#if canModerateQueue}
                    <div class="queue-card-actions">
                      <button type="button" on:click={() => queueApprove(item.id)}>Approve</button>
                      <button type="button" on:click={() => queueReject(item.id)}>Reject</button>
                    </div>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        {:else}
          <div class="queue-empty">No pending links.</div>
        {/if}
      {/if}
    </div>

    <div class="watch-mode-controls">
      <button type="button" on:click={claimPresenter}>Claim Presenter</button>
      <button type="button" on:click={() => setMode('open')}>Open Mode</button>
      <button type="button" on:click={() => setMode('presenter')}>Presenter Mode</button>
      <button type="button" on:click={() => setMode('vote')}>Vote Mode</button>
      <button type="button" on:click={() => setQueueModeration(!(room?.queueModerated || false))} disabled={!canModerateQueue}>
        {room?.queueModerated ? 'Disable Queue Moderation' : 'Enable Queue Moderation'}
      </button>
      {#if room?.pendingVote}
        <button type="button" on:click={() => castVote(true)}>Vote Yes</button>
        <button type="button" on:click={() => castVote(false)}>Vote No</button>
      {/if}
    </div>
  {/if}

  {#if infoMessage}
    <div class="watch-info">{infoMessage}</div>
  {/if}
</div>

<style>
  .watch-embed {
    margin-top: 0.6rem;
    border: 1px solid var(--border-color, #2a2a4a);
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-base, #16213e) 80%, black 20%);
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .watch-topbar,
  .watch-controls,
  .watch-meta,
  .watch-mode-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }

  .watch-embed button,
  .watch-embed input {
    font-size: 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--border-color, #2a2a4a);
    background: var(--surface-app, #0f172a);
    color: var(--text-heading, #e2e8f0);
    padding: 0.3rem 0.5rem;
  }

  .watch-embed button.primary {
    background: color-mix(in srgb, var(--accent, #5865f2) 78%, black 22%);
    border-color: color-mix(in srgb, var(--accent, #5865f2) 70%, white 30%);
  }

  .watch-stage {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 8px;
    overflow: hidden;
    background: #000;
  }

  .player-host {
    width: 100%;
    height: 100%;
  }

  .player-host :global(iframe) {
    width: 100%;
    height: 100%;
    border: 0;
  }

  .no-video {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    color: #cbd5e1;
    font-size: 0.85rem;
  }

  .overlay-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--text-secondary, #94a3b8);
    font-size: 0.75rem;
  }

  .overlay-toggle input {
    margin: 0;
  }

  .watch-meta {
    color: var(--text-secondary, #94a3b8);
    font-size: 0.72rem;
  }

  .watch-queue-panel {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 8px;
    padding: 0.4rem;
    background: rgba(2, 6, 23, 0.4);
  }

  .queue-section-title {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #94a3b8;
  }

  .queue-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
  }

  .queue-clear-btn {
    font-size: 0.68rem;
    padding: 0.2rem 0.45rem;
  }

  .queue-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .queue-card {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 0.5rem;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    background: rgba(15, 23, 42, 0.72);
    overflow: hidden;
  }

  .queue-card.current {
    border-color: rgba(56, 189, 248, 0.45);
  }

  .queue-card.pending {
    border-color: rgba(251, 191, 36, 0.45);
  }

  .queue-card img {
    width: 96px;
    height: 54px;
    object-fit: cover;
    background: #020617;
  }

  .queue-card-meta {
    min-width: 0;
    padding: 0.28rem 0.45rem 0.28rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    justify-content: center;
  }

  .queue-card-title {
    font-size: 0.78rem;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .queue-card-sub {
    font-size: 0.68rem;
    color: #94a3b8;
  }

  .queue-card-trend {
    font-size: 0.68rem;
    color: var(--color-warning);
  }

  .queue-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.24rem;
    margin-top: 0.2rem;
  }

  .queue-card-actions button {
    font-size: 0.64rem;
    padding: 0.14rem 0.34rem;
    border-radius: 5px;
    border: 1px solid rgba(148, 163, 184, 0.35);
    background: rgba(15, 23, 42, 0.9);
    color: #e2e8f0;
  }

  .queue-empty {
    font-size: 0.72rem;
    color: #94a3b8;
  }

  .queue-pending-count {
    font-size: 0.68rem;
    color: #94a3b8;
  }

  .watch-info {
    font-size: 0.72rem;
    color: var(--text-secondary, #94a3b8);
  }
</style>
