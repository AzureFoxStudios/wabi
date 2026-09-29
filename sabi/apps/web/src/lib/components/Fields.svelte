<script lang="ts">
  /** Read + inline-edit configured custom fields (from the pack / jurisdiction). */
  import { app, T } from '$lib/state.svelte.ts';
  import { L, date, userName } from '$lib/format.ts';

  let { defs, values, onsave, editable = true }: { defs: any[]; values: Record<string, any>; onsave: (patch: Record<string, any>) => Promise<void>; editable?: boolean } = $props();
  let editing = $state(false);
  let draft = $state<Record<string, any>>({});
  let busy = $state(false);

  function start() {
    draft = { ...values };
    editing = true;
  }
  async function save(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      const patch: Record<string, any> = {};
      for (const f of defs) {
        const v = draft[f.key];
        if (v !== values[f.key]) patch[f.key] = f.type === 'number' && v !== '' && v !== null ? Number(v) : v === undefined ? null : v;
      }
      await onsave(patch);
      editing = false;
    } finally {
      busy = false;
    }
  }
  function show(f: any, v: any) {
    if (v === undefined || v === null || v === '') return '';
    if (f.type === 'select') return L(f.options?.find((o: any) => o.value === v)?.label) || v;
    if (f.type === 'date') return date(v);
    if (f.type === 'boolean') return v ? T('Yes', 'ใช่') : T('No', 'ไม่');
    if (f.type === 'user') return userName(v);
    return `${v}${f.unit ? ' ' + f.unit : ''}`;
  }
</script>

{#if !editing}
  <dl class="facts">
    {#each defs as f (f.key)}
      <dt>{L(f.label)}</dt>
      <dd class:empty={show(f, values[f.key]) === ''}>{show(f, values[f.key]) || '—'}</dd>
    {/each}
  </dl>
  {#if editable && defs.length}<button class="btn ghost sm" onclick={start}>{T('Edit details', 'แก้ไขรายละเอียด')}</button>{/if}
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form class="stack" onsubmit={save} onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && save(e)}>
    {#each defs as f (f.key)}
      <label class="field"><span>{L(f.label)}{f.unit ? ` (${f.unit})` : ''}</span>
        {#if f.type === 'longtext'}<textarea bind:value={draft[f.key]} rows="3"></textarea>
        {:else if f.type === 'select'}
          <select bind:value={draft[f.key]}><option value={null}>—</option>{#each f.options as o (o.value)}<option value={o.value}>{L(o.label)}</option>{/each}</select>
        {:else if f.type === 'boolean'}<input type="checkbox" bind:checked={draft[f.key]} />
        {:else if f.type === 'date'}<input type="date" bind:value={draft[f.key]} />
        {:else if f.type === 'number'}<input type="number" step="any" bind:value={draft[f.key]} />
        {:else if f.type === 'user'}
          <select bind:value={draft[f.key]}><option value={null}>—</option>{#each app.boot.users as u (u.id)}<option value={u.id}>{u.name}</option>{/each}</select>
        {:else}<input bind:value={draft[f.key]} placeholder={L(f.placeholder)} />{/if}
      </label>
    {/each}
    <div class="row">
      <button class="btn primary sm" disabled={busy}>{T('Save', 'บันทึก')}</button>
      <button type="button" class="btn ghost sm" onclick={() => (editing = false)}>{T('Cancel', 'ยกเลิก')}</button>
    </div>
  </form>
{/if}

<style>
  .facts { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 6px 14px; margin: 0 0 8px; font-size: 0.9rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd.empty { color: var(--faint); }
</style>
