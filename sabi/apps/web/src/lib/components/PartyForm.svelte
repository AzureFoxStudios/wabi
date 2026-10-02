<script lang="ts">
  /** Create / edit a customer, supplier or contact. Jurisdiction + pack fields are appended from config. */
  import { command, ApiError } from '$lib/api.ts';
  import { app, T, toast } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';

  let { party = null, parentId = undefined, defaultRole = 'customer', onsaved, oncancel }: {
    party?: any; parentId?: string; defaultRole?: string; onsaved: (id: string) => void; oncancel?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const init = party ?? {};
  // svelte-ignore state_referenced_locally
  let f = $state({
    kind: init.kind ?? (parentId ? 'person' : 'organization'), name: init.name ?? '', roles: init.roles ?? (parentId ? ['contact'] : [defaultRole]),
    taxId: init.taxId ?? '', phone: init.phone ?? '', email: init.email ?? '',
    address: { line1: '', line2: '', district: '', province: '', postcode: '', ...(init.address ?? {}) },
    paymentTermsDays: init.paymentTermsDays ?? '', fields: { ...(init.fields ?? {}) } as Record<string, any>,
  });
  const extra = $derived([...app.boot.jurisdiction.partyFields, ...app.boot.pack.partyFields]);
  let busy = $state(false);
  let fieldErr = $state<Record<string, string>>({});
  const roleOpts = [
    { id: 'customer', label: T('Customer', 'ลูกค้า') }, { id: 'supplier', label: T('Supplier', 'ผู้ขาย') }, { id: 'contact', label: T('Contact person', 'ผู้ติดต่อ') },
  ];
  function toggle(r: string) {
    f.roles = f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r];
  }
  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    fieldErr = {};
    try {
      const body = { ...f, paymentTermsDays: f.paymentTermsDays === '' ? undefined : Number(f.paymentTermsDays), taxId: f.taxId || undefined };
      const r = party ? await command('party.update', { id: party.id, ...body }) : await command('party.create', { ...body, parentId });
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
  <div class="row wrap">
    <label class="row small"><input type="radio" bind:group={f.kind} value="organization" /> {T('Company / shop', 'บริษัท/ร้านค้า')}</label>
    <label class="row small"><input type="radio" bind:group={f.kind} value="person" /> {T('Individual', 'บุคคลธรรมดา')}</label>
  </div>
  <!-- svelte-ignore a11y_autofocus -->
  <label class="field"><span>{T('Name', 'ชื่อ')} *</span><input bind:value={f.name} required autofocus /></label>
  {#if !parentId}
    <div class="row wrap">{#each roleOpts as r (r.id)}<label class="row small"><input type="checkbox" checked={f.roles.includes(r.id)} onchange={() => toggle(r.id)} /> {r.label}</label>{/each}</div>
  {/if}
  <div class="grid2">
    <label class="field"><span>{T('Phone', 'โทรศัพท์')}</span><input bind:value={f.phone} inputmode="tel" /></label>
    <label class="field"><span>{T('Email', 'อีเมล')}</span><input bind:value={f.email} type="email" /></label>
  </div>
  {#if !parentId}
    <div class="grid2">
      <label class="field" class:invalid={fieldErr.taxId}><span>{T('Tax ID (13 digits)', 'เลขประจำตัวผู้เสียภาษี (13 หลัก)')}</span><input bind:value={f.taxId} inputmode="numeric" maxlength="17" class="mono" />{#if fieldErr.taxId}<small class="err-text">{fieldErr.taxId}</small>{/if}</label>
      <label class="field"><span>{T('Payment terms (days)', 'เครดิต (วัน)')}</span><input bind:value={f.paymentTermsDays} type="number" min="0" /></label>
    </div>
    <fieldset class="stack">
      <legend class="eyebrow">{T('Address (printed on documents)', 'ที่อยู่ (พิมพ์บนเอกสาร)')}</legend>
      <input bind:value={f.address.line1} placeholder={T('House no., street, sub-district', 'เลขที่ ถนน ตำบล/แขวง')} />
      <div class="grid3">
        <input bind:value={f.address.district} placeholder={T('District', 'อำเภอ/เขต')} />
        <input bind:value={f.address.province} placeholder={T('Province', 'จังหวัด')} />
        <input bind:value={f.address.postcode} placeholder={T('Postcode', 'รหัสไปรษณีย์')} inputmode="numeric" />
      </div>
    </fieldset>
    {#if extra.length}
      <div class="grid2">
        {#each extra as x (x.key)}
          <label class="field"><span>{L(x.label)}</span>
            {#if x.type === 'boolean'}<input type="checkbox" bind:checked={f.fields[x.key]} />
            {:else if x.type === 'select'}<select bind:value={f.fields[x.key]}><option value="">—</option>{#each x.options as o (o.value)}<option value={o.value}>{L(o.label)}</option>{/each}</select>
            {:else}<input bind:value={f.fields[x.key]} placeholder={L(x.placeholder)} />{/if}
          </label>
        {/each}
      </div>
    {/if}
  {/if}
  <div class="row">
    <button class="btn primary" disabled={busy || !f.name.trim()}>{party ? T('Save', 'บันทึก') : T('Create', 'สร้าง')}</button>
    {#if oncancel}<button type="button" class="btn ghost" onclick={oncancel}>{T('Cancel', 'ยกเลิก')}</button>{/if}
  </div>
</form>

<style>
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 120px; gap: 8px; }
  fieldset { border: 0; padding: 0; margin: 0; }
  .invalid input { border-color: var(--danger); }
</style>
