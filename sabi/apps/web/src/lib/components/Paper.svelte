<script lang="ts">
  /** A4 document layout used for on-screen preview and printing. Bilingual Thai/English headings. */
  import { money, qty, fmtAddress, unit } from '$lib/format.ts';
  import Qr from './Qr.svelte';

  let { v, copy = 'original' }: { v: any; copy?: 'original' | 'copy' } = $props();
  const d = $derived(v.document);
  const dt = $derived(v.docType);
  const title = $derived(dt.printTitle ?? dt.label);
  const thDate = (iso: string | undefined) => (iso ? new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(new Date(`${iso}T00:00:00+07:00`)) : '');
  const fullTax = $derived((dt.jurisdiction?.th as any)?.taxDocument === 'full');
  const tpl = (l: any) => {
    const it = l.itemId ? v.items?.[l.itemId] : null;
    return it?.measureTemplate;
  };
</script>

<article class="paper" class:void={d.phase === 'void'} class:draft={d.phase === 'draft'}>
  <header class="top">
    <div class="seller">
      <strong class="co">{v.seller.name}</strong>
      <p>{fmtAddress(v.seller.address)}</p>
      <p>{#if v.seller.phone}โทร {v.seller.phone}{/if}{#if v.seller.email}{' '}· {v.seller.email}{/if}</p>
      {#if v.seller.taxId}<p>เลขประจำตัวผู้เสียภาษี / Tax ID <span class="mono">{v.seller.taxId}</span> · {v.sellerIdentity}</p>{/if}
    </div>
    <div class="title">
      <h1>{title.th ?? title.en}</h1>
      <p class="en">{title.en}</p>
      {#if fullTax && d.phase !== 'draft'}<p class="copy">{copy === 'original' ? 'ต้นฉบับ / Original' : 'สำเนา / Copy'}</p>{/if}
    </div>
  </header>

  <section class="parties">
    <div class="buyer">
      <p class="lbl">{dt.direction === 'sales' ? 'ลูกค้า / Customer' : 'ผู้ขาย / Supplier'}</p>
      <strong>{v.buyer.name}</strong>
      <p>{fmtAddress(v.buyer.address)}</p>
      {#if v.buyer.taxId}<p>เลขประจำตัวผู้เสียภาษี <span class="mono">{v.buyer.taxId}</span>{#if v.buyerIdentity}{' '}· {v.buyerIdentity}{/if}</p>{/if}
      {#if v.buyer.phone}<p>โทร {v.buyer.phone}</p>{/if}
    </div>
    <dl class="meta">
      <dt>เลขที่ / No.</dt><dd class="mono">{d.number ?? 'ร่าง / DRAFT'}</dd>
      <dt>วันที่ / Date</dt><dd>{thDate(d.date)}</dd>
      {#if d.dueDate && !dt.adjusts}<dt>{dt.dueLabel?.th ?? 'ครบกำหนด'} / {dt.dueLabel?.en ?? 'Due'}</dt><dd>{thDate(d.dueDate)}</dd>{/if}
      {#if v.source}<dt>อ้างอิง / Ref.</dt><dd class="mono">{v.source.number}</dd>{/if}
      {#if d.fields?.supplier_ref}<dt>เลขที่ผู้ขาย / Supplier ref.</dt><dd class="mono">{d.fields.supplier_ref}</dd>{/if}
      {#if v.job}<dt>งาน / Job</dt><dd class="mono">{v.job.number}</dd>{/if}
    </dl>
  </section>

  {#if v.noteBasis}
    <section class="basis">
      <p class="lbl">{dt.adjusts === 'credit' ? 'ลดหนี้จาก' : 'เพิ่มหนี้จาก'} / {dt.adjusts === 'credit' ? 'Credit against' : 'Debit against'}</p>
      <dl>
        <dt>ใบกำกับภาษีเดิม / Original tax invoice</dt><dd><span class="mono">{v.noteBasis.sourceNumber}</span> · {thDate(v.noteBasis.sourceDate)}</dd>
        <dt>มูลค่าตามใบกำกับภาษีเดิม / Original value</dt><dd>{money(v.noteBasis.original)}</dd>
        <dt>มูลค่าที่ถูกต้อง / Correct value</dt><dd>{money(v.noteBasis.corrected)}</dd>
        <dt>ผลต่าง / Difference</dt><dd>{money(v.noteBasis.difference)}</dd>
      </dl>
      {#if d.fields?.reason}<p><span class="lbl">เหตุผล / Reason:</span> {d.fields.reason}</p>{/if}
    </section>
  {/if}

  <table class="items">
    <thead>
      <tr><th class="n">ลำดับ<br /><span>No.</span></th><th>รายการ<br /><span>Description</span></th><th class="r">จำนวน<br /><span>Qty</span></th><th>หน่วย<br /><span>Unit</span></th><th class="r">ราคา/หน่วย<br /><span>Unit price</span></th><th class="r">ส่วนลด<br /><span>Disc.</span></th><th class="r">จำนวนเงิน<br /><span>Amount</span></th></tr>
    </thead>
    <tbody>
      {#each d.lines as l, i (l.id)}
        <tr>
          <td class="n">{i + 1}</td>
          <td>{l.description}{#if l.measures && tpl(l)}<br /><span class="sub">{Object.values(l.measures).join(' × ')}</span>{/if}</td>
          <td class="r">{qty(l.qty)}</td>
          <td>{unit(l.uom, 'th')}</td>
          <td class="r">{money(l.unitPrice)}</td>
          <td class="r">{l.discountPct ? `${l.discountPct}%` : ''}</td>
          <td class="r">{money(Math.round(l.qty * l.unitPrice * (1 - (l.discountPct || 0) / 100)))}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <section class="sum">
    <div class="words">
      <p class="lbl">จำนวนเงินตัวอักษร / Amount in words</p>
      <p><strong>({v.words.th})</strong></p>
      <p class="en">{v.words.en}</p>
      {#if d.notes}<p class="lbl notes-l">หมายเหตุ / Notes</p><p class="notes">{d.notes}</p>{/if}
      {#if v.promptpay && v.seller.fields?.promptpay_id}
        <div class="pp">
          <Qr text={v.promptpay} size={112} label="PromptPay" />
          <p>สแกนชำระผ่านพร้อมเพย์<br />Scan to pay (PromptPay)<br /><span class="mono">{v.seller.fields.promptpay_id}</span><br /><strong>฿{money(v.balance)}</strong></p>
        </div>
      {/if}
    </div>
    <dl class="totals">
      {#if d.totals.discount}<dt>ส่วนลด / Discount</dt><dd>{money(d.totals.discount)}</dd>{/if}
      <dt>มูลค่าสินค้า/บริการ / Net</dt><dd>{money(d.totals.net)}</dd>
      {#each d.totals.taxes as t (t.code)}<dt>ภาษีมูลค่าเพิ่ม / VAT {Math.round(t.rate * 100)}%</dt><dd>{money(t.amount)}</dd>{/each}
      <dt class="g">รวมทั้งสิ้น / Total</dt><dd class="g">{money(d.totals.total)}</dd>
      {#if v.retention}
        <dt>หักเงินประกันผลงาน / Less retention</dt><dd>{money(-v.retention.amount)}</dd>
        <dt><strong>ยอดชำระงวดนี้ / Due now</strong></dt><dd><strong>{money(d.totals.total - v.retention.amount)}</strong></dd>
      {/if}
    </dl>
  </section>

  <footer class="sign">
    <div><span class="line"></span><p>{dt.direction === 'sales' ? 'ผู้รับสินค้า / Received by' : 'ผู้ตรวจรับ / Checked by'}</p><p class="date">วันที่ ____/____/______</p></div>
    <div><span class="line"></span><p>ผู้มีอำนาจลงนาม / Authorized signature</p><p class="date">{v.seller.name}</p></div>
  </footer>

  {#if d.phase === 'void'}<div class="stamp">ยกเลิก · CANCELLED</div>{/if}
  {#if d.phase === 'draft'}<div class="stamp draft-stamp">ร่าง · DRAFT</div>{/if}
</article>

<style>
  .paper {
    position: relative; background: white; color: #111; width: 100%; max-width: 210mm; min-height: 280mm; margin: 0 auto;
    padding: 14mm 14mm 12mm; font-family: 'Sarabun', 'IBM Plex Sans Thai', sans-serif; font-size: 13px; line-height: 1.45;
    border: 1px solid var(--line); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); display: flex; flex-direction: column; gap: 14px;
  }
  p { margin: 0; }
  .top { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .co { font-size: 16px; }
  .title { text-align: right; }
  .title h1 { font-size: 22px; font-weight: 700; }
  .en { color: #555; font-size: 12px; }
  .copy { margin-top: 6px; display: inline-block; border: 1px solid #111; padding: 1px 8px; font-size: 12px; }
  .parties { display: grid; grid-template-columns: 1fr auto; gap: 20px; }
  .lbl { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta { display: grid; grid-template-columns: auto auto; gap: 2px 12px; margin: 0; align-content: start; }
  .meta dt { color: #555; }
  .meta dd { margin: 0; text-align: right; }
  .items { width: 100%; border-collapse: collapse; }
  .items th { font-weight: 600; font-size: 12px; text-align: left; border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 5px 6px; line-height: 1.2; }
  .items th span { font-weight: 400; color: #555; font-size: 10.5px; }
  .items td { padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .items .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .items .n { width: 38px; text-align: center; }
  .sub { color: #555; font-size: 11.5px; }
  .sum { display: grid; grid-template-columns: 1fr 260px; gap: 20px; margin-top: 4px; }
  .notes-l { margin-top: 10px; }
  .notes { white-space: pre-wrap; }
  .pp { margin-top: 12px; display: flex; gap: 12px; align-items: center; font-size: 12px; }
  .basis { border: 1px solid #bbb; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .basis dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; margin: 0; }
  .basis dt { color: #444; }
  .basis dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .totals { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; margin: 0; }
  .totals dt { color: #333; }
  .totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .totals .g { font-weight: 700; font-size: 15px; border-top: 1px solid #111; border-bottom: 3px double #111; padding: 4px 0; }
  .sign { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; padding-top: 40px; text-align: center; font-size: 12px; }
  .line { display: block; border-bottom: 1px dotted #111; height: 36px; margin-bottom: 6px; }
  .date { color: #555; }
  .stamp {
    position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%) rotate(-18deg); font-size: 54px; font-weight: 700;
    color: rgba(173, 53, 39, 0.35); border: 6px solid rgba(173, 53, 39, 0.35); padding: 6px 24px; border-radius: 10px; pointer-events: none; white-space: nowrap;
  }
  .draft-stamp { color: rgba(109, 115, 111, 0.25); border-color: rgba(109, 115, 111, 0.25); }
  @media print {
    .paper { border: 0; box-shadow: none; max-width: none; min-height: 270mm; padding: 0; }
  }
</style>
