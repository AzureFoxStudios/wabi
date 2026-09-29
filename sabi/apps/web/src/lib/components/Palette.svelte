<script lang="ts">
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { app, T, can } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';

  let q = $state('');
  let results = $state<any[]>([]);
  let sel = $state(0);
  let input: HTMLInputElement;

  const actions = $derived([
    { title: T('New job', 'สร้างงานใหม่'), href: '/jobs/new', kind: 'action' },
    { title: T('New customer or supplier', 'เพิ่มลูกค้า/ผู้ขาย'), href: '/parties/new', kind: 'action' },
    { title: T('New quotation (no job)', 'ใบเสนอราคาใหม่ (ไม่ผูกงาน)'), href: '/documents/new?type=quotation', kind: 'action' },
    { title: T('New purchase order', 'ใบสั่งซื้อใหม่'), href: '/documents/new?type=purchase_order', kind: 'action' },
    ...(can('money.write') ? [{ title: T('Record a payment', 'บันทึกรับ/จ่ายเงิน'), href: '/money?pay=in', kind: 'action' }] : []),
    { title: T('Today', 'วันนี้'), href: '/', kind: 'go' },
    { title: T('Jobs', 'งาน'), href: '/jobs', kind: 'go' },
    { title: T('Documents', 'เอกสาร'), href: '/documents', kind: 'go' },
    { title: T('Items & stock', 'สินค้าและสต็อก'), href: '/items', kind: 'go' },
    { title: T('Money', 'การเงิน'), href: '/money', kind: 'go' },
    { title: T('VAT report', 'รายงานภาษีขาย/ซื้อ'), href: '/reports', kind: 'go' },
    { title: T('Settings', 'ตั้งค่า'), href: '/settings', kind: 'go' },
  ]);

  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const text = q;
    clearTimeout(timer);
    if (!text.trim()) {
      results = [];
      return;
    }
    timer = setTimeout(async () => {
      const r = await get('search', { q: text });
      if (text === q) {
        results = r;
        sel = 0;
      }
    }, 120);
  });

  const hrefOf = (r: any) => (r.href ? r.href : `/${r.type === 'party' ? 'parties' : r.type === 'item' ? 'items' : r.type + 's'}/${r.id}`);
  const list = $derived([
    ...results,
    ...actions.filter((a) => !q.trim() || a.title.toLowerCase().includes(q.trim().toLowerCase())),
  ]);
  const typeLabel: Record<string, [string, string]> = { job: ['Job', 'งาน'], document: ['Document', 'เอกสาร'], party: ['Contact', 'ผู้ติดต่อ'], item: ['Item', 'สินค้า'], action: ['Create', 'สร้าง'], go: ['Go to', 'ไปที่'] };

  function open(r: any) {
    app.paletteOpen = false;
    goto(hrefOf(r));
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(list.length - 1, sel + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(0, sel - 1)));
    else if (e.key === 'Enter' && list[sel]) (e.preventDefault(), open(list[sel]));
    else if (e.key === 'Escape') app.paletteOpen = false;
  }
  $effect(() => input?.focus());
</script>

<div class="scrim" role="presentation" onclick={() => (app.paletteOpen = false)}></div>
<div class="palette panel" role="dialog" aria-label="Search">
  <input bind:this={input} bind:value={q} onkeydown={onKey} placeholder={T('Search jobs, documents, customers, items… or type a command', 'ค้นหางาน เอกสาร ลูกค้า สินค้า หรือพิมพ์คำสั่ง')} aria-label="Search" />
  <ul role="listbox">
    {#each list as r, i (r.href ?? r.type + r.id)}
      <li role="option" aria-selected={i === sel}>
        <button class:sel={i === sel} onmouseenter={() => (sel = i)} onclick={() => open(r)}>
          <span class="kind tiny">{T(...(typeLabel[r.kind ?? r.type] ?? ['', '']))}</span>
          <span class="grow ellipsis">{r.title}{#if r.label}<span class="muted"> · {L(r.label)}</span>{/if}</span>
          {#if r.subtitle}<span class="muted small ellipsis sub">{r.subtitle}</span>{/if}
        </button>
      </li>
    {:else}
      <li class="empty muted small">{T('Nothing found.', 'ไม่พบข้อมูล')}</li>
    {/each}
  </ul>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(28, 34, 32, 0.25); z-index: 50; }
  .palette { position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: min(640px, 94vw); z-index: 51; box-shadow: var(--shadow-pop); overflow: hidden; }
  input { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; font-size: 1.02rem; padding: 14px 16px; min-height: 52px; }
  input:focus { box-shadow: none; }
  ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow: auto; }
  button { display: flex; align-items: center; gap: 12px; width: 100%; background: none; border: 0; font: inherit; text-align: left; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
  button.sel { background: var(--accent-soft); }
  .kind { width: 64px; color: var(--muted); flex: none; }
  .sub { max-width: 40%; }
  .empty { padding: 12px; }
</style>
