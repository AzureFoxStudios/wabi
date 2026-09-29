<script lang="ts">
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { T } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { money, qty } from '$lib/format.ts';

  let kind = $state('');
  let search = $state('');
  let lowOnly = $state(false);
  const r = resource(() => get('items', { kind, search }));
  const list = $derived(((r.data as any[]) ?? []).filter((i) => !lowOnly || (i.stock && i.stock.available < 0)));
</script>

<svelte:head><title>{T('Products & stock', 'สินค้าและสต็อก')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <h1>{T('Products & stock', 'สินค้าและสต็อก')}</h1>
    <a class="btn primary" href="/items/new">+ {T('Product or service', 'สินค้าหรือบริการ')}</a>
  </header>
  <div class="filters">
    <select bind:value={kind} aria-label={T('Kind', 'ประเภท')}>
      <option value="">{T('Everything', 'ทั้งหมด')}</option><option value="stock">{T('Stocked', 'นับสต็อก')}</option><option value="non_stock">{T('Not stocked', 'ไม่นับสต็อก')}</option><option value="service">{T('Services', 'บริการ')}</option>
    </select>
    <label class="row small"><input type="checkbox" bind:checked={lowOnly} /> {T('Short only', 'เฉพาะที่ขาด')}</label>
    <input class="grow" type="search" bind:value={search} placeholder={T('Code or name…', 'รหัสหรือชื่อ…')} />
  </div>
  <table class="data">
    <thead><tr><th>{T('Code', 'รหัส')}</th><th>{T('Name', 'ชื่อ')}</th><th class="num">{T('Price', 'ราคา')}</th><th class="num">{T('On hand', 'คงเหลือ')}</th><th class="num">{T('Reserved', 'จองแล้ว')}</th><th class="num">{T('Incoming', 'กำลังเข้า')}</th><th class="num">{T('Available', 'ใช้ได้')}</th></tr></thead>
    <tbody>
      {#each list as i (i.id)}
        <tr class="clickable" class:inactive={!i.active} tabindex="0" data-nav onclick={() => goto(`/items/${i.id}`)} onkeydown={(e) => e.key === 'Enter' && goto(`/items/${i.id}`)}>
          <td class="mono small">{i.sku}</td>
          <td>{i.name}</td>
          <td class="num">{money(i.salePrice)}<span class="tiny muted">/{i.uom}</span></td>
          {#if i.stock}
            <td class="num">{qty(i.stock.onHand)}</td>
            <td class="num muted">{i.stock.reserved ? qty(i.stock.reserved) : ''}</td>
            <td class="num muted">{i.stock.incoming ? qty(i.stock.incoming) : ''}</td>
            <td class="num" class:text-danger={i.stock.available < 0}><strong class="w500">{qty(i.stock.available)}</strong></td>
          {:else}
            <td colspan="4" class="small faint">{i.kind === 'service' ? T('service', 'บริการ') : T('not stocked', 'ไม่นับสต็อก')}</td>
          {/if}
        </tr>
      {:else}
        <tr><td colspan="7" class="muted">{r.loading ? T('Loading…', 'กำลังโหลด…') : T('Nothing found.', 'ไม่พบรายการ')}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .filters { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
  .filters select { width: auto; }
  .inactive { opacity: 0.55; }
</style>
