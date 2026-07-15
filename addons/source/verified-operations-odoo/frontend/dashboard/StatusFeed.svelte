<script lang="ts">
  let events = $state<{ action: string; actorRole: string; details: Record<string, unknown>; timestamp: number }[]>([])

  $effect(() => {
    fetchEvents()
    const interval = setInterval(fetchEvents, 10000)
    return () => clearInterval(interval)
  })

  async function fetchEvents() {
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/audit?limit=8')
      if (res.ok) events = await res.json()
    } catch {}
  }

  function formatAction(action: string): string {
    return action.replace(/:/g, ' · ').toUpperCase()
  }

  function timeAgo(ts: number): string {
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m`
    return `${Math.floor(secs / 3600)}h`
  }
</script>

<div class="feed-rows">
  {#each events as evt}
    <div class="feed-row">
      <span class="dim">{formatAction(evt.action)}</span>
      <span class="dim">{timeAgo(evt.timestamp)}</span>
    </div>
  {/each}
  {#if events.length === 0}
    <div class="mono-sub dim">NO RECENT ACTIVITY</div>
  {/if}
</div>

<style>
  .feed-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
    flex: 1;
    overflow: hidden;
    font: 400 12px/1.5 'Space Mono', monospace;
    letter-spacing: 0.04em;
    color: #e8e8e8;
  }
  .feed-row {
    display: flex;
    justify-content: space-between;
    gap: 14px;
  }
  .feed-row .dim {
    flex: none;
  }
</style>
