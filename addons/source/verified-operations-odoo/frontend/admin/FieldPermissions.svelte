<script lang="ts">
  import Tag from '../dashboard/shared/Tag.svelte'

  let { caps = [] }: {
    caps?: { role: string; maxAmount: number; currency: string; requiresApproval: boolean; escalationRole?: string }[]
  } = $props()
</script>

<div class="admin">
  <h2 class="mono-sub" style="color:#fff; font-size:14px; margin-bottom:16px">SPENDING CAPS</h2>

  <div class="caps">
    {#each caps as cap}
      <div class="cap-row">
        <span class="mono-sub" style="color:#e8e8e8">{cap.role.toUpperCase()}</span>
        <span class="mono-sub dim">{cap.maxAmount.toLocaleString()} {cap.currency}</span>
        {#if cap.escalationRole}
          <span class="mono-sub dim">→ {cap.escalationRole}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .admin { display: flex; flex-direction: column; }
  .caps { display: flex; flex-direction: column; gap: 8px; }
  .cap-row {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid #1a1a1a;
  }
</style>
