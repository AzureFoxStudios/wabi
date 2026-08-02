<script lang="ts">
  import Tag from '../dashboard/shared/Tag.svelte'

  interface ApprovalItem {
    id: string
    draftId: string
    requesterName: string
    currentRole: string
    amount: number
    currency: string
    status: string
    createdAt: number
  }

  let pending = $state<ApprovalItem[]>([])
  let loading = $state(true)
  let selectedId = $state<string | null>(null)
  let reason = $state('')

  $effect(() => { fetchPending() })

  async function fetchPending() {
    loading = true
    try {
      const res = await fetch('/api/plugins/runtime/verified-operations-odoo/approvals')
      if (res.ok) {
        const all = await res.json()
        pending = all.filter((a: ApprovalItem) => a.status === 'pending')
      }
    } catch {}
    loading = false
  }

  async function review(decision: 'approved' | 'rejected') {
    if (!selectedId) return
    await fetch(`/api/plugins/runtime/verified-operations-odoo/approvals/${selectedId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'current-user',
        role: 'manager',
        decision,
        reason: decision === 'rejected' ? reason : undefined,
      }),
    })
    selectedId = null
    reason = ''
    fetchPending()
  }
</script>

<div class="panel">
  {#if loading}
    <div class="mono-sub dim" style="padding:20px">LOADING...</div>
  {:else if pending.length === 0}
    <div class="mono-sub dim" style="padding:20px">NO PENDING APPROVALS</div>
  {:else}
    <div class="list">
      {#each pending as item}
        <div class="item" class:selected={selectedId === item.id}
          onclick={() => selectedId = item.id}>
          <div class="item-main">
            <div class="mono-sub" style="color:#e8e8e8">{item.requesterName}</div>
            <div class="mono-sub dim">{item.amount.toLocaleString()} {item.currency}</div>
          </div>
          <span class="badge">{item.currentRole}</span>
        </div>
      {/each}
    </div>

    {#if selectedId}
      <div class="review">
        <input class="input" type="text" placeholder="REASON (required for rejection)" bind:value={reason} />
        <div class="review-actions">
          <button class="btn danger" onclick={() => review('rejected')}>REJECT</button>
          <button class="btn approve" onclick={() => review('approved')}>APPROVE</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; }
  .list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    border: 1px solid #222;
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .item:hover, .item.selected { border-color: #f26522; }
  .item.selected { background: #1a1a1a; }
  .badge {
    font: 400 9px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    color: #f26522;
    border: 1px solid #f26522;
    border-radius: 4px;
    padding: 3px 6px;
    flex: none;
  }
  .review { display: flex; flex-direction: column; gap: 10px; }
  .input {
    all: unset;
    font: 400 12px/1 'Space Mono', monospace;
    color: #e8e8e8;
    border: 1px solid #222;
    border-radius: 6px;
    padding: 8px 12px;
  }
  .input:focus { border-color: #f26522; }
  .review-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .btn {
    all: unset;
    font: 400 10px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn.approve { background: #f26522; color: #000; }
  .btn.approve:hover { background: #d95b1f; }
  .btn.danger { border: 1px solid #d71921; color: #d71921; }
  .btn.danger:hover { background: #d7192122; }
</style>
