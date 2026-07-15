<script lang="ts">
  import RingMetric from './shared/RingMetric.svelte'

  let stats = $state<{ total: number; verified: number; tampered: number; unacknowledged: number } | null>(null)

  $effect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  })

  async function fetchStats() {
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/verify/stats')
      if (res.ok) stats = await res.json()
    } catch {}
  }
</script>

{#if stats}
  <div class="mono-row">
    <span class="mono-sub" style="color:#4a9e5c">● {stats.verified} verified</span>
    {#if stats.tampered > 0}
      <span class="mono-sub" style="color:#d71921">● {stats.tampered} tampered</span>
    {/if}
  </div>
  <div class="ring-area">
    <RingMetric
      value={stats.verified}
      max={Math.max(stats.total, 1)}
      label="OK"
      color="#4a9e5c"
      size={90}
    />
    {#if stats.tampered > 0}
      <RingMetric
        value={stats.tampered}
        max={Math.max(stats.total, 1)}
        label="TMP"
        color="#d71921"
        size={90}
      />
    {/if}
  </div>
  <div class="mono-sub dim" style="margin-top:8px">
    {stats.unacknowledged > 0 ? `${stats.unacknowledged} unacknowledged alerts` : 'All clear'}
  </div>
{:else}
  <div class="mono-sub dim" style="margin-top:14px">NO SNAPSHOTS YET</div>
{/if}

<style>
  .mono-row {
    display: flex;
    gap: 16px;
    margin-top: 14px;
  }
  .ring-area {
    display: flex;
    gap: 16px;
    justify-content: center;
    margin-top: 8px;
    flex: 1;
    align-items: center;
  }
</style>
