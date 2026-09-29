<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { app, T } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, qty, date, unit } from '$lib/format.ts';

  const tabs = [
    { id: 'vat-sales', label: T('Output VAT', 'รายงานภาษีขาย'), hint: T('Sales tax invoices issued in the month — basis for the monthly VAT return (ภ.พ.30).', 'ใบกำกับภาษีขายที่ออกในเดือน ใช้ประกอบการยื่น ภ.พ.30') },
    { id: 'vat-purchases', label: T('Input VAT', 'รายงานภาษีซื้อ'), hint: T('Supplier tax invoices recorded as bills in the month. Numbers are the supplier’s invoice numbers.', 'ใบกำกับภาษีซื้อที่บันทึกในเดือน ใช้เลขที่ใบกำกับของผู้ขาย') },
    { id: 'wht', label: T('Withholding tax', 'ภาษีหัก ณ ที่จ่าย'), hint: T('Tax customers withheld from us (keep the 50 ทวิ certificates) and tax we withheld from suppliers (file ภ.ง.ด.3 / ภ.ง.ด.53).', 'ภาษีที่ลูกค้าหักเรา (เก็บหนังสือรับรอง 50 ทวิ) และที่เราหักผู้ขาย (ยื่น ภ.ง.ด.3/53)') },
    { id: 'stock', label: T('Stock valuation', 'มูลค่าสต็อก'), hint: T('On hand at standard cost.', 'คงเหลือ ณ ราคาทุนมาตรฐาน') },
    { id: 'trial-balance', label: T('Trial balance', 'งบทดลอง'), hint: T('Derived ledger postings from issued documents and payments. For your accountant — not a substitute for certified books.', 'รายการบัญชีที่สร้างจากเอกสารและการชำระ สำหรับผู้ทำบัญชี ไม่ใช่สมุดบัญชีที่รับรองแล้ว') },
  ];
  let tab = $state(page.url.searchParams.get('r') ?? 'vat-sales');
  let month = $state(page.url.searchParams.get('month') ?? app.boot.today.slice(0, 7));
  const r = resource(() => get(`reports/${tab}`, { month }));
  const data = $derived(r.data as any);
  const cur = $derived(tabs.find((t) => t.id === tab) ?? tabs[0]);
  const monthly = $derived(tab.startsWith('vat') || tab === 'wht');
  function pick(id: string) {
    tab = id;
    goto(`/reports?r=${id}&month=${month}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  const sum = (rows: any[], k: string) => rows.reduce((a, x) => a + (x[k] ?? 0), 0);

  function csv(rows: (string | number)[][], name: string) {
    const body = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const baht = (m: number) => (m / 100).toFixed(2);
  function exportCsv() {
    if (!data) return;
    if (tab.startsWith('vat')) {
      csv([['Date', 'Number', 'Kind', 'Corrects', 'Corrects date', 'Reason', 'Party', 'Tax ID', 'Branch', 'Net', 'VAT', 'Total', 'Void'], ...data.rows.map((x: any) => [x.date, x.number, x.kind, x.corrects?.number ?? '', x.corrects?.date ?? '', x.reason ?? '', x.partyName, x.taxId, x.branch, baht(x.net), baht(x.vat), baht(x.total), x.voided ? 'VOID' : ''])], `${tab}-${month}`);
    } else if (tab === 'wht') {
      const rows = [...data.withheldFromUs.map((x: any) => ['from-us', x]), ...data.withheldByUs.map((x: any) => ['by-us', x])];
      csv([['Direction', 'Date', 'Payment', 'Party', 'Tax ID', 'Category', 'Rate', 'Base', 'WHT', 'Certificate', 'Form'], ...rows.map(([d, x]: any) => [d, x.date, x.number, x.partyName, x.taxId, x.category, x.rate, x.base !== null ? baht(x.base) : '', baht(x.wht), x.certificate, x.form])], `wht-${month}`);
    } else if (tab === 'stock') {
      csv([['SKU', 'Name', 'UoM', 'On hand', 'Reserved', 'Incoming', 'Available', 'Cost', 'Value'], ...data.map((x: any) => [x.sku, x.name, x.uom, x.onHand, x.reserved, x.incoming, x.available, baht(x.costPrice), baht(x.value)])], 'stock');
    } else {
      csv([['Account', 'Name', 'Debit', 'Credit', 'Balance'], ...data.map((x: any) => [x.account, L(x.name), baht(x.debit), baht(x.credit), baht(x.balance)])], 'trial-balance');
    }
  }
</script>

<svelte:head><title>{T('Reports', 'รายงาน')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <h1>{T('Reports', 'รายงาน')}</h1>
    <div class="row">
      {#if monthly}<input type="month" bind:value={month} aria-label={T('Month', 'เดือน')} style="width:auto" />{/if}
      <button class="btn" onclick={exportCsv} disabled={!data}>{T('Download CSV', 'ดาวน์โหลด CSV')}</button>
      <button class="btn ghost" onclick={() => window.print()}>{T('Print', 'พิมพ์')}</button>
    </div>
  </header>
  <nav class="tabs" aria-label={T('Report', 'รายงาน')}>
    {#each tabs as t (t.id)}<button class:on={tab === t.id} onclick={() => pick(t.id)}>{t.label}</button>{/each}
  </nav>
  <p class="small muted hint">{cur.hint}</p>

  {#if r.error}<p class="err-text">{r.error.message}</p>
  {:else if data}
    {#if tab.startsWith('vat')}
      <table class="data">
        <thead><tr><th>#</th><th>{T('Date', 'วันที่')}</th><th>{T('Tax invoice no.', 'เลขที่ใบกำกับ')}</th><th>{T('Name', 'ชื่อ')}</th><th>{T('Tax ID', 'เลขประจำตัวผู้เสียภาษี')}</th><th>{T('Branch', 'สาขา')}</th><th class="num">{T('Value', 'มูลค่า')}</th><th class="num">VAT</th><th class="num">{T('Total', 'รวม')}</th></tr></thead>
        <tbody>
          {#each data.rows as x, i (x.id)}
            <tr class:void={x.voided} class="clickable" onclick={() => goto(`/documents/${x.id}`)}>
              <td class="small muted">{i + 1}</td><td class="small nowrap">{date(x.date)}</td><td class="mono small">{x.number}{#if x.voided} <span class="pill tone-danger">{T('void', 'ยกเลิก')}</span>{/if}
                {#if x.kind === 'credit'}<div class="tiny note">{T('Credit note', 'ใบลดหนี้')}{#if x.corrects}{' '}{T('for', 'ของ')} {x.corrects.number} ({date(x.corrects.date)}){/if}{#if x.reason}{' · '}{x.reason}{/if}</div>
                {:else if x.kind === 'debit'}<div class="tiny note">{T('Debit note', 'ใบเพิ่มหนี้')}{#if x.corrects}{' '}{T('for', 'ของ')} {x.corrects.number} ({date(x.corrects.date)}){/if}{#if x.reason}{' · '}{x.reason}{/if}</div>{/if}</td>
              <td>{x.partyName}</td><td class="mono small">{x.taxId}</td><td class="small">{x.branch}</td>
              <td class="num" class:neg={x.net < 0}>{money(x.net)}</td><td class="num" class:neg={x.vat < 0}>{money(x.vat)}</td><td class="num" class:neg={x.total < 0}>{money(x.total)}</td>
            </tr>
          {:else}<tr><td colspan="9" class="muted small">{T('Nothing this month.', 'ไม่มีรายการในเดือนนี้')}</td></tr>{/each}
        </tbody>
        {#if data.rows.length}<tfoot><tr><td colspan="6"><strong>{T('Total', 'รวม')}</strong></td><td class="num"><strong>{money(data.totals?.net ?? sum(data.rows, 'net'))}</strong></td><td class="num"><strong>{money(data.totals?.vat ?? sum(data.rows, 'vat'))}</strong></td><td class="num"><strong>{money(data.totals?.total ?? sum(data.rows, 'total'))}</strong></td></tr></tfoot>{/if}
      </table>
    {:else if tab === 'wht'}
      {#each [{ k: 'withheldFromUs', t: T('Withheld from us by customers', 'ลูกค้าหักภาษี ณ ที่จ่ายจากเรา') }, { k: 'withheldByUs', t: T('Withheld by us from suppliers', 'เราหักภาษี ณ ที่จ่ายจากผู้ขาย') }] as g (g.k)}
        <section class="section">
          <header><h2>{g.t}</h2><span class="num">฿{money(sum(data[g.k], 'wht'))}</span></header>
          <table class="data">
            <thead><tr><th>{T('Date', 'วันที่')}</th><th>{T('Payment', 'การชำระ')}</th><th>{T('Name', 'ชื่อ')}</th><th>{T('Tax ID', 'เลขภาษี')}</th><th>{T('Type of income', 'ประเภทเงินได้')}</th><th class="num">{T('Base', 'ฐาน')}</th><th class="num">{T('Tax', 'ภาษี')}</th><th>{T('Certificate', 'หนังสือรับรอง')}</th>{#if g.k === 'withheldByUs'}<th>{T('Form', 'แบบ')}</th>{/if}</tr></thead>
            <tbody>
              {#each data[g.k] as x (x.id)}
                <tr><td class="small nowrap">{date(x.date)}</td><td class="mono small">{x.number}</td><td>{x.partyName}</td><td class="mono small">{x.taxId ?? ''}</td><td class="small">{L(x.categoryLabel)}</td><td class="num">{x.base !== null ? money(x.base) : ''}</td><td class="num">{money(x.wht)}</td>
                  <td class="small">{#if x.certificate}{x.certificate}{:else}<span class="text-warning">{T('missing', 'ยังไม่มี')}</span>{/if}</td>{#if g.k === 'withheldByUs'}<td class="small">{x.form === 'PND3' ? 'ภ.ง.ด.3' : 'ภ.ง.ด.53'}</td>{/if}</tr>
              {:else}<tr><td colspan="9" class="muted small">{T('None this month.', 'ไม่มีในเดือนนี้')}</td></tr>{/each}
            </tbody>
          </table>
        </section>
      {/each}
    {:else if tab === 'stock'}
      <table class="data">
        <thead><tr><th>{T('Code', 'รหัส')}</th><th>{T('Name', 'ชื่อ')}</th><th class="num">{T('On hand', 'คงเหลือ')}</th><th class="num">{T('Reserved', 'จอง')}</th><th class="num">{T('Incoming', 'กำลังเข้า')}</th><th class="num">{T('Available', 'ใช้ได้')}</th><th class="num">{T('Cost', 'ทุน')}</th><th class="num">{T('Value', 'มูลค่า')}</th></tr></thead>
        <tbody>
          {#each data as x (x.id)}
            <tr class="clickable" onclick={() => goto(`/items/${x.id}`)}><td class="mono small">{x.sku}</td><td>{x.name}</td><td class="num">{qty(x.onHand)} <span class="tiny muted">{unit(x.uom)}</span></td><td class="num muted">{qty(x.reserved)}</td><td class="num muted">{qty(x.incoming)}</td><td class="num" class:text-danger={x.available < 0}>{qty(x.available)}</td><td class="num">{money(x.costPrice)}</td><td class="num">{money(x.value)}</td></tr>
          {/each}
        </tbody>
        <tfoot><tr><td colspan="7"><strong>{T('Total value', 'มูลค่ารวม')}</strong></td><td class="num"><strong>{money(sum(data, 'value'))}</strong></td></tr></tfoot>
      </table>
    {:else}
      <table class="data">
        <thead><tr><th>{T('Account', 'บัญชี')}</th><th></th><th class="num">{T('Debit', 'เดบิต')}</th><th class="num">{T('Credit', 'เครดิต')}</th><th class="num">{T('Balance', 'คงเหลือ')}</th></tr></thead>
        <tbody>{#each data as x (x.account)}<tr><td class="mono small">{x.account}</td><td>{L(x.name)}</td><td class="num">{money(x.debit)}</td><td class="num">{money(x.credit)}</td><td class="num">{money(x.balance)}</td></tr>{/each}</tbody>
        <tfoot><tr><td colspan="2"><strong>{T('Total', 'รวม')}</strong></td><td class="num"><strong>{money(sum(data, 'debit'))}</strong></td><td class="num"><strong>{money(sum(data, 'credit'))}</strong></td><td class="num" class:text-danger={sum(data, 'balance') !== 0}><strong>{money(sum(data, 'balance'))}</strong></td></tr></tfoot>
      </table>
    {/if}
  {:else}<p class="muted">{T('Loading…', 'กำลังโหลด…')}</p>{/if}
</div>

<style>
  .note { color: var(--muted); font-family: var(--font, inherit); }
  .neg { color: var(--t-danger); }
  .hint { margin: 10px 0 16px; max-width: 70ch; }
  .void td { opacity: 0.55; }
  tfoot td { border-top: 2px solid var(--line-strong); }
</style>
