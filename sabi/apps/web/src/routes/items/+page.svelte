<script lang="ts">
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { T } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { money, qty, unit } from '$lib/format.ts';

  let kind = $state('');
  let search = $state('');
  let lowOnly = $state(false);
  const r = resource(() => get('items', { kind, search }));
  // Short = promised more than we have; low = below the reorder point set on the item.
  const low = (i: any) => i.stock && i.reorderPoint != null && i.stock.available >= 0 && i.stock.available < i.reorderPoint;
  const list = $derived(((r.data as any[]) ?? []).filter((i) => !lowOnly || (i.stock && (i.stock.available < 0 || low(i)))));
</script>

<svelte:head><title>{T('Products & stock', 'สินค้าและของในคลัง')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div><h1>{T('Products & stock', 'สินค้าและของในคลัง')}</h1>
    <p class="hint">{T('Everything you sell or buy, and how much is in the warehouse. “Free to use” = in stock minus what is already promised to jobs.', 'ทุกอย่างที่เราขายหรือซื้อ และมีในคลังเท่าไร “ว่างให้ใช้” = ของในคลัง ลบ ส่วนที่จองให้งานไว้แล้ว')}</p></div>
    <a class="btn primary" href="/items/new">+ {T('Add a product or service', 'เพิ่มสินค้าหรือบริการ')}</a>
  </header>
  <div class="filters">
    <select bind:value={kind} aria-label={T('Kind', 'ประเภท')}>
      <option value="">{T('Everything', 'ทั้งหมด')}</option><option value="stock">{T('Kept in stock (counted)', 'มีเก็บในคลัง (นับจำนวน)')}</option><option value="non_stock">{T('Not counted', 'ไม่นับจำนวน')}</option><option value="service">{T('Services (labour etc.)', 'บริการ (ค่าแรง ฯลฯ)')}</option>
    </select>
    <label class="row small"><input type="checkbox" bind:checked={lowOnly} /> {T('Only ones running low', 'เฉพาะที่ใกล้หมดหรือไม่พอ')}</label>
    <input class="grow" type="search" bind:value={search} placeholder={T('Search by name or code…', 'ค้นหาชื่อหรือรหัส…')} />
  </div>
  <table class="data">
    <thead><tr><th>{T('Product', 'สินค้า')}</th><th class="num">{T('Selling price', 'ราคาขาย')}</th><th class="num">{T('In stock', 'มีในคลัง')}</th><th class="num">{T('Promised to jobs', 'จองให้งานแล้ว')}</th><th class="num">{T('Ordered, on the way', 'สั่งแล้ว กำลังมา')}</th><th class="num">{T('Free to use', 'ว่างให้ใช้')}</th></tr></thead>
    <tbody>
      {#each list as i (i.id)}
        <tr class="clickable" class:inactive={!i.active} tabindex="0" data-nav onclick={() => goto(`/items/${i.id}`)} onkeydown={(e) => e.key === 'Enter' && goto(`/items/${i.id}`)}>
          <td>{i.name}<br /><span class="ref">{i.sku}</span></td>
          <td class="num">{money(i.salePrice)}<span class="tiny muted">/{unit(i.uom)}</span></td>
          {#if i.stock}
            <td class="num">{qty(i.stock.onHand)}</td>
            <td class="num muted">{i.stock.reserved ? qty(i.stock.reserved) : ''}</td>
            <td class="num muted">{i.stock.incoming ? qty(i.stock.incoming) : ''}</td>
            <td class="num" class:text-danger={i.stock.available < 0} class:text-warning={low(i)}><strong class="w500">{i.stock.available < 0 ? T(`${qty(-i.stock.available)} short`, `ขาด ${qty(-i.stock.available)}`) : qty(i.stock.available)}</strong>{#if low(i)}<div class="tiny">{T('running low — keep at least', 'ใกล้หมด — ควรมีอย่างน้อย')} {qty(i.reorderPoint)}</div>{:else if i.stock.available < 0}<div class="tiny">{T('not enough for the jobs', 'ไม่พอสำหรับงาน')}</div>{/if}</td>
          {:else}
            <td colspan="4" class="small faint">{i.kind === 'service' ? T('service — no stock to count', 'บริการ — ไม่มีจำนวนในคลัง') : T('not counted in stock', 'ไม่นับจำนวนในคลัง')}</td>
          {/if}
        </tr>
      {:else}
        <tr><td colspan="6" class="muted">{r.loading ? T('Loading…', 'กำลังโหลด…') : T('Nothing found.', 'ไม่พบรายการ')}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .filters { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
  .filters select { width: auto; }
  .inactive { opacity: 0.55; }
</style>
