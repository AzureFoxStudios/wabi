<script lang="ts">
  /** Create / edit a product or service. Prices entered in baht, stored in satang. */
  import { command, ApiError } from '$lib/api.ts';
  import { app, T, toast } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';

  let { item = null, onsaved, oncancel }: { item?: any; onsaved: (id: string) => void; oncancel?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const i0 = item ?? {};
  const jur = app.boot.jurisdiction;
  const pack = app.boot.pack;
  let f = $state({
    sku: i0.sku ?? '', name: i0.name ?? '', kind: i0.kind ?? 'stock', uom: i0.uom ?? pack.units[0]?.id ?? 'pc',
    salePrice: i0.salePrice !== undefined ? i0.salePrice / 100 : '', costPrice: i0.costPrice !== undefined ? i0.costPrice / 100 : '',
    taxCode: i0.taxCode ?? jur.defaultTaxCode, whtCategory: i0.whtCategory ?? '', measureTemplate: i0.measureTemplate ?? '',
    fields: { ...(i0.fields ?? {}) } as Record<string, any>,
  });
  let busy = $state(false);
  let fieldErr = $state<Record<string, string>>({});
  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    fieldErr = {};
    try {
      const body = {
        ...f, salePrice: Math.round(Number(f.salePrice || 0) * 100), costPrice: Math.round(Number(f.costPrice || 0) * 100),
        whtCategory: f.whtCategory || null, measureTemplate: f.measureTemplate || null,
      };
      const r = item ? await command('item.update', { id: item.id, ...body }) : await command('item.create', body);
      toast(T('Saved', 'บันทึกแล้ว'), 'success');
      onsaved(r.id);
    } catch (err) {
      if (err instanceof ApiError && err.details?.field) fieldErr = { [err.details.field]: err.message };
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
</script>

<form class="stack" onsubmit={submit}>
  <div class="g2">
    <!-- svelte-ignore a11y_autofocus -->
    <label class="field"><span>{T('Code / SKU', 'รหัสสินค้า')} *</span><input bind:value={f.sku} required class="mono" autofocus={!item} />{#if fieldErr.sku}<small class="err-text">{fieldErr.sku}</small>{/if}</label>
    <label class="field"><span>{T('Kind', 'ประเภท')}</span>
      <select bind:value={f.kind}><option value="stock">{T('Stocked product', 'สินค้าที่นับสต็อก')}</option><option value="non_stock">{T('Product, not stocked', 'สินค้าไม่นับสต็อก')}</option><option value="service">{T('Service', 'บริการ')}</option></select></label>
  </div>
  <label class="field"><span>{T('Name (as printed)', 'ชื่อ (ที่พิมพ์บนเอกสาร)')} *</span><input bind:value={f.name} required /></label>
  <div class="g3">
    <label class="field"><span>{T('Unit', 'หน่วย')}</span><select bind:value={f.uom}>{#each pack.units as u (u.id)}<option value={u.id}>{L(u.label)}</option>{/each}</select></label>
    <label class="field"><span>{T('Sale price ฿', 'ราคาขาย ฿')}</span><input type="number" step="0.01" min="0" bind:value={f.salePrice} class="num" /></label>
    <label class="field"><span>{T('Cost ฿', 'ต้นทุน ฿')}</span><input type="number" step="0.01" min="0" bind:value={f.costPrice} class="num" /></label>
  </div>
  <div class="g3">
    <label class="field"><span>{T('Tax', 'ภาษี')}</span><select bind:value={f.taxCode}>{#each jur.taxCodes as t (t.code)}<option value={t.code}>{L(t.label)}</option>{/each}</select></label>
    <label class="field"><span>{T('Withholding when sold', 'ภาษีหัก ณ ที่จ่ายเมื่อขาย')}</span><select bind:value={f.whtCategory}><option value="">—</option>{#each jur.whtCategories as w (w.id)}<option value={w.id}>{L(w.label)}</option>{/each}</select></label>
    <label class="field"><span>{T('Quantity from measurements', 'คำนวณจำนวนจากขนาด')}</span><select bind:value={f.measureTemplate}><option value="">{T('No — enter quantity', 'ไม่ใช้ (ใส่จำนวนเอง)')}</option>{#each pack.measureTemplates as m (m.id)}<option value={m.id}>{L(m.label)}</option>{/each}</select></label>
  </div>
  {#if pack.itemFields.length}
    <div class="g3">
      {#each pack.itemFields as x (x.key)}
        <label class="field"><span>{L(x.label)}{x.unit ? ` (${x.unit})` : ''}</span>
          {#if x.type === 'select'}<select bind:value={f.fields[x.key]}><option value="">—</option>{#each x.options as o (o.value)}<option value={o.value}>{L(o.label)}</option>{/each}</select>
          {:else if x.type === 'number'}<input type="number" step="any" bind:value={f.fields[x.key]} />
          {:else}<input bind:value={f.fields[x.key]} />{/if}
        </label>
      {/each}
    </div>
  {/if}
  <div class="row">
    <button class="btn primary" disabled={busy}>{item ? T('Save', 'บันทึก') : T('Create', 'สร้าง')}</button>
    {#if oncancel}<button type="button" class="btn ghost" onclick={oncancel}>{T('Cancel', 'ยกเลิก')}</button>{/if}
  </div>
</form>

<style>
  .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .g3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  @media (max-width: 700px) { .g2, .g3 { grid-template-columns: 1fr; } }
</style>
