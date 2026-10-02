<script lang="ts">
  import { page } from '$app/state';
  import { get, command } from '$lib/api.ts';
  import { app, T, toast, can, docTypeDef } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, qty, date, ago, userName, unit } from '$lib/format.ts';
  import ItemForm from '$components/ItemForm.svelte';
  import Timeline from '$components/Timeline.svelte';

  const r = resource(() => get(`items/${page.params.id}`));
  const v = $derived(r.data as any);
  const it = $derived(v?.item);
  let editing = $state(false);
  let adj = $state({ qty: '', reason: '', location: app.boot.pack.defaultLocation });
  let busy = $state(false);
  const locs = app.boot.pack.locations;
  const locLabel = (id: string) => L(locs.find((l: any) => l.id === id)?.name) || ({ customer: T('Customer', 'ลูกค้า'), supplier: T('Supplier', 'ผู้ขาย'), consumed: T('Used on a job', 'เบิกใช้ในงาน'), adjustment: T('Count correction', 'แก้ยอดนับ') } as Record<string, string>)[id] || id;
  const internal = locs.filter((l: any) => l.kind === 'internal');

  async function adjust(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      await command('stock.adjust', { itemId: it.id, qty: Number(adj.qty), reason: adj.reason, location: adj.location });
      adj = { ...adj, qty: '', reason: '' };
      toast(T('Stock corrected', 'แก้ยอดในคลังแล้ว'), 'success');
      r.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
  // Running balance per movement (moves arrive newest first, so walk back from today's on-hand).
  const isIn = (id: string) => internal.some((l: any) => l.id === id);
  const balances = $derived.by(() => {
    if (!v?.stock) return [];
    let bal = v.stock.onHand;
    return v.moves.map((m: any) => {
      const after = bal;
      bal -= (isIn(m.to) ? m.qty : 0) - (isIn(m.from) ? m.qty : 0);
      return after;
    });
  });

  // Count: enter what is on the shelf; the difference becomes an adjustment with a clear reason.
  let count = $state({ qty: '', location: app.boot.pack.defaultLocation });
  async function recordCount(e: Event) {
    e.preventDefault();
    const counted = Number(count.qty);
    const book = v.stock.byLocation[count.location] ?? 0;
    const diff = Math.round((counted - book) * 1000) / 1000;
    if (diff === 0) {
      toast(T('Your count matches what the system says — nothing to change', 'ยอดที่นับได้ตรงกับในระบบ ไม่ต้องแก้'), 'success');
      count.qty = '';
      return;
    }
    busy = true;
    try {
      await command('stock.adjust', { itemId: it.id, qty: diff, reason: `${T('Stock count', 'ตรวจนับสต็อก')}: ${counted} (${T('book', 'ตามบัญชี')} ${book})`, location: count.location });
      count.qty = '';
      toast(`${T('Count recorded', 'บันทึกการตรวจนับแล้ว')} (${diff > 0 ? '+' : ''}${diff})`, 'success');
      r.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
  let tr = $state({ qty: '', from: internal[0]?.id ?? '', to: internal[1]?.id ?? '', note: '' });
  async function transfer(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      await command('stock.transfer', { itemId: it.id, qty: Number(tr.qty), from: tr.from, to: tr.to, note: tr.note || undefined });
      tr = { ...tr, qty: '', note: '' };
      toast(T('Moved', 'ย้ายแล้ว'), 'success');
      r.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }

  async function toggleActive() {
    await command('item.update', { id: it.id, active: !it.active });
    r.reload();
  }
</script>

<svelte:head><title>{it?.sku ?? ''} · Sabi</title></svelte:head>

{#if v}
  <div class="page wide">
    <nav class="small muted crumbs"><a href="/items">← {T('All products', 'สินค้าทั้งหมด')}</a></nav>
    <header class="head">
      <div class="grow">
        <h1>{it.name}</h1>
        <p class="sub">{T('Sells for', 'ราคาขาย')} ฿{money(it.salePrice)} {T('per', 'ต่อ')} {unit(it.uom)} · <span class="ref">{T('code', 'รหัส')} {it.sku}</span> {#if !it.active}<span class="pill tone-neutral">{T('No longer used (hidden from lists)', 'เลิกใช้แล้ว (ซ่อนจากรายการ)')}</span>{/if}</p>
      </div>
    </header>

    {#if v.stock}
      <div class="strip num">
        <div><span class="small muted">{T('In the warehouse', 'มีในคลัง')}</span><strong>{qty(v.stock.onHand)} <small>{unit(it.uom)}</small></strong></div>
        <div><span class="small muted">{T('Already promised to customers', 'จองให้ลูกค้าแล้ว')}</span><strong>{qty(v.stock.reserved)}</strong></div>
        <div><span class="small muted">{T('Ordered from suppliers, on the way', 'สั่งจากผู้ขายแล้ว กำลังมา')}</span><strong>{qty(v.stock.incoming)}</strong></div>
        <div><span class="small muted">{T('Free to use', 'ว่างให้ใช้')}</span><strong class:text-danger={v.stock.available < 0} class:text-warning={it.reorderPoint != null && v.stock.available >= 0 && v.stock.available < it.reorderPoint}>{v.stock.available < 0 ? T(`${qty(-v.stock.available)} short`, `ขาด ${qty(-v.stock.available)}`) : qty(v.stock.available)}</strong>
          {#if it.reorderPoint != null}<span class="tiny muted">{v.stock.available < it.reorderPoint ? T('running low — you wanted at least', 'ใกล้หมด — ควรมีอย่างน้อย') : T('order more when below', 'ควรสั่งเพิ่มเมื่อต่ำกว่า')} {qty(it.reorderPoint)}</span>{/if}</div>
        {#if internal.length > 1}<div class="small muted">{#each internal as l (l.id)}{L(l.name)}: {qty(v.stock.byLocation[l.id] ?? 0)}<br />{/each}</div>{/if}
      </div>
    {/if}

    <div class="layout">
      <div class="main">
        {#if v.reservedBy.length}
          <section class="section">
            <header><h2>{T('Promised to customers', 'จองให้ลูกค้าแล้ว')}</h2></header>
            <ul class="plain">{#each v.reservedBy as rb (rb.docId)}<li><a class="link" href={`/documents/${rb.docId}`}>{rb.docNumber}</a>{#if rb.jobId}{' '}· <a class="link" href={`/jobs/${rb.jobId}`}>{rb.jobNumber}</a>{/if} · {qty(rb.qty)} {unit(it.uom)}</li>{/each}</ul>
          </section>
        {/if}
        {#if v.stock}
          <section class="section">
            <header><h2>{T('Every time it came in or went out', 'ประวัติของเข้า–ออก')}</h2></header>
            <table class="data">
              <thead><tr><th>{T('Date', 'วันที่')}</th><th>{T('From → to', 'จาก → ไป')}</th><th>{T('Because of', 'เพราะอะไร')}</th><th class="num">{T('Amount', 'จำนวน')}</th><th class="num">{T('Left after', 'เหลือหลังจากนั้น')}</th></tr></thead>
              <tbody>
                {#each v.moves as m, mi (m.id)}
                  {@const inbound = internal.some((l: any) => l.id === m.to) && !internal.some((l: any) => l.id === m.from)}
                  {@const outbound = internal.some((l: any) => l.id === m.from) && !internal.some((l: any) => l.id === m.to)}
                  <tr>
                    <td class="small nowrap" title={m.at}>{date(m.at.slice(0, 10))}<br /><span class="tiny muted">{userName(m.by)}</span></td>
                    <td class="small">{locLabel(m.from)} → {locLabel(m.to)}{#if m.note}<br /><span class="tiny muted">{m.note}</span>{/if}</td>
                    <td class="small">{#if m.documentId}<a class="link" href={`/documents/${m.documentId}`}>{L(docTypeDef(m.docType)?.label)} {m.docNumber}</a>{/if}{#if m.jobId}{#if m.documentId}{' · '}{/if}<a class="link" href={`/jobs/${m.jobId}`}>{m.jobNumber}</a>{/if}</td>
                    <td class="num" class:text-success={inbound} class:text-danger={outbound}>{inbound ? '+' : outbound ? '−' : ''}{qty(m.qty)}</td>
                    <td class="num muted">{qty(balances[mi])}</td>
                  </tr>
                {:else}<tr><td colspan="5" class="muted small">{T('Nothing has come in or gone out yet.', 'ยังไม่มีของเข้าหรือออก')}</td></tr>{/each}
              </tbody>
            </table>
          </section>
          {#if can('stock.write')}
            <section class="section">
              <header><h2>{T('Correct the stock', 'แก้ยอดของในคลัง')}</h2></header>
              <p class="small muted">{T('Only for broken goods, lost goods, or the starting amount. You do NOT need this for deliveries or goods arriving — those change the stock by themselves.', 'ใช้เฉพาะเมื่อของเสีย ของหาย หรือใส่ยอดตั้งต้น ไม่ต้องใช้เมื่อส่งของหรือรับของ เพราะระบบตัด/เพิ่มให้เอง')}</p>
              <form class="row wrap adj" onsubmit={adjust}>
                <input type="number" step="any" bind:value={adj.qty} placeholder={T('+10 or −3', '+10 หรือ −3')} required class="num" style="width:120px" />
                {#if internal.length > 1}<select bind:value={adj.location} style="width:auto">{#each internal as l (l.id)}<option value={l.id}>{L(l.name)}</option>{/each}</select>{/if}
                <input class="grow" bind:value={adj.reason} placeholder={T('Why? e.g. “2 sheets bent in the truck” (required)', 'เพราะอะไร? เช่น “แผ่นงอ 2 แผ่นตอนขนส่ง” (ต้องใส่)')} required />
                <button class="btn" disabled={busy || !adj.qty || !adj.reason}>{T('Save correction', 'บันทึกการแก้ยอด')}</button>
              </form>
              <h3 class="sub3">{T('I counted it', 'ฉันนับของจริงแล้ว')}</h3>
              <form class="row wrap adj" onsubmit={recordCount}>
                <input type="number" step="any" min="0" bind:value={count.qty} placeholder={T('Counted', 'นับได้')} required class="num" style="width:130px" />
                {#if internal.length > 1}<select bind:value={count.location} style="width:auto">{#each internal as l (l.id)}<option value={l.id}>{L(l.name)}</option>{/each}</select>{/if}
                <span class="small muted">{T('The system says', 'ในระบบมี')} {qty(v.stock.byLocation[count.location] ?? 0)}</span>
                <button class="btn" disabled={busy || count.qty === ''}>{T('Save count', 'บันทึกยอดที่นับ')}</button>
              </form>
              {#if internal.length > 1}
                <h3 class="sub3">{T('Move to another place', 'ย้ายไปที่อื่น')}</h3>
                <form class="row wrap adj" onsubmit={transfer}>
                  <input type="number" step="any" min="0" bind:value={tr.qty} placeholder={T('Qty', 'จำนวน')} required class="num" style="width:110px" />
                  <select bind:value={tr.from} style="width:auto" aria-label={T('From', 'จาก')}>{#each internal as l (l.id)}<option value={l.id}>{L(l.name)}</option>{/each}</select>
                  <span>→</span>
                  <select bind:value={tr.to} style="width:auto" aria-label={T('To', 'ไป')}>{#each internal as l (l.id)}<option value={l.id}>{L(l.name)}</option>{/each}</select>
                  <input class="grow" bind:value={tr.note} placeholder={T('Note (optional)', 'หมายเหตุ (ไม่ใส่ก็ได้)')} />
                  <button class="btn" disabled={busy || !tr.qty || tr.from === tr.to}>{T('Move', 'ย้าย')}</button>
                </form>
              {/if}
            </section>
          {/if}
        {/if}
      </div>
      <aside class="side">
        <section>
          <div class="spread"><h3 class="eyebrow">{T('Product details', 'ข้อมูลสินค้า')}</h3>{#if can('items.write') && !editing}<button class="btn ghost sm" onclick={() => (editing = true)}>{T('Edit', 'แก้ไข')}</button>{/if}</div>
          {#if editing}
            <ItemForm item={it} onsaved={() => { editing = false; r.reload(); }} oncancel={() => (editing = false)} />
          {:else}
            <dl class="facts">
              <dt>{T('We buy it for', 'ราคาทุน')}</dt><dd>฿{money(it.costPrice)}</dd>
              {#if it.reorderPoint != null}<dt>{T('Keep at least', 'ควรมีอย่างน้อย')}</dt><dd>{qty(it.reorderPoint)} {unit(it.uom)}</dd>{/if}
              <dt>{T('VAT', 'VAT')}</dt><dd>{L(app.boot.jurisdiction.taxCodes.find((t: any) => t.code === it.taxCode)?.label) || it.taxCode}</dd>
              {#if it.whtCategory}<dt>{T('Tax kept back by company customers', 'ลูกค้าบริษัทหักภาษี ณ ที่จ่าย')}</dt><dd>{L(app.boot.jurisdiction.whtCategories.find((w: any) => w.id === it.whtCategory)?.label)}</dd>{/if}
              {#if it.measureTemplate}<dt>{T('Amount worked out from', 'คำนวณจำนวนจาก')}</dt><dd>{L(app.boot.pack.measureTemplates.find((m: any) => m.id === it.measureTemplate)?.label)}</dd>{/if}
              {#each app.boot.pack.itemFields as x (x.key)}{#if it.fields[x.key] !== undefined}<dt>{L(x.label)}</dt><dd>{L(x.options?.find((o: any) => o.value === it.fields[x.key])?.label) || it.fields[x.key]}{x.unit ? ' ' + x.unit : ''}</dd>{/if}{/each}
            </dl>
            {#if can('items.write')}<button class="btn ghost sm" onclick={toggleActive}>{it.active ? T('Stop using (hide)', 'เลิกใช้ (ซ่อน)') : T('Use again', 'นำกลับมาใช้')}</button>{/if}
          {/if}
        </section>
        <section>
          <h3 class="eyebrow">{T('History', 'ประวัติ')}</h3>
          <Timeline events={v.timeline} limit={10} />
        </section>
      </aside>
    </div>
  </div>
{:else if r.error}<div class="page"><p class="err-text">{r.error.message}</p></div>
{:else}<div class="page"><p class="muted">{T('Loading…', 'กำลังโหลด…')}</p></div>{/if}

<style>
  .wide { max-width: 1240px; }
  .crumbs { margin-bottom: 8px; }
  .head { margin-bottom: 14px; }
  .sub { margin-top: 4px; color: var(--ink-2); }
  .strip { display: flex; gap: 36px; padding: 12px 0 16px; border-bottom: 1px solid var(--line); margin-bottom: 18px; flex-wrap: wrap; }
  .strip > div { display: flex; flex-direction: column; }
  .strip strong { font-size: 1.25rem; font-weight: 600; }
  .strip small { font-size: 0.8rem; font-weight: 400; color: var(--muted); }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 40px; }
  .side { display: flex; flex-direction: column; gap: 22px; font-size: 0.9rem; }
  .side h3 { margin-bottom: 8px; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0 0 10px; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; }
  .sub3 { font-size: 0.95rem; margin: 18px 0 6px; }
  .plain { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
  @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
</style>
