<script lang="ts">
  import { unit } from '$lib/format.ts';
  /** Search-as-you-type combobox for parties / items. */
  import { get } from '$lib/api.ts';
  import { T } from '$lib/state.svelte.ts';

  let {
    kind, value = $bindable(''), label = '', placeholder = '', role = '', onpick = (_: any) => {}, autofocus = false, display = '',
  }: { kind: 'parties' | 'items'; value?: string; label?: string; placeholder?: string; role?: string; onpick?: (r: any) => void; autofocus?: boolean; display?: string } = $props();

  let q = $state('');
  let open = $state(false);
  let list = $state<any[]>([]);
  let sel = $state(0);
  let text = $state('');
  $effect(() => {
    text = display;
  });

  let timer: ReturnType<typeof setTimeout>;
  function search() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      list = (await get(kind, { search: q, role: role || undefined })).slice(0, 12);
      sel = 0;
    }, 100);
  }
  function choose(r: any) {
    value = r.id;
    text = kind === 'items' ? `${r.sku} · ${r.name}` : r.name;
    open = false;
    onpick(r);
  }
  function onKey(e: KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      open = true;
      search();
      return;
    }
    if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(list.length - 1, sel + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(0, sel - 1)));
    else if (e.key === 'Enter' && list[sel]) (e.preventDefault(), choose(list[sel]));
    else if (e.key === 'Escape') (e.stopPropagation(), (open = false));
  }
</script>

<div class="picker field">
  {#if label}<span>{label}</span>{/if}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    value={text} {autofocus} placeholder={placeholder || T('Type to search…', 'พิมพ์เพื่อค้นหา…')} role="combobox" aria-expanded={open} aria-controls="picker-list"
    oninput={(e) => ((q = (e.target as HTMLInputElement).value), (text = q), (open = true), search())}
    onfocus={() => ((open = true), (q = ''), search())}
    onblur={() => setTimeout(() => (open = false), 150)}
    onkeydown={onKey}
  />
  {#if open && list.length}
    <ul class="panel" id="picker-list" role="listbox">
      {#each list as r, i (r.id)}
        <li role="option" aria-selected={i === sel}>
          <button type="button" class:sel={i === sel} onmousedown={(e) => (e.preventDefault(), choose(r))}>
            {#if kind === 'items'}
              <span class="mono">{r.sku}</span> <span class="grow ellipsis">{r.name}</span>
              {#if r.stock}<span class="tiny muted">{r.stock.available} {unit(r.uom)}</span>{/if}
            {:else}
              <span class="grow ellipsis">{r.name}</span><span class="tiny muted">{r.roles?.join(', ')}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .picker { position: relative; }
  ul { position: absolute; top: 100%; left: 0; right: 0; margin: 4px 0 0; padding: 4px; list-style: none; z-index: 30; box-shadow: var(--shadow-pop); max-height: 300px; overflow: auto; min-width: 280px; }
  button { display: flex; gap: 8px; align-items: center; width: 100%; background: none; border: 0; padding: 6px 8px; border-radius: 5px; font: inherit; text-align: left; cursor: pointer; font-size: 0.9rem; }
  button.sel { background: var(--accent-soft); }
</style>
