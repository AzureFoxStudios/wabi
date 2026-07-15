<script lang="ts">
  import Tag from './shared/Tag.svelte'

  let { sheetId = '', title = 'Data View' }: { sheetId?: string; title?: string } = $props()

  let columns = $state<{ key: string; label: string; align: string; width?: number }[]>([])
  let rows = $state<Record<string, unknown>[]>([])
  let totalCount = $state(0)
  let offset = $state(0)
  let limit = $state(50)
  let loading = $state(false)
  let search = $state('')

  $effect(() => {
    if (sheetId) fetchData()
  })

  async function fetchData() {
    if (!sheetId) return
    loading = true
    try {
      const res = await fetch(`/api/plugins/runtime/verified-operations-odoo/sheets/${sheetId}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, limit, search: search || undefined }),
      })
      if (res.ok) {
        const data = await res.json()
        columns = data.columns
        rows = data.rows
        totalCount = data.totalCount
      }
    } catch {}
    loading = false
  }

  function handleSearch() {
    offset = 0
    fetchData()
  }
</script>

<div class="table-wrap">
  <div class="toolbar">
    <input class="search" type="text" placeholder="SEARCH..." bind:value={search}
      onkeydown={(e) => e.key === 'Enter' && handleSearch()} />
    <span class="mono-sub dim">{totalCount} records</span>
  </div>
  <div class="table">
    {#if columns.length > 0}
      <div class="header">
        {#each columns as col}
          <div class="cell mono-sub" style:text-align={col.align} style:width={col.width ? `${col.width}px` : undefined}>
            {col.label}
          </div>
        {/each}
      </div>
      <div class="body">
        {#each rows as row}
          <div class="row">
            {#each columns as col}
              <div class="cell" style:text-align={col.align}>
                {#if col.type === 'currency'}
                  {Number(row[col.key]).toLocaleString()}
                {:else}
                  {row[col.key] ?? '-'}
                {/if}
              </div>
            {/each}
          </div>
        {/each}
        {#if rows.length === 0 && !loading}
          <div class="mono-sub dim" style="padding:20px; text-align:center">NO DATA</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .table-wrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    gap: 12px;
  }
  .search {
    all: unset;
    font: 400 12px/1 'Space Mono', monospace;
    letter-spacing: 0.04em;
    color: #e8e8e8;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 8px 12px;
    flex: 1;
    max-width: 240px;
  }
  .search:focus {
    border-color: #f26522;
  }
  .table {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
  }
  .header {
    display: flex;
    border-bottom: 1px solid #222;
    padding-bottom: 8px;
    margin-bottom: 4px;
  }
  .row {
    display: flex;
    border-bottom: 1px solid #1a1a1a;
    padding: 6px 0;
  }
  .row:hover {
    background: #1a1a1a;
    border-radius: 4px;
  }
  .cell {
    flex: 1;
    font: 400 12px/1.6 'Space Mono', monospace;
    color: #e8e8e8;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
