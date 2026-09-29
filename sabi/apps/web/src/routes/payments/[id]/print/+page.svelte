<script lang="ts">
  /**
   * Receipt (money in) or payment voucher (money out), and — when we withheld tax —
   * the withholding tax certificate (หนังสือรับรองการหักภาษี ณ ที่จ่าย, s.50 bis) in two copies.
   */
  import { page } from '$app/state';
  import { get } from '$lib/api.ts';
  import { money, fmtAddress } from '$lib/format.ts';

  let v = $state<any>(null);
  let error = $state('');
  $effect(() => {
    get(`payments/${page.params.id}`)
      .then(async (x) => {
        v = x;
        document.title = `${x.payment.number} · ${x.party?.name ?? ''}`;
        await document.fonts?.ready;
      })
      .catch((e) => (error = e.message));
  });
  const thDate = (iso: string | undefined) => (iso ? new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(new Date(`${iso}T00:00:00+07:00`)) : '');
  const title = $derived(!v ? null : v.refund
    ? { th: v.payment.direction === 'out' ? 'ใบสำคัญจ่ายคืนเงิน' : 'ใบรับเงินคืน', en: v.payment.direction === 'out' ? 'Refund voucher' : 'Refund receipt' }
    : v.payment.direction === 'in' ? { th: 'ใบเสร็จรับเงิน', en: 'Receipt' } : { th: 'ใบสำคัญจ่าย', en: 'Payment voucher' });
  const forms = ['ภ.ง.ด.1ก', 'ภ.ง.ด.1ก พิเศษ', 'ภ.ง.ด.2', 'ภ.ง.ด.3', 'ภ.ง.ด.2ก', 'ภ.ง.ด.3ก', 'ภ.ง.ด.53'];
  const formOf = (f: string | null) => (f === 'PND3' ? 'ภ.ง.ด.3' : f === 'PND53' ? 'ภ.ง.ด.53' : '');
  const tid = (t: string) => (t || '').replace(/^(\d)(\d{4})(\d{5})(\d{2})(\d)$/, '$1-$2-$3-$4-$5');
</script>

