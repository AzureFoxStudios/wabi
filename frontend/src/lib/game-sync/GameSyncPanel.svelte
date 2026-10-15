<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getSocket } from '$lib/socket';
  import { channels, currentChannel, currentUser } from '$lib/socket';
  import type { GameSessionState, GameIncoming } from './protocol';
  import { GO_SIZES, GO_SIZES as sizes } from './protocol';

  let channelSize = $state(19);
  let selectedChannelId = $state<string>('');
  let session = $state<GameSessionState | null>(null);
  let noneState = $state(false);
  let error = $state('');
  let busy = $state(false);
  let socket = $state<ReturnType<typeof getSocket>>(null);

  const me = $derived($currentUser);
  const isPlayer = $derived(session?.seats?.some(s => s === me?.dbUserId) ?? false);
  const mySeat = $derived(session ? (session.seats[0] === me?.dbUserId ? 0 : (session.seats[1] === me?.dbUserId ? 1 : -1)) : -1);
  const isMyTurn = $derived(session?.status === 'active' && session.toPlay === mySeat && mySeat >= 0);
  const seatNames = $derived(session?.seatNames ?? []);
  let lastMove = $derived.by(() => {
    if (!session?.moves?.length) return null;
    const m = session.moves[session.moves.length - 1];
    if (m.pass) return 'pass';
    return m.x + ',' + m.y;
  });

  function emit(name: string, payload: Record<string, any> = {}): void {
    if (!socket || !selectedChannelId) return;
    socket.emit(name, { channelId: selectedChannelId, ...payload });
  }

  function onState(s: GameIncoming): void {
    if (!s || s.channelId !== selectedChannelId) return;
    if ((s as any).status === 'none') { session = null; noneState = true; return; }
    session = s as GameSessionState; noneState = false; error = '';
  }
  function onError(p: { error?: string }): void {
    if (p && p.error) error = String(p.error);
  }

  function syncChannel(): void {
    const preferred = $channels.find(c => c.id === $currentChannel)?.id;
    if (!selectedChannelId || (preferred && preferred !== selectedChannelId)) {
      if (preferred) selectedChannelId = preferred;
    }
    if (!selectedChannelId && $channels.length) selectedChannelId = $channels[0].id;
  }

  function selectChannel(id: string): void {
    if (id === selectedChannelId) return;
    selectedChannelId = id;
    session = null; noneState = false; error = '';
    if (socket) { socket.emit('game:join', { channelId: id }); }
  }

  function createGame(): void {
    if (busy) return;
    busy = true; error = '';
    emit('game:create', { size: channelSize });
    setTimeout(() => (busy = false), 400);
  }
  function claimSeat(): void {
    if (busy) return;
    busy = true; error = '';
    emit('game:claim', {});
    setTimeout(() => (busy = false), 400);
  }
  function place(x: number, y: number): void {
    if (!isMyTurn || busy) return;
    emit('game:move', { x, y });
  }
  function pass(): void {
    if (!isMyTurn || busy) return;
    emit('game:pass', {});
  }
  function resign(): void {
    if (!isPlayer || session?.status !== 'active' || busy) return;
    if (!window.confirm('Resign this game?')) return;
    emit('game:resign', {});
  }

  onMount(() => {
    socket = getSocket();
    syncChannel();
    const sock = socket;
    if (sock) {
      sock.on('game:state', onState);
      sock.on('game:error', onError);
      if (selectedChannelId) sock.emit('game:join', { channelId: selectedChannelId });
    }
    const unsub = channels.subscribe(() => { syncChannel(); });
    return () => { unsub(); };
  });
  onDestroy(() => {
    const sock = socket;
    if (sock) {
      sock.off('game:state', onState);
      sock.off('game:error', onError);
    }
  });

  $: if (socket && selectedChannelId && $channels.length) { /* reactive join handled above */ }
  $: syncChannel();

  // board grid
  function stones(): number[] {
    return session?.board ?? [];
  }
  const boardSize = $derived(session?.size ?? channelSize);
  const boardCells = $derived(stones());
</script>

