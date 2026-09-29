<script lang="ts">
  import { goto } from '$app/navigation';
  import { app, T, can } from '$lib/state.svelte.ts';

  const items = $derived([
    { key: 'j', label: T('Job', 'งาน'), hint: T('A customer request you will work on', 'งานจากลูกค้าที่ต้องดำเนินการ'), href: '/jobs/new' },
    { key: 'p', label: T('Customer or supplier', 'ลูกค้า/ผู้ขาย'), hint: T('Person or company', 'บุคคลหรือบริษัท'), href: '/parties/new' },
    { key: 'q', label: T('Quotation', 'ใบเสนอราคา'), hint: T('Quick quote without a job', 'เสนอราคาด่วนโดยไม่เปิดงาน'), href: '/documents/new?type=quotation' },
    { key: 'o', label: T('Purchase order', 'ใบสั่งซื้อ'), hint: T('Order from a supplier', 'สั่งซื้อจากผู้ขาย'), href: '/documents/new?type=purchase_order' },
    ...(can('items.write') ? [{ key: 'i', label: T('Item', 'สินค้า'), hint: T('Product or service you sell or buy', 'สินค้าหรือบริการ'), href: '/items/new' }] : []),
    ...(can('money.write') ? [{ key: 'm', label: T('Payment', 'รับ/จ่ายเงิน'), hint: T('Money received or paid', 'บันทึกการรับหรือจ่ายเงิน'), href: '/money?pay=in' }] : []),
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
  <p class="eyebrow">{T('Create', 'สร้างใหม่')}</p>
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
