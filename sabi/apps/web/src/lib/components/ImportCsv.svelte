<script lang="ts">
  /**
   * Bring existing customer/supplier and item lists in from a spreadsheet (CSV).
   * The browser parses and maps columns; the server runs every row through the
   * ordinary create command, all-or-nothing, and reports problems per row.
   */
  import { command, ApiError } from '$lib/api.ts';
  import { app, T, toast, can } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';

  type Kind = 'parties' | 'items';
  let kind = $state<Kind>(can('parties.write') ? 'parties' : 'items');
  let fileName = $state('');
  let header = $state<string[]>([]);
  let rows = $state<string[][]>([]);
  let errors = $state<{ row: number; message: string }[]>([]);
  let busy = $state(false);
  let done = $state<string | null>(null);

  const extra = $derived([...app.boot.jurisdiction.partyFields, ...app.boot.pack.partyFields] as { key: string; label: any; type: string }[]);

  // Known columns. Headers are matched case-insensitively, ignoring spaces/underscores; Thai aliases accepted.
  const partyCols: [string, string[]][] = [
    ['name', ['name', 'ชื่อ']], ['kind', ['kind', 'type', 'ประเภท']], ['roles', ['roles', 'role', 'บทบาท']],
    ['taxId', ['taxid', 'tax', 'เลขประจำตัวผู้เสียภาษี', 'เลขผู้เสียภาษี']], ['phone', ['phone', 'tel', 'โทร', 'โทรศัพท์']],
    ['email', ['email', 'อีเมล']], ['line1', ['address', 'addressline1', 'line1', 'ที่อยู่']], ['line2', ['addressline2', 'line2']],
    ['district', ['district', 'อำเภอ', 'เขต']], ['province', ['province', 'จังหวัด']], ['postcode', ['postcode', 'zip', 'รหัสไปรษณีย์']],
    ['paymentTermsDays', ['paymenttermsdays', 'terms', 'credit days', 'เครดิต']], ['creditLimit', ['creditlimit', 'วงเงิน']],
  ];
  const itemCols: [string, string[]][] = [
    ['sku', ['sku', 'code', 'รหัส', 'รหัสสินค้า']], ['name', ['name', 'ชื่อ', 'ชื่อสินค้า']], ['kind', ['kind', 'type', 'ประเภท']],
    ['uom', ['uom', 'unit', 'หน่วย']], ['salePrice', ['saleprice', 'price', 'ราคาขาย']], ['costPrice', ['costprice', 'cost', 'ราคาทุน']],
    ['taxCode', ['taxcode', 'vat']], ['whtCategory', ['whtcategory', 'wht']], ['reorderPoint', ['reorderpoint', 'reorder', 'จุดสั่งซื้อ']],
  ];
  const norm = (h: string) => h.toLowerCase().replace(/[\s_\-.]/g, '');
  const cols = $derived(kind === 'parties' ? [...partyCols, ...extra.map((f) => [`fields.${f.key}`, [f.key, L(f.label)]] as [string, string[]])] : itemCols);
  const mapping = $derived(header.map((h) => cols.find(([, aliases]) => aliases.some((a) => norm(a) === norm(h)))?.[0] ?? null));
  const unknown = $derived(header.filter((_, i) => !mapping[i]));
  const required = $derived(kind === 'parties' ? ['name'] : ['sku', 'name']);
  const missing = $derived(required.filter((r) => !mapping.includes(r)));

  /** RFC 4180-ish: quotes, doubled quotes, commas/newlines inside quotes; also accepts ; or tab separators. */
  function parse(text: string): string[][] {
    text = text.replace(/^\ufeff/, '');
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const out: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) row.push(cell), (cell = '');
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell), out.push(row), (row = []), (cell = '');
      } else cell += c;
    }
    if (cell !== '' || row.length) row.push(cell), out.push(row);
    return out.filter((r) => r.some((c) => c.trim() !== ''));
  }

  async function pickFile(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    if (!f) return;
    el.value = ''; // so picking the same (fixed) file again fires change
    fileName = f.name;
    const all = parse(await f.text());
    header = (all[0] ?? []).map((h) => h.trim());
    rows = all.slice(1);
    errors = [];
    done = null;
  }

  const money = (v: string) => (v.trim() === '' ? undefined : Math.round(Number(v.replace(/[,฿\s]/g, '')) * 100));
  const numOrUndef = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(/[,\s]/g, '')));
  const personWords = ['person', 'individual', 'บุคคล', 'บุคคลธรรมดา'];
  const roleWords: Record<string, string> = { customer: 'customer', ลูกค้า: 'customer', supplier: 'supplier', vendor: 'supplier', ผู้ขาย: 'supplier', ผู้จำหน่าย: 'supplier', subcontractor: 'subcontractor', ผู้รับเหมาช่วง: 'subcontractor' };

  function toRecord(r: string[]): Record<string, unknown> {
    const rec: Record<string, any> = {};
    const addr: Record<string, string> = {};
    const fields: Record<string, unknown> = {};
    mapping.forEach((m, i) => {
      const v = (r[i] ?? '').trim();
      if (!m || v === '') return;
      if (m.startsWith('fields.')) {
        const f = extra.find((x) => `fields.${x.key}` === m);
        fields[m.slice(7)] = f?.type === 'boolean' ? /^(1|y|yes|true|ใช่)$/i.test(v) : f?.type === 'number' ? Number(v) : v;
      } else if (['line1', 'line2', 'district', 'province', 'postcode'].includes(m)) addr[m] = v;
      else if (m === 'kind' && kind === 'parties') rec.kind = personWords.includes(v.toLowerCase()) ? 'person' : 'organization';
      else if (m === 'roles') rec.roles = v.split(/[;,/|]/).map((x) => roleWords[x.trim().toLowerCase()] ?? x.trim().toLowerCase()).filter(Boolean);
      else if (m === 'salePrice' || m === 'costPrice' || m === 'creditLimit') rec[m] = money(v);
      else if (m === 'paymentTermsDays' || m === 'reorderPoint') rec[m] = numOrUndef(v);
      else rec[m] = v;
    });
    if (Object.keys(addr).length) rec.address = addr;
    if (Object.keys(fields).length) rec.fields = fields;
    if (kind === 'parties' && !rec.roles) rec.roles = ['customer'];
    return rec;
  }

  async function run() {
    busy = true;
    errors = [];
    try {
      const r = await command<{ created: number }>(`import.${kind}`, { rows: rows.map(toRecord) });
      done = T(`Imported ${r.created} ${kind === 'parties' ? 'customers/suppliers' : 'items'}.`, `นำเข้า ${r.created} รายการแล้ว`);
      toast(done, 'success');
      rows = [];
      header = [];
      fileName = '';
    } catch (e) {
      if (e instanceof ApiError && e.code === 'import_failed') errors = (e.details?.errors as any[]) ?? [];
      toast((e as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }

  function template() {
    const head = kind === 'parties'
      ? ['name', 'kind', 'roles', 'tax_id', ...extra.map((f) => f.key), 'phone', 'email', 'address', 'district', 'province', 'postcode', 'payment_terms_days', 'credit_limit']
      : ['sku', 'name', 'kind', 'uom', 'sale_price', 'cost_price', 'tax_code', 'wht_category', 'reorder_point'];
    const ex = kind === 'parties'
      ? ['Example Co., Ltd.', 'organization', 'customer', '0105558012345', ...extra.map((f) => (f.key === 'branch_code' ? '00000' : '')), '02-000-0000', '', '1 Example Rd', 'Bang Kapi', 'Bangkok', '10240', '30', '100000']
      : ['EX-001', 'Example item', 'stock', 'pc', '120.00', '80.00', app.boot.jurisdiction.defaultTaxCode ?? '', '', '10'];
    const body = [head, ex].map((r) => r.map((c) => `"${c}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' }));
    a.download = `sabi-${kind}-template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const colLabel = (m: string | null) => (m ? (m.startsWith('fields.') ? L(extra.find((x) => `fields.${x.key}` === m)?.label) : m) : T('ignored', 'ไม่ใช้'));
</script>

<div class="stack narrowform">
  <p>{T('Move in from spreadsheets or another program. Each row is checked exactly like a record typed in by hand; if any row has a problem, nothing is imported and the rows to fix are listed.', 'ย้ายข้อมูลจากสเปรดชีตหรือโปรแกรมอื่น ทุกแถวจะถูกตรวจเหมือนกรอกด้วยมือ ถ้ามีแถวใดผิด จะไม่นำเข้าเลยและแสดงแถวที่ต้องแก้')}</p>
  <div class="row">
    {#if can('parties.write')}<button class="btn sm" class:primary={kind === 'parties'} onclick={() => ((kind = 'parties'), (errors = []))}>{T('Customers & suppliers', 'ลูกค้าและผู้ขาย')}</button>{/if}
    {#if can('items.write')}<button class="btn sm" class:primary={kind === 'items'} onclick={() => ((kind = 'items'), (errors = []))}>{T('Items', 'สินค้า')}</button>{/if}
    <button class="btn ghost sm" onclick={template}>{T('Download a template', 'ดาวน์โหลดแบบฟอร์ม')}</button>
  </div>
  <label class="field"><span>{T('CSV file (UTF-8; save from Excel as “CSV UTF-8”)', 'ไฟล์ CSV (UTF-8 — ใน Excel เลือกบันทึกเป็น “CSV UTF-8”)')}</span>
    <input type="file" accept=".csv,text/csv,text/plain" onchange={pickFile} /></label>
  {#if done}<p class="text-success small">{done}</p>{/if}
  {#if header.length}
    <p class="small">{fileName}: <strong>{rows.length}</strong> {T('rows', 'แถว')}.
      {#if unknown.length}<span class="muted">{T('Ignored columns', 'คอลัมน์ที่ไม่ใช้')}: {unknown.join(', ')}</span>{/if}</p>
    {#if missing.length}<p class="err-text">{T('Missing required column(s)', 'ไม่มีคอลัมน์ที่จำเป็น')}: {missing.join(', ')}</p>{/if}
    <div class="scroll">
      <table class="data">
        <thead><tr><th>#</th>{#each header as h, i (i)}<th class:dim={!mapping[i]}>{h}<br /><span class="tiny muted">→ {colLabel(mapping[i])}</span></th>{/each}</tr></thead>
        <tbody>
          {#each rows.slice(0, 8) as r, n (n)}<tr class:bad={errors.some((e) => e.row === n + 1)}><td class="tiny muted">{n + 1}</td>{#each header as _, i (i)}<td class="small" class:dim={!mapping[i]}>{r[i] ?? ''}</td>{/each}</tr>{/each}
        </tbody>
      </table>
    </div>
    {#if rows.length > 8}<p class="tiny muted">{T(`…and ${rows.length - 8} more`, `…และอีก ${rows.length - 8} แถว`)}</p>{/if}
    <div class="row"><button class="btn primary" disabled={busy || !rows.length || missing.length > 0} onclick={run}>{T(`Import ${rows.length} rows`, `นำเข้า ${rows.length} แถว`)}</button></div>
  {/if}
  {#if errors.length}
    <div class="callout">
      <strong>{T('Fix these rows and try again:', 'แก้ไขแถวเหล่านี้แล้วลองใหม่:')}</strong>
      <ul class="small">{#each errors as e (e.row)}<li>{T('Row', 'แถว')} {e.row}{rows[e.row - 1] ? ` (${rows[e.row - 1][mapping.indexOf('name')] ?? ''})` : ''}: {e.message}</li>{/each}</ul>
    </div>
  {/if}
</div>

<style>
  .narrowform { max-width: 760px; }
  .scroll { overflow-x: auto; }
  .dim { opacity: 0.45; }
  .bad td { background: var(--t-danger-bg); }
  ul { margin: 6px 0 0; padding-left: 18px; }
</style>