<section class="game-sync-panel">
  <div class="gs-row">
    <label class="gs-label">Channel
      <select value={selectedChannelId} on:change={(e) => selectChannel((e.target as HTMLSelectElement).value)}>
        {#each $channels as ch (ch.id)}
          <option value={ch.id}>#{ch.name}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if error}
    <p role="alert" class="gs-msg error">{error}</p>
  {/if}

  {#if noneState}
    <div class="gs-empty">
      <p>No game in this channel.</p>
      <div class="gs-row">
        <label>Size
          <select bind:value={channelSize}>
            {#each GO_SIZES as sz}
              <option value={sz}>{sz}×{sz}</option>
            {/each}
          </select>
        </label>
        <button class="gs-btn" onclick={createGame} disabled={busy}>Start Go game</button>
      </div>
      <p class="gs-hint">Two players claim seats; others watch.</p>
    </div>
  {:else if session && session.status === 'waiting'}
    <div class="gs-empty">
      <p>Waiting for an opponent to claim the white seat.</p>
      <p class="gs-hint">Black: {session.seatNames[0] ?? '—'}</p>
      {#if session.seats[1] === null && me?.dbUserId !== session.seats[0]}
        <button class="gs-btn" onclick={claimSeat} disabled={busy}>Join as White</button>
      {/if}
      <button class="gs-btn secondary" onclick={() => (noneState = false, session = session)} disabled> </button>
    </div>
  {:else if session}
    <div class="gs-board-wrap">
      <div class="gs-statebar">
        <span>
          {#if session.status === 'finished'}
            Finished{session.winner === null ? '' : ` — ${session.seatNames[session.winner] ?? ''} wins (${session.reason})`}. Scores: see territory
          {:else}
            {session.seatNames[session.toPlay] ?? '?'} to play ({session.toPlay === 0 ? 'Black' : 'White'})
            {isMyTurn ? ' — your turn' : ''}
          {/if}
        </span>
        {#if isPlayer && session.status === 'active'}
          <button class="gs-btn tiny" onclick={pass} disabled={busy || !isMyTurn}>Pass</button>
          <button class="gs-btn tiny danger" onclick={resign} disabled={busy}>Resign</button>
        {/if}
      </div>
      <div
        class="gs-board"
        style={`--n:${boardSize}`}
        role="grid"
        aria-label="Go board"
      >
        {#each boardCells as stone, i (i)}
          {@const pt = { x: i % boardSize, y: Math.floor(i / boardSize) }}
          <button
            type="button"
            class="gs-cell"
            class:has-stone={stone === 0 || stone === 1}
            aria-label={`intersection ${pt.x},${pt.y}${stone === 0 ? ' black' : stone === 1 ? ' white' : ''}`}
            onclick={() => place(pt.x, pt.y)}
            disabled={!isMyTurn}
          >
            {#if stone === 0 || stone === 1}
              <span class="gs-stone {stone === 0 ? 'black' : 'white'}" />
            {/if}
            {#if session.ko && session.ko.x === pt.x && session.ko.y === pt.y}
              <span class="gs-ko" aria-hidden="true" />
            {/if}
          </button>
        {/each}
      </div>
      <div class="gs-komi">Komi 6.5 · moves: {session.moves.length}</div>
    </div>
  {:else}
    <p class="gs-hint">Loading…</p>
  {/if}
</section>

<style>
  .game-sync-panel { display: flex; flex-direction: column; gap: var(--space-sm, 8px); padding: var(--space-md, 12px); color: var(--text-secondary, #b3b3ff); font-size: 0.85rem; }
  .gs-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .gs-label { display: flex; flex-direction: column; gap: 2px; font-size: 0.75rem; color: var(--text-muted, #9999ff); }
  .gs-label select { background: var(--surface-base, #24243e); color: var(--text-heading, #e0e0ff); border: 1px solid var(--border-subtle, #3a3a60); border-radius: var(--radius-sm, 4px); padding: 2px 6px; }
  .gs-msg { margin: 0; padding: 6px 8px; border-radius: var(--radius-sm, 4px); }
  .gs-msg.error { background: rgba(255,80,80,0.12); color: #ff9999; }
  .gs-empty { display: flex; flex-direction: column; gap: 8px; }
  .gs-empty p { margin: 0; }
  .gs-hint { color: var(--text-muted, #9999ff); font-size: 0.75rem; }
  .gs-btn { cursor: pointer; border: 1px solid var(--accent-primary, #6366f1); background: var(--accent-primary, #6366f1); color: #fff; border-radius: var(--radius-sm, 4px); padding: 4px 10px; font-size: 0.8rem; }
  .gs-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .gs-btn.secondary { background: transparent; color: var(--text-secondary, #b3b3ff); border-color: var(--border-subtle, #3a3a60); }
  .gs-btn.tiny { padding: 2px 8px; font-size: 0.72rem; }
  .gs-btn.danger { background: rgba(255,80,80,0.15); border-color: #ff6666; color: #ff9999; }
  .gs-board-wrap { display: flex; flex-direction: column; gap: 8px; }
  .gs-statebar { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 0.78rem; padding: 4px 0; }
  .gs-board { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 0; background: #dcb35c; border: 1px solid #8a6a30; padding: 4px; border-radius: var(--radius-sm, 4px); aspect-ratio: 1 / 1; max-width: 100%; }
  .gs-cell { position: relative; aspect-ratio: 1 / 1; background: transparent; border: 0; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
  .gs-cell:disabled { cursor: default; }
  .gs-cell::before { content: ''; position: absolute; inset: 50% 0 50% 0; background: rgba(70,45,10,0.35); height: 1px; }
  .gs-cell::after { content: ''; position: absolute; inset: 0 50% 0 50%; background: rgba(70,45,10,0.35); width: 1px; margin: auto; }
  /* simpler shared grid lines via borders */
  .gs-cell { border-top: 1px solid rgba(70,45,10,0.45); border-left: 1px solid rgba(70,45,10,0.45); }
  .gs-cell:last-child { }
  .gs-stone { width: 70%; height: 70%; border-radius: 50%; z-index: 1; pointer-events: none; }
  .gs-stone.black { background: radial-gradient(circle at 35% 30%, #555, #000); box-shadow: 0 1px 2px rgba(0,0,0,0.6); }
  .gs-stone.white { background: radial-gradient(circle at 35% 30%, #fff, #c9c9c9); box-shadow: 0 1px 2px rgba(0,0,0,0.5); }
  .gs-ko { position: absolute; width: 28%; height: 28%; border: 1px dashed #a02020; border-radius: 50%; pointer-events: none; }
  .gs-komi { font-size: 0.7rem; color: var(--text-muted, #9999ff); }
</style>