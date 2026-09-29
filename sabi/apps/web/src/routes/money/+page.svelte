<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get, command } from '$lib/api.ts';
  import { app, T, toast, can, docTypeDef } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date } from '$lib/format.ts';
  import Picker from '$components/Picker.svelte';

  const r = resource(() => get('money'));
  const v = $derived(r.data as any);

  // ── Record payment panel (inline; opened by ?pay=in|out) ──
  let pay = $state<'in' | 'out' | null>(null);
  let partyId = $state('');
  let partyName = $state('');
  let alloc = $state<Record<string, { on: boolean; amount: string }>>({});
  let wht = $state({ amount: '', category: '', certificate: '' });
  let form = $state({ method: 'transfer', date: app.boot.today, reference: '' });
  let busy = $state(false);
  let seededFrom = '';

  let pendingDoc = $state('');
  $effect(() => {
    const sp = page.url.searchParams;
    const key = sp.toString();
    if (key === seededFrom) return;
    seededFrom = key;
    const p = sp.get('pay');
    if (p === 'in' || p === 'out') {
      pay = p;
      partyId = sp.get('partyId') ?? '';
      alloc = {};
      wht = { amount: '', category: '', certificate: '' };
      const doc = sp.get('doc');
      if (doc) pendingDoc = doc;
    }
  });
  // Documents this payment can settle: what the party owes (or we owe), plus over-credited documents
  // where money flows back the other way (refunds). `open` is always the positive amount that can move.
  const openDocs = $derived(v && pay && partyId
    ? [
        ...(pay === 'in' ? v.receivables : v.payables).filter((d: any) => d.partyId === partyId).map((d: any) => ({ ...d, open: d.balance, refund: false })),
        ...v.credits.filter((d: any) => d.partyId === partyId && d.money === (pay === 'in' ? 'payable' : 'receivable')).map((d: any) => ({ ...d, open: -d.balance, refund: true })),
      ]
    : []);
  // Pre-select: the document we came from, or everything if the party only has one open document.
  $effect(() => {
    if (!openDocs.length) return;
    const next = { ...alloc };
    let changed = false;
    for (const d of openDocs) {
      if (next[d.id]) continue;
      next[d.id] = { on: pendingDoc ? d.id === pendingDoc : openDocs.length === 1, amount: (d.open / 100).toFixed(2) };
      changed = true;
    }
    if (changed) {
      alloc = next;
      suggestWht();
    }
  });
  const selected = $derived(openDocs.filter((d: any) => alloc[d.id]?.on));
  const refunding = $derived(selected.length > 0 && selected.every((d: any) => d.refund));
  const allocated = $derived(selected.reduce((a: number, d: any) => a + Math.round(Number(alloc[d.id].amount || 0) * 100), 0));
  const whtMinor = $derived(Math.round(Number(wht.amount || 0) * 100));
  const received = $derived(allocated - whtMinor);

  // Withholding the customer is expected to deduct (from the jurisdiction adapter), for selected sales documents.
  async function suggestWht() {
    if (pay !== 'in') return;
    const sel = openDocs.filter((d: any) => alloc[d.id]?.on && !d.refund);
    if (!sel.length) return (wht.amount = '');
    const views = await Promise.all(sel.map((d: any) => get(`documents/${d.id}`)));
    let total = 0;
    let cat = '';
    for (const vw of views) for (const w of vw.wht) (total += w.amount), (cat ||= w.category);
    wht.amount = total ? (total / 100).toFixed(2) : '';
    if (cat) wht.category = cat;
  }
  function toggle(id: string) {
    alloc[id].on = !alloc[id].on;
    suggestWht();
  }
  function close() {
    pay = null;
    goto('/money', { replaceState: true, keepFocus: true });
  }
  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      const res = await command('payment.record', {
        direction: pay, partyId, method: form.method, date: form.date, reference: form.reference || undefined,
        amount: refunding ? allocated : received, whtAmount: refunding ? 0 : whtMinor, whtCategory: whtMinor ? wht.category || undefined : undefined, whtCertificate: wht.certificate || undefined,
        allocations: selected.map((d: any) => ({ documentId: d.id, amount: Math.round(Number(alloc[d.id].amount) * 100) })),
      });
      toast(`${res.number} ${T('recorded', 'บันทึกแล้ว')}`, 'success');
      close();
      r.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }

  // ── Void a payment (inline confirmation with reason) ──
  let voiding = $state<string | null>(null);
  let voidReason = $state('');
  async function doVoid(id: string) {
    try {
      await command('payment.void', { id, reason: voidReason });
      voiding = null;
      voidReason = '';
      toast(T('Payment voided', 'ยกเลิกการชำระแล้ว'), 'success');
      r.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  const sumOf = (l: any[]) => l.reduce((a, d) => a + d.balance, 0);
  const overdueOf = (l: any[]) => l.filter((d) => d.overdue).reduce((a, d) => a + d.balance, 0);
  const buckets = ['current', '1-30', '31-60', '61-90', '90+'];
  const bucketLabel = (b: string) => (b === 'current' ? T('Not due', 'ยังไม่ถึงกำหนด') : `${b} ${T('days', 'วัน')}`);
  const method = (id: string) => L(app.boot.pack.paymentMethods.find((m: any) => m.id === id)?.label) || id;
</script>

<svelte:head><title>{T('Money', 'การเงิน')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <h1>{T('Money', 'การเงิน')}</h1>
      <p class="muted small">{T('Who owes what, what we owe, and what came in this month.', 'ใครค้างเรา เราค้างใคร และเงินเข้าเดือนนี้')}</p>
    </div>
    {#if can('money.write') && !pay}
      <div class="row">
        <a class="btn" href="/money?pay=out">{T('Pay a supplier', 'จ่ายผู้ขาย')}</a>
        <a class="btn primary" href="/money?pay=in">{T('Record payment received', 'บันทึกรับชำระ')}</a>
      </div>
    {/if}
  </header>

  {#if pay}
    <section class="panel paybox">
      <div class="spread"><h2>{refunding ? (pay === 'out' ? T('Refund to customer', 'คืนเงินลูกค้า') : T('Refund from supplier', 'รับเงินคืนจากผู้ขาย')) : pay === 'in' ? T('Payment received', 'รับชำระเงิน') : T('Payment to supplier', 'จ่ายเงินผู้ขาย')}</h2><button class="btn ghost sm" onclick={close}>{T('Close', 'ปิด')} <kbd>Esc</kbd></button></div>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <form class="stack" onsubmit={submit} onkeydown={(e) => e.key === 'Escape' && close()}>
        <div class="g3">
          <Picker kind="parties" role={pendingDoc ? undefined : pay === 'in' ? 'customer' : 'supplier'} bind:value={partyId} display={partyName} onpick={(p) => { partyName = p.name; alloc = {}; pendingDoc = ''; }} label={pay === 'in' ? T('From customer', 'จากลูกค้า') : T('To supplier', 'ถึงผู้ขาย')} autofocus={!partyId} />
          <label class="field"><span>{T('Date', 'วันที่')}</span><input type="date" bind:value={form.date} /></label>
          <label class="field"><span>{T('Method', 'วิธีชำระ')}</span><select bind:value={form.method}>{#each app.boot.pack.paymentMethods as m (m.id)}<option value={m.id}>{L(m.label)}</option>{/each}</select></label>
        </div>
        {#if partyId}
          {#if openDocs.length}
            <table class="data">
              <thead><tr><th></th><th>{T('Document', 'เอกสาร')}</th><th>{T('Due', 'ครบกำหนด')}</th><th class="num">{T('Open', 'คงค้าง')}</th><th class="num">{T('Settle', 'ตัดชำระ')}</th></tr></thead>
              <tbody>
                {#each openDocs as d (d.id)}
                  {#if alloc[d.id]}
                    <tr>
                      <td><input type="checkbox" checked={alloc[d.id].on} onchange={() => toggle(d.id)} aria-label={d.number} /></td>
                      <td>{L(docTypeDef(d.type)?.label)} <span class="mono small">{d.number}</span>{#if d.refund}{' '}<span class="pill tone-warning">{T('refund', 'คืนเงิน')}</span>{/if}</td>
                      <td class="small" class:text-danger={d.overdue}>{d.refund ? '' : date(d.dueDate)}</td>
                      <td class="num">{money(d.open)}</td>
                      <td class="num"><input class="num amt" type="number" step="0.01" min="0" bind:value={alloc[d.id].amount} disabled={!alloc[d.id].on} /></td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="muted small">{T('Nothing is outstanding for this party.', 'ไม่มียอดค้างสำหรับรายนี้')}</p>
          {/if}
        {/if}
        {#if selected.length && !refunding}
          <div class="g3">
            <label class="field"><span>{pay === 'in' ? T('Tax withheld by customer ฿', 'ลูกค้าหัก ณ ที่จ่าย ฿') : T('Tax we withhold ฿', 'เราหัก ณ ที่จ่าย ฿')}</span><input class="num" type="number" step="0.01" min="0" bind:value={wht.amount} /></label>
            {#if whtMinor}
              <label class="field"><span>{T('Category', 'ประเภทเงินได้')}</span><select bind:value={wht.category}><option value="">—</option>{#each app.boot.jurisdiction.whtCategories as w (w.id)}<option value={w.id}>{L(w.label)} {Math.round(w.rate * 1000) / 10}%</option>{/each}</select></label>
              <label class="field"><span>{T('Certificate no. (50 ทวิ)', 'เลขที่หนังสือรับรอง 50 ทวิ')}</span><input bind:value={wht.certificate} /></label>
            {/if}
          </div>
        {/if}
        {#if selected.length}
          <label class="field"><span>{T('Reference (bank ref, cheque no.)', 'อ้างอิง (เลขอ้างอิงธนาคาร เลขเช็ค)')}</span><input bind:value={form.reference} /></label>
          <div class="sum num">
            <span>{T('Settles', 'ตัดหนี้')} ฿{money(allocated)}</span>
            {#if whtMinor && !refunding}<span>− {T('withheld', 'หัก ณ ที่จ่าย')} ฿{money(whtMinor)}</span>{/if}
            <strong>= {pay === 'in' ? T('Money received', 'เงินที่ได้รับ') : T('Money paid', 'เงินที่จ่าย')} ฿{money(refunding ? allocated : received)}</strong>
          </div>
          <div class="row"><button class="btn primary" disabled={busy || received < 0}>{T('Record', 'บันทึก')}</button></div>
        {/if}
      </form>
    </section>
  {/if}

  {#if v}
    <div class="strip num">
      <div><span class="small muted">{T('Customers owe us', 'ลูกค้าค้างชำระ')}</span><strong>฿{money(sumOf(v.receivables))}</strong>{#if overdueOf(v.receivables)}<span class="small text-danger">{T('overdue', 'เกินกำหนด')} ฿{money(overdueOf(v.receivables))}</span>{/if}</div>
      <div><span class="small muted">{T('We owe suppliers', 'ค้างจ่ายผู้ขาย')}</span><strong>฿{money(sumOf(v.payables))}</strong>{#if overdueOf(v.payables)}<span class="small text-danger">{T('overdue', 'เกินกำหนด')} ฿{money(overdueOf(v.payables))}</span>{/if}</div>
      <div><span class="small muted">{T('In this month', 'รับเดือนนี้')}</span><strong class="text-success">฿{money(v.inThisMonth)}</strong></div>
      <div><span class="small muted">{T('Out this month', 'จ่ายเดือนนี้')}</span><strong>฿{money(v.outThisMonth)}</strong></div>
      <div><span class="small muted">{T('VAT this month (output − input)', 'VAT เดือนนี้ (ขาย − ซื้อ)')}</span><strong>฿{money(v.vat.net)}</strong><a class="tiny link" href="/reports">{T('reports', 'รายงาน')}</a></div>
    </div>

    <div class="cols">
      <section class="section">
        <header><h2>{T('Receivables', 'ลูกหนี้')}</h2></header>
        <div class="aging">{#each buckets as b (b)}<div class:bad={b !== 'current' && v.agingReceivable[b] > 0}><span class="tiny muted">{bucketLabel(b)}</span><span class="num">{money(v.agingReceivable[b])}</span></div>{/each}</div>
        <table class="data">
          <tbody>
            {#each v.receivables as d (d.id)}
              <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}>
                <td>{d.partyName}<br /><span class="tiny muted mono">{d.number}</span></td>
                <td class="small" class:text-danger={d.overdue}>{d.overdue ? `${d.daysOverdue} ${T('days late', 'วันเกินกำหนด')}` : date(d.dueDate)}</td>
                <td class="num">{money(d.balance)}</td>
                {#if can('money.write')}<td><a class="btn ghost sm" href={`/money?pay=in&partyId=${d.partyId}&doc=${d.id}`} onclick={(e) => e.stopPropagation()}>{T('Paid', 'รับชำระ')}</a></td>{/if}
              </tr>
            {:else}<tr><td class="muted small">{T('Nothing outstanding.', 'ไม่มียอดค้าง')}</td></tr>{/each}
          </tbody>
        </table>
      </section>
      <section class="section">
        <header><h2>{T('Payables', 'เจ้าหนี้')}</h2></header>
        <div class="aging">{#each buckets as b (b)}<div class:bad={b !== 'current' && v.agingPayable[b] > 0}><span class="tiny muted">{bucketLabel(b)}</span><span class="num">{money(v.agingPayable[b])}</span></div>{/each}</div>
        <table class="data">
          <tbody>
            {#each v.payables as d (d.id)}
              <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}>
                <td>{d.partyName}<br /><span class="tiny muted mono">{d.number}</span></td>
                <td class="small" class:text-danger={d.overdue}>{d.overdue ? `${d.daysOverdue} ${T('days late', 'วันเกินกำหนด')}` : date(d.dueDate)}</td>
                <td class="num">{money(d.balance)}</td>
                {#if can('money.write')}<td><a class="btn ghost sm" href={`/money?pay=out&partyId=${d.partyId}&doc=${d.id}`} onclick={(e) => e.stopPropagation()}>{T('Pay', 'จ่าย')}</a></td>{/if}
              </tr>
            {:else}<tr><td class="muted small">{T('Nothing outstanding.', 'ไม่มียอดค้าง')}</td></tr>{/each}
          </tbody>
        </table>
      </section>
    </div>

    {#if v.credits.length || v.retentionHeld.length}
      <div class="cols">
        <section class="section">
          <header><h2>{T('Credit balances', 'ยอดเครดิตคงเหลือ')}</h2></header>
          <p class="tiny muted">{T('A credit note larger than what was still owed. Refund it, or keep it and settle the next invoice against it.', 'ใบลดหนี้ที่มากกว่ายอดค้าง คืนเงิน หรือเก็บไว้หักกับใบแจ้งหนี้ถัดไป')}</p>
          <table class="data">
            <tbody>
              {#each v.credits as d (d.id)}
                <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}>
                  <td>{d.partyName}<br /><span class="tiny muted mono">{d.number}</span></td>
                  <td class="small">{d.money === 'receivable' ? T('we owe the customer', 'เราต้องคืนลูกค้า') : T('supplier owes us', 'ผู้ขายต้องคืนเรา')}</td>
                  <td class="num">{money(-d.balance)}</td>
                  {#if can('money.write')}<td><a class="btn ghost sm" href={`/money?pay=${d.money === 'receivable' ? 'out' : 'in'}&partyId=${d.partyId}&doc=${d.id}`} onclick={(e) => e.stopPropagation()}>{T('Refund', 'คืนเงิน')}</a></td>{/if}
                </tr>
              {:else}<tr><td class="muted small">{T('None.', 'ไม่มี')}</td></tr>{/each}
            </tbody>
          </table>
        </section>
        <section class="section">
          <header><h2>{T('Retention held', 'เงินประกันผลงานที่ถูกหัก')}</h2><span class="num">฿{money(v.retentionHeld.reduce((a: number, d: any) => a + d.retentionHeld, 0))}</span></header>
          <table class="data">
            <tbody>
              {#each v.retentionHeld as d (d.id)}
                <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}>
                  <td>{d.partyName}<br /><span class="tiny muted mono">{d.number}</span></td>
                  <td class="small muted">{date(d.date)}</td>
                  <td class="num">{money(d.retentionHeld)}</td>
                </tr>
              {:else}<tr><td class="muted small">{T('None.', 'ไม่มี')}</td></tr>{/each}
            </tbody>
          </table>
        </section>
      </div>
    {/if}

    <section class="section">
      <header><h2>{T('Recent payments', 'การชำระล่าสุด')}</h2></header>
      <table class="data">
        <thead><tr><th>{T('No.', 'เลขที่')}</th><th>{T('Date', 'วันที่')}</th><th>{T('Party', 'คู่ค้า')}</th><th>{T('Method', 'วิธี')}</th><th>{T('Settles', 'ตัดชำระ')}</th><th class="num">{T('WHT', 'หัก ณ ที่จ่าย')}</th><th class="num">{T('Amount', 'จำนวน')}</th><th></th></tr></thead>
        <tbody>
          {#each v.payments as p (p.id)}
            <tr class:void={p.voided}>
              <td class="mono small"><a class="link" href={`/payments/${p.id}/print`} target="_blank">{p.number}</a>{#if p.allocations.every((a: any) => a.refund)}<br /><span class="tiny muted">{T('refund', 'คืนเงิน')}</span>{/if}</td>
              <td class="small nowrap">{date(p.date)}</td>
              <td>{p.partyName}</td>
              <td class="small">{method(p.method)}{#if p.reference}<br /><span class="tiny muted">{p.reference}</span>{/if}</td>
              <td class="small">{#each p.allocations as a, i (a.documentId)}{i ? ', ' : ''}<a class="link" href={`/documents/${a.documentId}`}>{a.number ?? T('draft', 'ร่าง')}</a>{/each}</td>
              <td class="num small">{p.whtAmount ? money(p.whtAmount) : ''}{#if p.whtCertificate}<br /><span class="tiny muted">{p.whtCertificate}</span>{/if}</td>
              <td class="num" class:text-success={p.direction === 'in'}>{p.direction === 'in' ? '+' : '−'}{money(p.amount)}</td>
              <td class="nowrap">
                {#if !p.voided && can('money.write')}
                  {#if voiding === p.id}
                    <input class="vr" bind:value={voidReason} placeholder={T('Reason', 'เหตุผล')} />
                    <button class="btn danger sm" disabled={!voidReason} onclick={() => doVoid(p.id)}>{T('Void', 'ยกเลิก')}</button>
                    <button class="btn ghost sm" onclick={() => (voiding = null)}>×</button>
                  {:else}<button class="btn ghost sm" onclick={() => { voiding = p.id; voidReason = ''; }}>{T('Void…', 'ยกเลิก…')}</button>{/if}
                {:else if p.voided}<span class="tiny muted">{T('void', 'ยกเลิก')}</span>{/if}
              </td>
            </tr>
          {:else}<tr><td colspan="8" class="muted small">{T('No payments yet.', 'ยังไม่มีการชำระ')}</td></tr>{/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>

<style>
  .paybox { padding: 18px 20px; margin-bottom: 24px; display: flex; flex-direction: column; gap: 14px; border-color: var(--accent); }
  .g3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; align-items: end; }
  .amt { width: 130px; text-align: right; }
  .sum { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; padding: 8px 0; border-top: 1px dashed var(--line); }
  .sum strong { font-size: 1.1rem; }
  .strip { display: flex; gap: 36px; flex-wrap: wrap; padding: 4px 0 18px; }
  .strip > div { display: flex; flex-direction: column; }
  .strip strong { font-size: 1.3rem; font-weight: 600; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; border-top: 1px solid var(--line); }
  .cols > .section { border-top: 0; }
  .aging { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; margin-bottom: 10px; }
  .aging > div { background: var(--surface); padding: 6px 8px; display: flex; flex-direction: column; font-size: 0.88rem; }
  .aging > div.bad .num { color: var(--t-danger); font-weight: 500; }
  .void td { opacity: 0.5; text-decoration: line-through; }
  .vr { width: 140px; height: 28px; }
  @media (max-width: 1000px) { .cols, .g3 { grid-template-columns: 1fr; } }
</style>
