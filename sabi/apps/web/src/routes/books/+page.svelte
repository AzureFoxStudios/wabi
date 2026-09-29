<script lang="ts">
  /**
   * Books: the accounting side, kept apart from day-to-day work. Postings from documents and payments
   * are automatic; this page adds hand-written (adjusting) entries, the general ledger per account,
   * the chart of accounts and the corrections report.
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get, command } from '$lib/api.ts';
  import { app, T, toast, can, loadBoot } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date } from '$lib/format.ts';

  const tabs = $derived([
    { id: 'journal', label: T('Journal entries', 'บันทึกรายการบัญชี') },
    { id: 'ledger', label: T('General ledger', 'บัญชีแยกประเภท') },
    { id: 'accounts', label: T('Chart of accounts', 'ผังบัญชี') },
    { id: 'corrections', label: T('Corrections report', 'รายงานการแก้ไข') },
  ]);
  let tab = $state(page.url.searchParams.get('t') ?? 'journal');
  function pick(id: string) {
    tab = id;
    goto(`/books?t=${id}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  const writer = can('ledger.write');
  const accounts = $derived(app.boot.jurisdiction.chartOfAccounts as { code: string; name: any; type: string }[]);
  const accName = (code: string) => L(accounts.find((a) => a.code === code)?.name) || code;
  const typeLabel = (t: string) => ({ asset: T('Asset', 'สินทรัพย์'), liability: T('Liability', 'หนี้สิน'), equity: T('Equity', 'ส่วนของเจ้าของ'), income: T('Income', 'รายได้'), expense: T('Expense', 'ค่าใช้จ่าย') } as Record<string, string>)[t] ?? t;

  // ── Journal ──
  const journal = resource(() => (tab === 'journal' ? get('journal') : null));
  const blankLine = () => ({ account: '', debit: '', credit: '' });
  let je = $state({ date: app.boot.today, memo: '', lines: [blankLine(), blankLine()] });
  const minor = (x: string | number) => Math.round(Number(x || 0) * 100);
  const dr = $derived(je.lines.reduce((a, l) => a + minor(l.debit), 0));
  const cr = $derived(je.lines.reduce((a, l) => a + minor(l.credit), 0));
  const jeOk = $derived(dr > 0 && dr === cr && je.memo.trim() !== '' && je.lines.filter((l) => l.account && (minor(l.debit) || minor(l.credit))).length >= 2);
  let posting = $state(false);
  let showForm = $state(false);
  async function postEntry(e: Event) {
    e.preventDefault();
    posting = true;
    try {
      await command('journal.post', {
        date: je.date, memo: je.memo.trim(),
        lines: je.lines.filter((l) => l.account && (minor(l.debit) || minor(l.credit))).map((l) => ({ account: l.account, debit: minor(l.debit), credit: minor(l.credit) })),
      });
      toast(T('Entry posted', 'บันทึกรายการแล้ว'), 'success');
      je = { date: je.date, memo: '', lines: [blankLine(), blankLine()] };
      showForm = false;
      journal.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      posting = false;
    }
  }
  let reversing = $state<string | null>(null);
  let revReason = $state('');
  async function reverseEntry(id: string) {
    try {
      await command('journal.reverse', { id, reason: revReason });
      reversing = null;
      revReason = '';
      toast(T('Reversed', 'กลับรายการแล้ว'), 'success');
      journal.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }

  // ── Ledger ──
  let account = $state(page.url.searchParams.get('account') ?? '1130');
  let from = $state(`${app.boot.today.slice(0, 4)}-01-01`);
  let to = $state(app.boot.today);
  const ledger = resource(() => (tab === 'ledger' && account ? get('reports/ledger', { account, from, to }) : null));
  const srcHref = (s: any) => (s.type === 'document' ? `/documents/${s.id}` : s.type === 'payment' ? `/payments/${s.id}/print` : null);

  // ── Accounts ──
  let na = $state({ code: '', nameEn: '', nameTh: '', type: 'expense' });
  async function addAccount(e: Event) {
    e.preventDefault();
    try {
      await command('account.create', { ...na, nameTh: na.nameTh || undefined });
      na = { code: '', nameEn: '', nameTh: '', type: na.type };
      await loadBoot();
      toast(T('Account added', 'เพิ่มบัญชีแล้ว'), 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }

  // ── Corrections ──
  let cfrom = $state('');
  let cto = $state('');
  const corrections = resource(() => (tab === 'corrections' ? get('reports/adjustments', { from: cfrom, to: cto }) : null));
  const kindLabel = (k: string) => ({
    void_document: T('Voided documents', 'ยกเลิกเอกสาร'), void_payment: T('Voided payments', 'ยกเลิกการชำระ'),
    credit_note: T('Credit notes', 'ใบลดหนี้'), debit_note: T('Debit notes', 'ใบเพิ่มหนี้'),
    manual_entry: T('Manual entries', 'บันทึกบัญชีด้วยมือ'), reverse_entry: T('Reversals', 'กลับรายการ'),
  } as Record<string, string>)[k] ?? k;
  const subjHref = (s: any) => (!s ? null : s.type === 'document' ? `/documents/${s.id}` : `/payments/${s.id}/print`);
  const time = (iso: string) => new Intl.DateTimeFormat(app.locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(iso));

  function csv(rows: (string | number)[][], name: string) {
    const body = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const baht = (m: number) => (m / 100).toFixed(2);
</script>

<svelte:head><title>{T('Books', 'สมุดบัญชี')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <h1>{T('Books', 'สมุดบัญชี')}</h1>
      <p class="muted small">{T('Documents and payments post themselves. Nothing posted is ever edited or deleted — corrections are new entries, and all of them are listed in the corrections report.', 'เอกสารและการชำระเงินลงบัญชีให้อัตโนมัติ รายการที่ลงแล้วไม่ถูกแก้ไขหรือลบ การแก้ไขทำโดยบันทึกรายการใหม่ และแสดงทั้งหมดในรายงานการแก้ไข')}</p>
    </div>
    <button class="btn ghost" onclick={() => window.print()}>{T('Print', 'พิมพ์')}</button>
  </header>
  <nav class="tabs" aria-label={T('Books', 'สมุดบัญชี')}>
    {#each tabs as t (t.id)}<button class:on={tab === t.id} onclick={() => pick(t.id)}>{t.label}</button>{/each}
  </nav>

  {#if tab === 'journal'}
    {#if writer}
      {#if !showForm}
        <div class="row gap"><button class="btn primary" onclick={() => (showForm = true)}>{T('New journal entry', 'บันทึกรายการใหม่')}</button>
          <span class="small muted">{T('For accruals, depreciation, owner transactions, opening balances and other adjustments.', 'สำหรับค้างรับค้างจ่าย ค่าเสื่อมราคา รายการกับเจ้าของ ยอดยกมา และรายการปรับปรุงอื่น ๆ')}</span></div>
      {:else}
        <form class="panel jeform" onsubmit={postEntry}>
          <div class="g2">
            <label class="field"><span>{T('Date', 'วันที่')}</span><input type="date" bind:value={je.date} required /></label>
            <!-- svelte-ignore a11y_autofocus -->
            <label class="field"><span>{T('Description', 'คำอธิบาย')}</span><input bind:value={je.memo} required autofocus placeholder={T('e.g. Depreciation September', 'เช่น ค่าเสื่อมราคาเดือนกันยายน')} /></label>
          </div>
          <table class="data jelines">
            <thead><tr><th>{T('Account', 'บัญชี')}</th><th class="num">{T('Debit', 'เดบิต')}</th><th class="num">{T('Credit', 'เครดิต')}</th><th></th></tr></thead>
            <tbody>
              {#each je.lines as l, i (i)}
                <tr>
                  <td><select bind:value={l.account} aria-label={T('Account', 'บัญชี')}><option value="">—</option>{#each accounts as a (a.code)}<option value={a.code}>{a.code} · {L(a.name)}</option>{/each}</select></td>
                  <td><input class="num" type="number" step="0.01" min="0" bind:value={l.debit} oninput={() => l.debit && (l.credit = '')} aria-label={T('Debit', 'เดบิต')} /></td>
                  <td><input class="num" type="number" step="0.01" min="0" bind:value={l.credit} oninput={() => l.credit && (l.debit = '')} aria-label={T('Credit', 'เครดิต')} /></td>
                  <td>{#if je.lines.length > 2}<button type="button" class="btn ghost sm" onclick={() => je.lines.splice(i, 1)} aria-label={T('Remove line', 'ลบบรรทัด')}>×</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
            <tfoot><tr>
              <td><button type="button" class="btn ghost sm" onclick={() => je.lines.push(blankLine())}>+ {T('Line', 'บรรทัด')}</button></td>
              <td class="num"><strong>{money(dr)}</strong></td><td class="num"><strong>{money(cr)}</strong></td>
              <td class="small" class:text-danger={dr !== cr} class:text-success={dr === cr && dr > 0}>{dr === cr ? (dr ? T('balanced', 'สมดุล') : '') : `${T('off by', 'ต่างกัน')} ${money(Math.abs(dr - cr))}`}</td>
            </tr></tfoot>
          </table>
          <div class="row">
            <button class="btn primary" disabled={!jeOk || posting}>{T('Post entry', 'ลงบัญชี')}</button>
            <button type="button" class="btn ghost" onclick={() => (showForm = false)}>{T('Cancel', 'ยกเลิก')}</button>
            {#if app.boot.correctionsProtected}<span class="tiny muted">{T('Needs the corrections password.', 'ต้องใช้รหัสผ่านสำหรับการแก้ไข')}</span>{/if}
          </div>
        </form>
      {/if}
    {/if}
    <section class="section">
      <header><h2>{T('Manual entries', 'รายการที่บันทึกด้วยมือ')}</h2></header>
      {#if journal.data}
        {#each journal.data as e (e.id)}
          <article class="entry" class:reversed={e.reversedBy}>
            <div class="spread">
              <div><strong>{e.memo}</strong> <span class="small muted">{date(e.date)} · <span class="mono">{e.id}</span></span>
                {#if e.reversalOf}<span class="pill tone-warning">{T('reversal', 'กลับรายการ')}</span>{/if}
                {#if e.reversedBy}<span class="pill tone-neutral">{T('reversed', 'ถูกกลับรายการแล้ว')}</span>{/if}</div>
              {#if writer && !e.reversalOf && !e.reversedBy}
                {#if reversing === e.id}
                  <div class="row"><input bind:value={revReason} placeholder={T('Reason', 'เหตุผล')} style="width:200px;height:28px" />
                    <button class="btn danger sm" disabled={!revReason.trim()} onclick={() => reverseEntry(e.id)}>{T('Reverse', 'กลับรายการ')}</button>
                    <button class="btn ghost sm" onclick={() => (reversing = null)}>×</button></div>
                {:else}<button class="btn ghost sm" onclick={() => { reversing = e.id; revReason = ''; }}>{T('Reverse…', 'กลับรายการ…')}</button>{/if}
              {/if}
            </div>
            <table class="data compact">
              <tbody>{#each e.lines as l, i (i)}<tr><td class="mono small">{l.account}</td><td class:indent={l.credit > 0}>{accName(l.account)}</td><td class="num">{l.debit ? money(l.debit) : ''}</td><td class="num">{l.credit ? money(l.credit) : ''}</td></tr>{/each}</tbody>
            </table>
          </article>
        {:else}<p class="muted small">{T('No manual entries yet.', 'ยังไม่มีรายการ')}</p>{/each}
      {/if}
    </section>
  {:else if tab === 'ledger'}
    <div class="row wrap filters">
      <select bind:value={account} aria-label={T('Account', 'บัญชี')} style="width:auto">{#each accounts as a (a.code)}<option value={a.code}>{a.code} · {L(a.name)}</option>{/each}</select>
      <label class="row small">{T('From', 'จาก')} <input type="date" bind:value={from} style="width:auto" /></label>
      <label class="row small">{T('to', 'ถึง')} <input type="date" bind:value={to} style="width:auto" /></label>
      <button class="btn" disabled={!ledger.data} onclick={() => csv([['Date', 'Description', 'Party', 'Debit', 'Credit', 'Balance'], ['', 'Opening', '', '', '', baht(ledger.data.opening)], ...ledger.data.lines.map((l: any) => [l.date, l.memo, l.partyName, baht(l.debit), baht(l.credit), baht(l.balance)])], `ledger-${account}-${from}-${to}`)}>{T('Download CSV', 'ดาวน์โหลด CSV')}</button>
    </div>
    {#if ledger.error}<p class="err-text">{ledger.error.message}</p>
    {:else if ledger.data}
      {@const g = ledger.data}
      <table class="data">
        <thead><tr><th>{T('Date', 'วันที่')}</th><th>{T('Description', 'รายการ')}</th><th>{T('Party', 'คู่ค้า')}</th><th class="num">{T('Debit', 'เดบิต')}</th><th class="num">{T('Credit', 'เครดิต')}</th><th class="num">{T('Balance', 'คงเหลือ')}</th></tr></thead>
        <tbody>
          <tr class="muted"><td></td><td>{T('Opening balance', 'ยอดยกมา')}</td><td></td><td></td><td></td><td class="num">{money(g.opening)}</td></tr>
          {#each g.lines as l, i (i)}
            {@const href = srcHref(l.source)}
            <tr class:rev={l.reversal || l.reversed}>
              <td class="small nowrap">{date(l.date)}</td>
              <td>{#if href}<a class="link" href={href}>{l.memo}</a>{:else}{l.memo}{/if}{#if l.reversal}{' '}<span class="tiny muted">({T('reversal', 'กลับรายการ')})</span>{/if}</td>
              <td class="small">{l.partyName}</td>
              <td class="num">{l.debit ? money(l.debit) : ''}</td><td class="num">{l.credit ? money(l.credit) : ''}</td><td class="num">{money(l.balance)}</td>
            </tr>
          {:else}<tr><td colspan="6" class="muted small">{T('No postings in this period.', 'ไม่มีรายการในช่วงนี้')}</td></tr>{/each}
        </tbody>
        <tfoot><tr><td colspan="5"><strong>{T('Closing balance', 'ยอดยกไป')}</strong> <span class="tiny muted">{typeLabel(g.account.type)}</span></td><td class="num"><strong>{money(g.closing)}</strong></td></tr></tfoot>
      </table>
    {/if}
  {:else if tab === 'accounts'}
    <table class="data">
      <thead><tr><th>{T('Code', 'รหัส')}</th><th>{T('Name', 'ชื่อบัญชี')}</th><th>{T('Type', 'หมวด')}</th><th></th></tr></thead>
      <tbody>
        {#each accounts as a (a.code)}
          <tr class="clickable" onclick={() => { account = a.code; pick('ledger'); }}><td class="mono small">{a.code}</td><td>{L(a.name)}</td><td class="small muted">{typeLabel(a.type)}</td><td class="tiny muted">{T('ledger', 'แยกประเภท')} →</td></tr>
        {/each}
      </tbody>
    </table>
    {#if writer}
      <form class="addacc" onsubmit={addAccount}>
        <h3>{T('Add an account', 'เพิ่มบัญชี')}</h3>
        <div class="g4">
          <input bind:value={na.code} placeholder={T('Code, e.g. 5990', 'รหัส เช่น 5990')} required class="mono" aria-label={T('Code', 'รหัส')} />
          <input bind:value={na.nameEn} placeholder={T('Name (English)', 'ชื่อ (อังกฤษ)')} required aria-label={T('Name (English)', 'ชื่อ (อังกฤษ)')} />
          <input bind:value={na.nameTh} placeholder={T('Name (Thai)', 'ชื่อ (ไทย)')} aria-label={T('Name (Thai)', 'ชื่อ (ไทย)')} />
          <select bind:value={na.type} aria-label={T('Type', 'หมวด')}>{#each ['asset', 'liability', 'equity', 'income', 'expense'] as t (t)}<option value={t}>{typeLabel(t)}</option>{/each}</select>
        </div>
        <button class="btn">{T('Add', 'เพิ่ม')}</button>
        <p class="tiny muted">{T('The accounts that automatic postings use come from the tax adapter and cannot be changed here.', 'บัญชีที่ใช้ลงรายการอัตโนมัติมาจากตัวปรับภาษี และแก้ไขที่นี่ไม่ได้')}</p>
      </form>
    {/if}
  {:else if tab === 'corrections'}
    <div class="row wrap filters">
      <label class="row small">{T('From', 'จาก')} <input type="date" bind:value={cfrom} style="width:auto" /></label>
      <label class="row small">{T('to', 'ถึง')} <input type="date" bind:value={cto} style="width:auto" /></label>
      <button class="btn" disabled={!corrections.data} onclick={() => csv([['Time', 'User', 'Kind', 'Reference', 'Amount', 'Reason'], ...corrections.data.rows.map((r: any) => [r.at, r.username, r.kind, r.reference, baht(r.amount), r.reason])], 'corrections')}>{T('Download CSV', 'ดาวน์โหลด CSV')}</button>
    </div>
    <p class="small muted hint">{T('Everything changed after it was issued or posted, with who, when and how much. Built from the append-only journal: it cannot be edited or hidden.', 'ทุกรายการที่ถูกแก้ไขหลังออกเอกสารหรือลงบัญชี พร้อมผู้ทำ เวลา และจำนวนเงิน สร้างจากบันทึกเหตุการณ์ที่แก้ไขไม่ได้ จึงซ่อนหรือแก้รายงานนี้ไม่ได้')}</p>
    {#if corrections.data}
      {@const c = corrections.data}
      <div class="strip num">
        {#each Object.entries(c.counts) as [k, x] (k)}<div><span class="small muted">{kindLabel(k)}</span><strong>{(x as any).count}</strong><span class="tiny muted">฿{money((x as any).amount)}</span></div>{/each}
        {#if !Object.keys(c.counts).length}<p class="muted small">{T('No corrections in this period.', 'ไม่มีการแก้ไขในช่วงนี้')}</p>{/if}
      </div>
      <table class="data">
        <thead><tr><th>{T('When', 'เมื่อ')}</th><th>{T('Who', 'ผู้ทำ')}</th><th>{T('What', 'รายการ')}</th><th>{T('Reference', 'อ้างอิง')}</th><th class="num">{T('Amount', 'จำนวนเงิน')}</th><th>{T('Reason', 'เหตุผล')}</th></tr></thead>
        <tbody>
          {#each c.rows as r (r.seq + r.kind)}
            {@const href = subjHref(r.subject)}
            <tr><td class="small nowrap">{time(r.at)}</td><td class="small">{r.user} <span class="tiny muted mono">{r.username}</span></td><td class="small">{L(r.label)}</td>
              <td class="mono small">{#if href}<a class="link" href={href}>{r.reference}</a>{:else}{r.reference}{/if}</td><td class="num">{money(r.amount)}</td><td class="small">{r.reason}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .gap { margin-bottom: 8px; gap: 14px; }
  .jeform { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px; border-color: var(--accent); }
  .g2 { display: grid; grid-template-columns: 180px 1fr; gap: 10px; }
  .g4 { display: grid; grid-template-columns: 140px 1fr 1fr 150px; gap: 8px; margin: 8px 0; }
  .jelines input { width: 140px; text-align: right; }
  .jelines select { min-width: 280px; }
  .entry { padding: 12px 0; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
  .entry.reversed { opacity: 0.65; }
  .compact td { padding-top: 3px; padding-bottom: 3px; }
  .indent { padding-left: 28px !important; }
  .filters { margin: 4px 0 14px; gap: 12px; }
  .rev td { color: var(--muted); }
  .addacc { margin-top: 22px; max-width: 820px; }
  .hint { margin: 0 0 12px; max-width: 75ch; }
  .strip { display: flex; gap: 32px; flex-wrap: wrap; padding: 4px 0 16px; }
  .strip > div { display: flex; flex-direction: column; }
  .strip strong { font-size: 1.25rem; font-weight: 600; }
  tfoot td { border-top: 2px solid var(--line-strong); }
  @media (max-width: 900px) { .g2, .g4 { grid-template-columns: 1fr; } }
</style>