{#if error}<p style="padding:2rem">{error}</p>{/if}
{#if v}
  <div class="noprint bar">
    <button class="btn primary" onclick={() => window.print()}>Print / พิมพ์</button>
    {#if v.allocations[0]}<a class="btn ghost" href={`/documents/${v.allocations[0].documentId}`}>← Back</a>{/if}
    {#if v.payment.voided}<span class="text-danger small">VOID / ยกเลิกแล้ว</span>{/if}
  </div>

  <div class="sheet">
    <article class="paper" class:void={v.payment.voided}>
      <header class="top">
        <div>
          <strong class="co">{v.seller.name}</strong>
          <p>{fmtAddress(v.seller.address)}</p>
          {#if v.seller.taxId}<p>เลขประจำตัวผู้เสียภาษี / Tax ID <span class="mono">{v.seller.taxId}</span> · {v.seller.branch === '00000' || !v.seller.branch ? 'สำนักงานใหญ่' : `สาขา ${v.seller.branch}`}</p>{/if}
        </div>
        <div class="title"><h1>{title!.th}</h1><p class="en">{title!.en}</p></div>
      </header>
      <section class="parties">
        <div>
          <p class="lbl">{v.payment.direction === 'in' ? 'ได้รับเงินจาก / Received from' : 'จ่ายให้ / Paid to'}</p>
          <strong>{v.buyer?.name}</strong>
          <p>{fmtAddress(v.buyer?.address)}</p>
          {#if v.buyer?.taxId}<p>เลขประจำตัวผู้เสียภาษี <span class="mono">{v.buyer.taxId}</span>{#if v.buyer.branch}{' '}· {v.buyer.branch === '00000' ? 'สำนักงานใหญ่' : `สาขา ${v.buyer.branch}`}{/if}</p>{/if}
        </div>
        <dl class="meta">
          <dt>เลขที่ / No.</dt><dd class="mono">{v.payment.number}</dd>
          <dt>วันที่ / Date</dt><dd>{thDate(v.payment.date)}</dd>
          <dt>วิธีชำระ / Method</dt><dd>{v.method.th ?? v.method.en}</dd>
          {#if v.payment.reference}<dt>อ้างอิง / Ref.</dt><dd>{v.payment.reference}</dd>{/if}
        </dl>
      </section>
      <table class="items">
        <thead><tr><th>เอกสาร<br /><span>Document</span></th><th>วันที่<br /><span>Date</span></th><th class="r">ยอดเอกสาร<br /><span>Document total</span></th><th class="r">ชำระครั้งนี้<br /><span>Settled</span></th></tr></thead>
        <tbody>
          {#each v.allocations as a (a.documentId)}
            <tr><td>{a.typeLabel?.th ?? ''} <span class="mono">{a.number}</span></td><td>{thDate(a.date)}</td><td class="r">{money(a.total)}</td><td class="r">{money(a.amount)}</td></tr>
          {/each}
        </tbody>
      </table>
      <section class="sum">
        <div>
          <p class="lbl">จำนวนเงินตัวอักษร / Amount in words</p>
          <p><strong>({v.words.th})</strong></p>
          <p class="en">{v.words.en}</p>
        </div>
        <dl class="totals">
          <dt>ยอดที่ตัดชำระ / Settled</dt><dd>{money(v.payment.amount + v.payment.whtAmount)}</dd>
          {#if v.payment.whtAmount}<dt>ภาษีหัก ณ ที่จ่าย / WHT</dt><dd>{money(-v.payment.whtAmount)}</dd>{/if}
          <dt class="g">{v.payment.direction === 'in' ? 'รับเงินสุทธิ / Received' : 'จ่ายเงินสุทธิ / Paid'}</dt><dd class="g">{money(v.payment.amount)}</dd>
        </dl>
      </section>
      <footer class="sign">
        <div><span class="line"></span><p>{v.payment.direction === 'in' ? 'ผู้จ่ายเงิน / Payer' : 'ผู้รับเงิน / Payee'}</p></div>
        <div><span class="line"></span><p>{v.payment.direction === 'in' ? 'ผู้รับเงิน / Received by' : 'ผู้จ่ายเงิน / Paid by'}</p><p class="date">{v.createdBy}</p></div>
      </footer>
      {#if v.payment.voided}<div class="stamp">ยกเลิก · VOID</div>{/if}
    </article>
  </div>

  {#if v.wht?.weIssue}
    {#each ['ฉบับที่ 1 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการภาษี)', 'ฉบับที่ 2 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย เก็บไว้เป็นหลักฐาน)'] as copy (copy)}
      <div class="sheet">
        <article class="paper cert">
          <p class="copyline">{copy}</p>
          <header class="certhead">
            <h1>หนังสือรับรองการหักภาษี ณ ที่จ่าย</h1>
            <p>ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร</p>
            <p class="bookno">เลขที่ <span class="mono">{v.wht.certificate ?? v.payment.number}</span></p>
          </header>
          <section class="box">
            <p class="lbl">ผู้มีหน้าที่หักภาษี ณ ที่จ่าย</p>
            <p><strong>{v.wht.payer.name}</strong> <span class="right">เลขประจำตัวผู้เสียภาษีอากร <span class="mono">{tid(v.wht.payer.taxId)}</span></span></p>
            <p>ที่อยู่ {fmtAddress(v.wht.payer.address)}</p>
          </section>
          <section class="box">
            <p class="lbl">ผู้ถูกหักภาษี ณ ที่จ่าย</p>
            <p><strong>{v.wht.payee.name}</strong> <span class="right">เลขประจำตัวผู้เสียภาษีอากร <span class="mono">{tid(v.wht.payee.taxId)}</span></span></p>
            <p>ที่อยู่ {fmtAddress(v.wht.payee.address)}</p>
          </section>
          <section class="forms">
            <span class="lbl">ลำดับที่ ______ ในแบบ</span>
            {#each forms as f (f)}<span class="cb"><span class="box-i">{formOf(v.wht.form) === f ? '✓' : ''}</span>{f}</span>{/each}
          </section>
          <table class="items">
            <thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th>วัน เดือน หรือปีภาษี ที่จ่าย</th><th class="r">จำนวนเงินที่จ่าย</th><th class="r">ภาษีที่หัก และนำส่งไว้</th></tr></thead>
            <tbody>
              <tr><td>{v.wht.label?.th ?? v.wht.category ?? 'อื่น ๆ'}</td><td>{thDate(v.payment.date)}</td><td class="r">{money(v.wht.base)}</td><td class="r">{money(v.wht.amount)}</td></tr>
            </tbody>
            <tfoot><tr><td colspan="2" class="r"><strong>รวมเงินที่จ่ายและภาษีที่หักนำส่ง</strong></td><td class="r"><strong>{money(v.wht.base)}</strong></td><td class="r"><strong>{money(v.wht.amount)}</strong></td></tr></tfoot>
          </table>
          <p>รวมเงินภาษีที่หักนำส่ง (ตัวอักษร) <strong>({v.wht.words})</strong></p>
          <section class="forms">
            <span class="lbl">ผู้จ่ายเงิน</span>
            <span class="cb"><span class="box-i">✓</span>หัก ณ ที่จ่าย</span>
            <span class="cb"><span class="box-i"></span>ออกให้ตลอดไป</span>
            <span class="cb"><span class="box-i"></span>ออกให้ครั้งเดียว</span>
            <span class="cb"><span class="box-i"></span>อื่น ๆ</span>
          </section>
          <footer class="certsign">
            <p>ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ</p>
            <span class="line"></span>
            <p>ลงชื่อ ผู้จ่ายเงิน · {thDate(v.payment.date)}</p>
          </footer>
          <p class="tiny">Layout follows the Revenue Department's 50 bis certificate; check it against the current official form before first use.</p>
        </article>
      </div>
    {/each}
  {/if}
{/if}

<style>
  :global(body) { background: var(--sunken); }
  .bar { position: sticky; top: 0; padding: 10px 16px; display: flex; gap: 8px; align-items: center; background: var(--surface); border-bottom: 1px solid var(--line); z-index: 1; }
  .sheet { margin: 20px auto; width: fit-content; }
  .paper {
    position: relative; background: white; color: #111; width: 210mm; min-height: 148mm; padding: 12mm 14mm;
    font-family: 'Sarabun', 'IBM Plex Sans Thai', sans-serif; font-size: 13px; line-height: 1.45; border: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 12px;
  }
  .cert { min-height: 280mm; }
  p { margin: 0; }
  .top { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #111; padding-bottom: 8px; }
  .co { font-size: 16px; }
  .title { text-align: right; }
  .title h1 { font-size: 22px; font-weight: 700; }
  .en { color: #555; font-size: 12px; }
  .parties { display: grid; grid-template-columns: 1fr auto; gap: 20px; }
  .lbl { font-size: 11px; color: #555; }
  .meta { display: grid; grid-template-columns: auto auto; gap: 2px 12px; margin: 0; }
  .meta dt { color: #555; }
  .meta dd { margin: 0; text-align: right; }
  .items { width: 100%; border-collapse: collapse; }
  .items th { font-weight: 600; font-size: 12px; text-align: left; border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 5px 6px; line-height: 1.2; }
  .items th span { font-weight: 400; color: #555; font-size: 10.5px; }
  .items td { padding: 5px 6px; border-bottom: 1px solid #ddd; }
  .items .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sum { display: grid; grid-template-columns: 1fr 250px; gap: 20px; }
  .totals { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; margin: 0; }
  .totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .totals .g { font-weight: 700; border-top: 1px solid #111; border-bottom: 3px double #111; padding: 3px 0; }
  .sign { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; text-align: center; font-size: 12px; padding-top: 24px; }
  .line { display: block; border-bottom: 1px dotted #111; height: 32px; margin-bottom: 6px; }
  .date { color: #555; }
  .stamp { position: absolute; top: 45%; left: 50%; transform: translate(-50%, -50%) rotate(-15deg); font-size: 48px; font-weight: 700; color: rgba(173, 53, 39, 0.35); border: 5px solid rgba(173, 53, 39, 0.35); padding: 4px 20px; border-radius: 10px; }
  .copyline { text-align: right; font-size: 11px; }
  .certhead { text-align: center; }
  .certhead h1 { font-size: 19px; font-weight: 700; }
  .bookno { text-align: right; }
  .box { border: 1px solid #111; padding: 6px 10px; display: flex; flex-direction: column; gap: 2px; }
  .right { float: right; }
  .forms { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; }
  .cb { display: inline-flex; gap: 5px; align-items: center; }
  .box-i { display: inline-flex; width: 13px; height: 13px; border: 1px solid #111; font-size: 11px; align-items: center; justify-content: center; }
  .certsign { margin-top: auto; text-align: center; display: flex; flex-direction: column; gap: 4px; }
  .certsign .line { width: 260px; margin: 18px auto 4px; }
  .tiny { color: #888; font-size: 10px; }
  @media print {
    :global(body) { background: white; }
    .noprint { display: none !important; }
    .sheet { margin: 0; break-after: page; }
    .sheet:last-child { break-after: auto; }
    .paper { border: 0; }
  }
</style>
