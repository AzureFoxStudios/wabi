<script lang="ts">
  import Tag from '../dashboard/shared/Tag.svelte'

  let { sheetId, title = 'Spreadsheet' }: { sheetId: string; title?: string } = $props()

  let columns = $state<{ key: string; label: string; type: string; align: string; editable: boolean }[]>([])
  let rows = $state<Record<string, unknown>[]>([])
  let totalCount = $state(0)
  let offset = $state(0)
  let pageSize = $state(50)
  let sortField = $state('')
  let sortOrder = $state<'asc' | 'desc'>('asc')
  let search = $state('')
  let loading = $state(false)

  $effect(() => { if (sheetId) fetchData() })

  async function fetchData() {
    if (!sheetId) return
    loading = true
    try {
      const res = await fetch(`/api/plugins/runtime/verified-operations-odoo/sheets/${sheetId}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, limit: pageSize, sortField, sortOrder, search: search || undefined }),
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

  function toggleSort(field: string) {
    if (sortField === field) {
      sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'
    } else {
      sortField = field
      sortOrder = 'asc'
    }
    offset = 0
    fetchData()
  }

  function prevPage() { offset = Math.max(0, offset - pageSize); fetchData() }
  function nextPage() { offset += pageSize; fetchData() }
</script>

<div class="sheet">
  <div class="toolbar">
    <input class="search" type="text" placeholder="SEARCH..." bind:value={search}
      onkeydown={(e) => e.key === 'Enter' && (offset=0, fetchData())} />
    <div class="mono-sub dim">{totalCount} records · page {Math.floor(offset / pageSize) + 1}</div>
    <div class="pagination">
      <button class="page-btn" disabled={offset === 0} onclick={prevPage}>◀</button>
      <button class="page-btn" disabled={offset + pageSize >= totalCount} onclick={nextPage}>▶</button>
    </div>
  </div>

  <div class="table">
    <div class="header">
      {#each columns as col}
        <div class="cell mono-sub" style:text-align={col.align} style:cursor="pointer"
          onclick={() => toggleSort(col.key)}>
          {col.label}
          {#if sortField === col.key}
            <span class="dim">{sortOrder === 'asc' ? '▲' : '▼'}</span>
          {/if}
        </div>
      {/each}
    </div>
    <div class="body">
      {#each rows as row}
        <div class="row">
          {#each columns as col}
            <div class="cell" style:text-align={col.align}
              class:editable={col.editable}
              title={col.editable ? 'Click to edit' : undefined}>
              {#if col.type === 'currency'}
                {Number(row[col.key]).toLocaleString()}
              {:else if col.type === 'boolean'}
                {row[col.key] ? '✓' : '○'}
              {:else if col.type === 'many2one'}
                {row[col.key] ?? '-'}
              {:else}
                {row[col.key] ?? '-'}
              {/if}
            </div>
          {/each}
        </div>
      {/each}
      {#if rows.length === 0 && !loading}
        <div class="mono-sub dim" style="padding:24px; text-align:center">NO DATA</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .sheet { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .search {
    all: unset;
    font: 400 12px/1 'Space Mono', monospace;
    letter-spacing: 0.04em;
    color: #e8e8e8;
    border: 1px solid #222;
    border-radius: 6px;
    padding: 8px 12px;
    flex: 1;
    max-width: 200px;
  }
  .search:focus { border-color: #f26522; }
  .pagination { display: flex; gap: 4px; }
  .page-btn {
    all: unset;
    font: 400 12px/1 'Space Mono', monospace;
    color: #e8e8e8;
    padding: 6px 10px;
    border: 1px solid #222;
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .page-btn:hover:not(:disabled) { border-color: #f26522; }
  .page-btn:disabled { opacity: 0.3; cursor: default; }
  .table { display: flex; flex-direction: column; flex: 1; overflow: auto; }
  .header {
    display: flex;
    border-bottom: 1px solid #222;
    padding-bottom: 8px;
    position: sticky;
    top: 0;
    background: #111;
  }
  .row {
    display: flex;
    border-bottom: 1px solid #1a1a1a;
    padding: 6px 0;
    transition: background 0.15s;
  }
  .row:hover { background: #1a1a1a; }
  .cell {
    flex: 1;
    font: 400 12px/1.6 'Space Mono', monospace;
    color: #e8e8e8;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell.editable { border-bottom: 1px dashed #333; cursor: pointer; }
  .cell.editable:hover { border-bottom-color: #f26522; }
</style>
