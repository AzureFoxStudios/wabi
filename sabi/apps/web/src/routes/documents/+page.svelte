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
      <h1>{T('Quotes, orders & invoices', 'ใบเสนอราคา ใบสั่ง ใบแจ้งหนี้')}</h1>
      <p class="hint">{T('All the paperwork for buying and selling in one list. Tip: it is easier to make documents from inside a job — the customer and items are filled in for you.', 'เอกสารซื้อขายทั้งหมดในรายการเดียว เคล็ดลับ: ทำเอกสารจากในหน้างานจะง่ายกว่า เพราะระบบใส่ชื่อลูกค้าและรายการให้')}</p>
    </div>
    <div class="row">
      <a class="btn" href="/documents/new?type=purchase_order">+ {T('Order from a supplier', 'สั่งของจากผู้ขาย')}</a>
      <a class="btn primary" href="/documents/new?type=quotation">+ {T('New quotation', 'ทำใบเสนอราคา')}</a>
    </div>
  </header>

  <div class="types">
    <button class:on={!type} onclick={() => (type = '')}>{T('All', 'ทั้งหมด')}</button>
    {#each types as t (t.id)}<button class:on={type === t.id} onclick={() => (type = t.id)}>{L(t.label)}</button>{/each}
  </div>
  <div class="filters">
    <select bind:value={phase} aria-label={T('Status', 'สถานะ')}>
      <option value="">{T('Any stage', 'ทุกขั้นตอน')}</option>
      <option value="draft">{T('Drafts (not sent yet)', 'ร่าง (ยังไม่ได้ออก)')}</option>
      <option value="issued">{T('Issued, still open', 'ออกแล้ว ยังไม่จบ')}</option>
      <option value="closed">{T('Finished', 'จบแล้ว')}</option>
      <option value="void">{T('Cancelled', 'ยกเลิกแล้ว')}</option>
    </select>
    <label class="row small"><input type="checkbox" bind:checked={open} /> {T('Only ones not paid yet', 'เฉพาะที่ยังไม่ได้จ่าย')}</label>
    <input class="grow" type="search" bind:value={search} placeholder={T('Search by customer, supplier or number…', 'ค้นหาชื่อลูกค้า ผู้ขาย หรือเลขที่…')} />
    <span class="small muted num">{docs.length} · ฿{money(sum)}</span>
  </div>

  <table class="data">
    <thead><tr><th>{T('Document', 'เอกสาร')}</th><th>{T('Customer / supplier', 'ลูกค้า / ผู้ขาย')}</th><th>{T('Date', 'วันที่')}</th><th>{T('Stage', 'ขั้นตอน')}</th><th class="num">{T('Total', 'ยอดรวม')}</th><th class="num">{T('Still owed', 'ยังค้าง')}</th></tr></thead>
    <tbody>
      {#each docs as d (d.id)}
        {@const due = dueText(d.dueDate)}
        <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)} tabindex="0" data-nav onkeydown={(e) => e.key === 'Enter' && goto(`/documents/${d.id}`)}>
          <td><strong class="w5">{L(docTypeDef(d.type)?.label)}</strong><br />{#if d.number}<span class="ref">{d.number}</span>{:else}<span class="tiny muted">{T('draft — no number yet', 'ร่าง — ยังไม่มีเลขที่')}</span>{/if}</td>
          <td>{d.partyName}</td>
          <td class="small nowrap">{date(d.date)}</td>
          <td><StatePill label={d.stateLabel} tone={d.tone} /></td>
          <td class="num">{money(d.total)}</td>
          <td class="num small">{#if d.balance !== null && d.balance > 0}<span class:text-danger={d.overdue}>{money(d.balance)}</span>{#if d.overdue}<br /><span class="tiny text-danger">{due.text}</span>{/if}{:else if d.balance === 0}<span class="text-success">{T('paid', 'จ่ายครบ')}</span>{/if}</td>
        </tr>
      {:else}
        <tr><td colspan="6" class="muted">{r.loading ? T('Loading…', 'กำลังโหลด…') : T('No documents match. Try “All” or clear the search.', 'ไม่พบเอกสาร ลองกด “ทั้งหมด” หรือลบคำค้นหา')}</td></tr>
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
