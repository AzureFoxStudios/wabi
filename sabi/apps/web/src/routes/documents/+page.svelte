<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { app, T, docTypeDef } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date, dueText } from '$lib/format.ts';
  import StatePill from '$components/StatePill.svelte';

  let type = $state(page.url.searchParams.get('type') ?? '');
  let phase = $state(page.url.searchParams.get('phase') ?? '');
  const partyId = page.url.searchParams.get('partyId') ?? '';
  let search = $state('');
  let open = $state(false);
  const r = resource(() => get('documents', { type, phase, search, open: open ? '1' : '', partyId }));
  const docs = $derived((r.data as any[]) ?? []);
  const types = $derived(app.boot.pack.documentTypes);
  const sum = $derived(docs.filter((d) => d.phase !== 'void').reduce((a, d) => a + d.total, 0));
</script>

<svelte:head><title>{T('Documents', 'เอกสาร')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <h1>{T('Documents', 'เอกสาร')}</h1>
      <p class="muted small">{T('Quotations, orders, tax invoices, purchase orders and bills. Most are created from inside a job.', 'ใบเสนอราคา ใบสั่งขาย ใบกำกับภาษี ใบสั่งซื้อ ส่วนใหญ่สร้างจากในงาน')}</p>
    </div>
    <div class="row">
      <a class="btn" href="/documents/new?type=purchase_order">+ {T('Purchase order', 'ใบสั่งซื้อ')}</a>
      <a class="btn primary" href="/documents/new?type=quotation">+ {T('Quotation', 'ใบเสนอราคา')}</a>
    </div>
  </header>

  <div class="types">
    <button class:on={!type} onclick={() => (type = '')}>{T('All', 'ทั้งหมด')}</button>
    {#each types as t (t.id)}<button class:on={type === t.id} onclick={() => (type = t.id)}>{L(t.label)}</button>{/each}
  </div>
  <div class="filters">
    <select bind:value={phase} aria-label={T('Status', 'สถานะ')}>
      <option value="">{T('Any status', 'ทุกสถานะ')}</option>
      <option value="draft">{T('Draft', 'ร่าง')}</option>
      <option value="issued">{T('Issued / open', 'ออกแล้ว/ค้าง')}</option>
      <option value="closed">{T('Closed', 'ปิดแล้ว')}</option>
      <option value="void">{T('Void', 'ยกเลิก')}</option>
    </select>
    <label class="row small"><input type="checkbox" bind:checked={open} /> {T('Unpaid only', 'เฉพาะที่ยังไม่ชำระ')}</label>
    <input class="grow" type="search" bind:value={search} placeholder={T('Number or party…', 'เลขที่หรือชื่อ…')} />
    <span class="small muted num">{docs.length} · ฿{money(sum)}</span>
  </div>

  <table class="data">
    <thead><tr><th>{T('Type', 'ประเภท')}</th><th>{T('Number', 'เลขที่')}</th><th>{T('Date', 'วันที่')}</th><th>{T('Party', 'คู่ค้า')}</th><th>{T('Status', 'สถานะ')}</th><th class="num">{T('Total', 'ยอดรวม')}</th><th class="num">{T('Balance', 'คงค้าง')}</th></tr></thead>
    <tbody>
      {#each docs as d (d.id)}
        {@const due = dueText(d.dueDate)}
        <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)} tabindex="0" data-nav onkeydown={(e) => e.key === 'Enter' && goto(`/documents/${d.id}`)}>
          <td>{L(docTypeDef(d.type)?.label)}</td>
          <td class="mono small">{d.number ?? T('draft', 'ร่าง')}</td>
          <td class="small nowrap">{date(d.date)}</td>
          <td>{d.partyName}</td>
          <td><StatePill label={d.stateLabel} tone={d.tone} /></td>
          <td class="num">{money(d.total)}</td>
          <td class="num small">{#if d.balance !== null && d.balance > 0}<span class:text-danger={d.overdue}>{money(d.balance)}</span>{#if d.overdue}<br /><span class="tiny text-danger">{due.text}</span>{/if}{:else if d.balance === 0}<span class="text-success">✓</span>{/if}</td>
        </tr>
      {:else}
        <tr><td colspan="7" class="muted">{r.loading ? T('Loading…', 'กำลังโหลด…') : T('No documents.', 'ไม่มีเอกสาร')}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .types { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 12px; overflow-x: auto; }
  .types button { font: inherit; font-size: 0.9rem; background: none; border: 0; padding: 8px 12px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
  .types button.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 500; }
  .filters { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .filters select { width: auto; }
</style>
