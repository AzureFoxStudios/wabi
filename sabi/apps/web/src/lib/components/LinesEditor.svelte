<script lang="ts">
  import { untrack } from 'svelte';
  /**
   * Line editor for draft documents. Quantities can come from a measure
   * template (e.g. pieces × length); totals are previewed with the same core
   * function the server uses, and the server recomputes on save.
   */
  import { computeTotals, measuredQty } from '@sabi/core';
  import { app, T } from '$lib/state.svelte.ts';
  import { L, money, qty as fq, unit } from '$lib/format.ts';
  import Picker from './Picker.svelte';

  let {
    lines = $bindable(), priceMode, date, direction, readonly = false, items = {},
  }: { lines: any[]; priceMode: 'exclusive' | 'inclusive'; date: string; direction: 'sales' | 'purchase'; readonly?: boolean; items?: Record<string, any> } = $props();

  const taxCodes = $derived(app.boot.jurisdiction.taxCodes);
  const rateOf = (code: string, d: string) => {
    const def = taxCodes.find((t: any) => t.code === code);
    return def?.rates.find((x: any) => d >= x.from && (!x.to || d <= x.to))?.rate ?? 0;
  };
  const templates = $derived(app.boot.pack.measureTemplates);
  let itemCache = $state<Record<string, any>>({});
  $effect(() => {
    const incoming = items;
    untrack(() => (itemCache = { ...incoming, ...itemCache }));
  });
  const tplOf = (l: any) => {
    const it = l.itemId ? itemCache[l.itemId] : null;
    return it?.measureTemplate ? templates.find((t: any) => t.id === it.measureTemplate) : null;
  };
  const totals = $derived(computeTotals(lines.map((l) => ({ ...l, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0, discountPct: Number(l.discountPct) || 0 })), priceMode, date, rateOf));
  const lineTotal = (l: any) => Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 - (Number(l.discountPct) || 0) / 100));

  function add() {
    lines.push({ id: undefined, itemId: undefined, description: '', qty: 1, uom: 'pc', unitPrice: 0, discountPct: 0, taxCode: app.boot.jurisdiction.defaultTaxCode, measures: undefined });
  }
  function pickItem(i: number, it: any) {
    itemCache[it.id] = it;
    const l = lines[i];
    l.itemId = it.id;
    l.description = it.name;
    l.uom = it.uom;
    l.unitPrice = direction === 'sales' ? it.salePrice : it.costPrice;
    l.taxCode = it.taxCode;
    l.itemKind = it.kind;
    l.whtCategory = it.whtCategory;
    const tpl = it.measureTemplate ? templates.find((t: any) => t.id === it.measureTemplate) : null;
    l.measures = tpl ? Object.fromEntries(tpl.inputs.map((inp: any) => [inp.key, undefined])) : undefined;
  }
  function measureChanged(l: any) {
    const tpl = tplOf(l);
    if (!tpl || !l.measures) return;
    const vals: Record<string, number> = {};
    for (const inp of tpl.inputs) {
      const v = Number(l.measures[inp.key]);
      if (!Number.isFinite(v) || l.measures[inp.key] === '' || l.measures[inp.key] === undefined) return;
      vals[inp.key] = v;
    }
    l.qty = Math.round(measuredQty(tpl, vals) * 1000) / 1000;
  }
  const baht = (minor: number) => (minor / 100).toString();
  function setPrice(l: any, v: string) {
    const n = Number(v.replace(/,/g, ''));
    l.unitPrice = Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
</script>

<div class="lines">
  <table class="data editor">
    <thead>
      <tr>
        <th class="c-n">#</th>
        <th>{T('Item / description', 'รายการ')}</th>
        <th class="num c-q">{T('Qty', 'จำนวน')}</th>
        <th class="c-u">{T('Unit', 'หน่วย')}</th>
        <th class="num c-p">{T('Unit price', 'ราคา/หน่วย')}</th>
        <th class="num c-d">{T('Disc. %', 'ส่วนลด %')}</th>
        <th class="c-t">{T('Tax', 'ภาษี')}</th>
        <th class="num c-a">{T('Amount', 'จำนวนเงิน')}</th>
        {#if !readonly}<th class="c-x"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each lines as l, i (i)}
        {@const tpl = tplOf(l)}
        <tr>
          <td class="c-n muted">{i + 1}</td>
          <td>
            {#if readonly}
              {l.description}
              {#if l.measures && tpl}<br /><span class="tiny muted">{tpl.inputs.map((inp: any) => `${l.measures[inp.key]}${inp.unit ? ' ' + inp.unit : ''}`).join(' × ')}</span>{/if}
            {:else}
              {#if !l.itemId}
                <Picker kind="items" placeholder={T('Pick an item, or type a description below', 'เลือกสินค้า หรือพิมพ์รายละเอียดด้านล่าง')} onpick={(it) => pickItem(i, it)} />
              {/if}
              <input class="desc" bind:value={l.description} placeholder={T('Description', 'รายละเอียด')} aria-label={T('Description', 'รายละเอียด')} />
              {#if tpl && l.measures}
                <div class="measures">
                  {#each tpl.inputs as inp, k (inp.key)}
                    {#if k > 0}<span class="muted">×</span>{/if}
                    <label class="m"><input type="number" step={inp.step ?? 'any'} min="0" bind:value={l.measures[inp.key]} oninput={() => measureChanged(l)} aria-label={L(inp.label)} /><span class="tiny muted">{L(inp.label)}{inp.unit ? ` (${inp.unit})` : ''}</span></label>
                  {/each}
                </div>
              {/if}
            {/if}
          </td>
          <td class="num c-q">{#if readonly}{fq(l.qty)}{:else}<input class="num" type="number" step="any" min="0" bind:value={l.qty} readonly={!!(tpl && l.measures && Object.values(l.measures).every((v) => v !== undefined && v !== ''))} />{/if}</td>
          <td class="c-u">{#if readonly}{unit(l.uom)}{:else}<input bind:value={l.uom} />{/if}</td>
          <td class="num c-p">{#if readonly}{money(l.unitPrice)}{:else}<input class="num" inputmode="decimal" value={baht(l.unitPrice)} onchange={(e) => setPrice(l, (e.target as HTMLInputElement).value)} />{/if}</td>
          <td class="num c-d">{#if readonly}{l.discountPct || ''}{:else}<input class="num" type="number" step="any" min="0" max="100" bind:value={l.discountPct} />{/if}</td>
          <td class="c-t">{#if readonly || (l.itemId && app.boot.pack.taxCodeFromItem)}<span class="small" title={readonly ? undefined : T('Set on the item', 'กำหนดที่สินค้า')}>{l.taxCode}</span>{:else}<select bind:value={l.taxCode}>{#each taxCodes as t (t.code)}<option value={t.code}>{t.code}</option>{/each}</select>{/if}</td>
          <td class="num c-a">{money(lineTotal(l))}</td>
          {#if !readonly}<td class="c-x"><button class="btn ghost sm" onclick={() => lines.splice(i, 1)} aria-label={T('Remove line', 'ลบรายการ')}>✕</button></td>{/if}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !readonly}<button class="btn sm" onclick={add}>+ {T('Add line', 'เพิ่มรายการ')}</button>{/if}

  <dl class="totals num">
    {#if totals.discount}<dt>{T('Before discount', 'ก่อนส่วนลด')}</dt><dd>{money(totals.gross)}</dd><dt>{T('Discount', 'ส่วนลด')}</dt><dd>−{money(totals.discount)}</dd>{/if}
    <dt>{T('Net', 'มูลค่าก่อนภาษี')}</dt><dd>{money(totals.net)}</dd>
    {#each totals.taxes.filter((t) => t.amount) as t (t.code)}<dt>{T('VAT', 'ภาษีมูลค่าเพิ่ม')} {Math.round(t.rate * 100)}%</dt><dd>{money(t.amount)}</dd>{/each}
    <dt class="grand">{T('Total', 'รวมทั้งสิ้น')}</dt><dd class="grand">฿{money(totals.total)}</dd>
  </dl>
  {#if priceMode === 'inclusive'}<p class="tiny muted right">{T('Prices include VAT', 'ราคารวมภาษีมูลค่าเพิ่มแล้ว')}</p>{/if}
</div>

<style>
  .editor td { vertical-align: top; }
  .editor input, .editor select { min-height: 30px; padding: 3px 6px; font-size: 0.88rem; }
  .desc { margin-top: 4px; }
  .c-n { width: 28px; }
  .c-q { width: 90px; }
  .c-u { width: 70px; }
  .c-p { width: 110px; }
  .c-d { width: 70px; }
  .c-t { width: 88px; }
  .c-a { width: 110px; padding-top: 12px !important; }
  .c-x { width: 36px; }
  .measures { display: flex; align-items: flex-start; gap: 4px; margin-top: 6px; }
  .measures > .muted { padding-top: 6px; }
  .m { display: flex; flex-direction: column; width: 72px; }
  .totals { display: grid; grid-template-columns: 1fr 140px; gap: 4px 16px; width: min(360px, 100%); margin: 16px 0 0 auto; }
  .totals dt { color: var(--muted); text-align: right; }
  .totals dd { margin: 0; text-align: right; }
  .grand { font-weight: 600; font-size: 1.1rem; color: var(--ink) !important; border-top: 1px solid var(--line-strong); padding-top: 6px; }
</style>
