<script lang="ts">
  import { goto } from '$app/navigation';
  import { app, T, can } from '$lib/state.svelte.ts';

  const items = $derived([
    { key: 'j', label: T('Job', 'งานของลูกค้า'), hint: T('A customer called or asked for a price', 'ลูกค้าโทรมาหรือขอราคา'), href: '/jobs/new' },
    { key: 'p', label: T('Customer or supplier', 'ลูกค้า/ผู้ขาย'), hint: T('Person or company', 'บุคคลหรือบริษัท'), href: '/parties/new' },
    { key: 'q', label: T('Quotation', 'ใบเสนอราคา'), hint: T('Just a price, no job yet', 'แค่บอกราคา ยังไม่เปิดงาน'), href: '/documents/new?type=quotation' },
    { key: 'o', label: T('Order from a supplier', 'สั่งของจากผู้ขาย'), hint: T('Purchase order', 'ใบสั่งซื้อ'), href: '/documents/new?type=purchase_order' },
    ...(can('items.write') ? [{ key: 'i', label: T('Product or service', 'สินค้าหรือบริการ'), hint: T('Something you sell or buy', 'สิ่งที่เราขายหรือซื้อ'), href: '/items/new' }] : []),
    ...(can('money.write') ? [{ key: 'm', label: T('Money in or out', 'รับเงิน/จ่ายเงิน'), hint: T('A customer paid, or we paid someone', 'ลูกค้าจ่ายเงิน หรือเราจ่ายเงิน'), href: '/money?pay=in' }] : []),
  ]);
  function go(href: string) {
    app.createOpen = false;
    goto(href);
  }
  function onKey(e: KeyboardEvent) {
    const it = items.find((i) => i.key === e.key);
    if (it) {
      e.preventDefault();
      e.stopPropagation();
      go(it.href);
    }
  }
</script>

<svelte:window onkeydown={onKey} />
<div class="scrim" role="presentation" onclick={() => (app.createOpen = false)}></div>
<div class="create panel" role="dialog" aria-label={T('Create', 'สร้าง')}>
  <p class="eyebrow">{T('What do you want to add?', 'ต้องการเพิ่มอะไร?')}</p>
  {#each items as it (it.key)}
    <button onclick={() => go(it.href)}>
      <kbd>{it.key.toUpperCase()}</kbd>
      <span class="grow"><strong>{it.label}</strong><br /><span class="small muted">{it.hint}</span></span>
    </button>
  {/each}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(28, 34, 32, 0.18); z-index: 50; }
  .create { position: fixed; top: 14vh; left: 50%; transform: translateX(-50%); width: min(420px, 92vw); padding: 14px; z-index: 51; box-shadow: var(--shadow-pop); }
  .eyebrow { padding: 2px 8px 8px; }
  button { display: flex; gap: 14px; align-items: center; width: 100%; text-align: left; font: inherit; background: none; border: 0; padding: 9px 8px; border-radius: 6px; cursor: pointer; line-height: 1.35; }
  button:hover, button:focus-visible { background: var(--accent-soft); }
  strong { font-weight: 500; }
</style>
