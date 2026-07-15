<script lang="ts">
  let approvals = $state<{ id: string; amount: number; requesterName: string; status: string; createdAt: number }[]>([])
  let loading = $state(true)

  $effect(() => {
    fetchApprovals()
    const interval = setInterval(fetchApprovals, 15000)
    return () => clearInterval(interval)
  })

  async function fetchApprovals() {
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/approvals')
      if (res.ok) {
        const data = await res.json()
        approvals = data.filter((a: { status: string }) => a.status === 'pending').slice(0, 5)
      }
    } catch {}
    loading = false
  }
</script>

{#if loading}
  <div class="mono-sub dim" style="margin-top:14px">LOADING...</div>
{:else if approvals.length === 0}
  <div class="mono-sub dim" style="margin-top:14px">NO PENDING APPROVALS</div>
  <div class="mono-sub dim" style="margin-top:4px">All requests processed</div>
{:else}
  <div class="queue">
    {#each approvals as apr}
      <div class="row">
        <div>
          <div class="mono-sub" style="color:#e8e8e8">{apr.requesterName}</div>
          <div class="mono-sub dim">{apr.amount.toLocaleString()} THB</div>
        </div>
        <span class="badge">PENDING</span>
      </div>
    {/each}
  </div>
  <div class="mono-sub dim" style="margin-top:auto; text-align:right">
    {approvals.length} awaiting review
  </div>
{/if}

<style>
  .queue {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
    flex: 1;
    overflow: hidden;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
  }
  .badge {
    font: 400 9px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    color: #f26522;
    border: 1px solid #f26522;
    border-radius: 4px;
    padding: 3px 6px;
    flex: none;
  }
</style>
