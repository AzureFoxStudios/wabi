<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { T } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { money } from '$lib/format.ts';

  let role = $state(page.url.searchParams.get('role') ?? 'customer');
  let search = $state('');
  const r = resource(() => get('parties', { role, search }));
  const list = $derived(((r.data as any[]) ?? []).filter((p) => !p.parentId || search));
</script>

<svelte:head><title>{T('Customers & suppliers', 'ลูกค้าและผู้ขาย')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div><h1>{T('Customers & suppliers', 'ลูกค้าและผู้ขาย')}</h1>
    <p class="hint">{T('Everyone you sell to (customers) and buy from (suppliers). Open a name to see their jobs, documents and what they owe.', 'ทุกคนที่เราขายให้ (ลูกค้า) และซื้อของจาก (ผู้ขาย) กดที่ชื่อเพื่อดูงาน เอกสาร และยอดค้าง')}</p></div>
    <a class="btn primary" href={`/parties/new?role=${role || 'customer'}`}>+ {role === 'supplier' ? T('Add a supplier', 'เพิ่มผู้ขาย') : T('Add a customer', 'เพิ่มลูกค้า')}</a>
  </header>
  <div class="filters">
    <div class="seg" role="group">
      <button class:on={role === 'customer'} onclick={() => (role = 'customer')}>{T('Customers', 'ลูกค้า')}</button>
      <button class:on={role === 'supplier'} onclick={() => (role = 'supplier')}>{T('Suppliers', 'ผู้ขาย')}</button>
      <button class:on={role === ''} onclick={() => (role = '')}>{T('Everyone', 'ทั้งหมด')}</button>
    </div>
    <input class="grow" type="search" bind:value={search} placeholder={T('Name, phone or tax ID…', 'ชื่อ เบอร์โทร หรือเลขภาษี…')} />
  </div>
  <table class="data">
    <thead><tr><th>{T('Name', 'ชื่อ')}</th><th>{T('Phone', 'เบอร์โทร')}</th><th>{T('Tax ID', 'เลขประจำตัวผู้เสียภาษี')}</th><th class="num">{T('Jobs in progress', 'งานที่กำลังทำ')}</th><th class="num">{T('They owe us', 'เขาค้างจ่ายเรา')}</th><th class="num">{T('We owe them', 'เราค้างจ่ายเขา')}</th></tr></thead>
    <tbody>
      {#each list as p (p.id)}
        <tr class="clickable" tabindex="0" data-nav onclick={() => goto(`/parties/${p.id}`)} onkeydown={(e) => e.key === 'Enter' && goto(`/parties/${p.id}`)}>
          <td><strong class="w500">{p.name}</strong>{#if p.kind === 'person'} <span class="tiny muted">{T('person, not a company', 'บุคคลธรรมดา')}</span>{/if}</td>
          <td class="small">{p.phone ?? ''}</td>
          <td class="small mono">{p.taxId ?? ''}</td>
          <td class="num">{p.openJobs || ''}</td>
          <td class="num">{#if p.balance.receivable}<span class:text-danger={p.balance.overdue > 0}>{money(p.balance.receivable)}</span>{/if}</td>
          <td class="num">{p.balance.payable ? money(p.balance.payable) : ''}</td>
        </tr>
      {:else}
        <tr><td colspan="6" class="muted">{r.loading ? T('Loading…', 'กำลังโหลด…') : T('Nobody here yet. Press “Add” at the top right.', 'ยังไม่มีรายชื่อ กด “เพิ่ม” ที่มุมขวาบน')}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .filters { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .seg button { font: inherit; font-size: 0.88rem; border: 0; background: var(--surface); padding: 6px 12px; cursor: pointer; color: var(--muted); }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
</style>
