<script lang="ts">
  import Tag from '../dashboard/shared/Tag.svelte'

  interface SpreadsheetDef {
    id: string
    name: string
    odooModel: string
    fields: { odooField: string; label: string; type: string; editable: boolean; minRole: string }[]
    minRole: string
    pageSize: number
  }

  let sheets = $state<SpreadsheetDef[]>([])
  let models = $state<string[]>([])
  let selectedModel = $state('')
  let sheetName = $state('')
  let editing = $state(false)

  $effect(() => { loadSheets(); loadModels() })

  async function loadSheets() {
    const res = await fetch('/api/plugins/runtime/verified-operations-odoo/sheets')
    if (res.ok) sheets = await res.json()
  }

  async function loadModels() {
    const res = await fetch('/api/plugins/runtime/verified-operations-odoo/models')
    if (res.ok) { const d = await res.json(); models = d.models }
  }
</script>

<div class="admin">
  <h2 class="mono-sub" style="color:#fff; font-size:14px; margin-bottom:16px">SPREADSHEET VIEWS</h2>

  {#each sheets as sheet}
    <div class="sheet-row">
      <div>
        <div class="mono-sub" style="color:#e8e8e8">{sheet.name}</div>
        <div class="mono-sub dim">{sheet.odooModel} · {sheet.fields.length} fields</div>
      </div>
      <span class="badge">{sheet.minRole}</span>
    </div>
  {/each}

  {#if sheets.length === 0}
    <div class="mono-sub dim" style="margin:20px 0">No views configured yet</div>
  {/if}
</div>

<style>
  .admin { display: flex; flex-direction: column; }
  .sheet-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid #1a1a1a;
  }
  .badge {
    font: 400 9px/1 'Space Mono', monospace;
    letter-spacing: 0.08em;
    color: #999;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 3px 6px;
  }
</style>
