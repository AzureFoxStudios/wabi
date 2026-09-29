<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get, command, post } from '$lib/api.ts';
  import { app, T, toast, docTypeDef, roleLabel, can } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date, ago, userName, dueText } from '$lib/format.ts';
  import StatePill from '$components/StatePill.svelte';
  import Pipeline from '$components/Pipeline.svelte';
  import NextStep from '$components/NextStep.svelte';
  import Discussion from '$components/Discussion.svelte';
  import Timeline from '$components/Timeline.svelte';
  import LinesEditor from '$components/LinesEditor.svelte';
  import Picker from '$components/Picker.svelte';
  import Paper from '$components/Paper.svelte';

  const id = $derived(page.params.id);
  const r = resource(() => get(`documents/${id}`));
  const v = $derived(r.data as any);
  const d = $derived(v?.document);
  const draft = $derived(d?.phase === 'draft');

  // Local editable copy for drafts; reset when a different document loads or after save.
  let edit = $state<any>(null);
  let loadedFor = '';
  let dirty = $state(false);
  $effect(() => {
    if (!v) return;
    const key = `${v.document.id}:${v.document.updatedAt}`;
    if (key === loadedFor || (dirty && loadedFor.startsWith(v.document.id))) return;
    loadedFor = key;
    edit = {
      partyId: v.document.partyId, date: v.document.date, dueDate: v.document.dueDate ?? '', priceMode: v.document.priceMode,
      notes: v.document.notes ?? '', fields: { ...$state.snapshot(v.document.fields) }, lines: $state.snapshot(v.document.lines),
    };
    dirty = false;
  });
  $effect(() => {
    if (!edit) return;
    JSON.stringify(edit);
    if (loadedFor) dirty = JSON.stringify(serialize()) !== JSON.stringify(serializeFrom(v?.document));
  });
  function serializeFrom(doc: any) {
    if (!doc) return null;
    return { partyId: doc.partyId, date: doc.date, dueDate: doc.dueDate ?? '', priceMode: doc.priceMode, notes: doc.notes ?? '', fields: doc.fields, lines: doc.lines.map(lineOut) };
  }
  const lineOut = (l: any) => ({ id: l.id, itemId: l.itemId, description: l.description, measures: l.measures, qty: Number(l.qty), uom: l.uom, unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct) || 0, taxCode: l.taxCode, whtCategory: l.whtCategory, sourceLineId: l.sourceLineId });
  function serialize() {
    return { partyId: edit.partyId, date: edit.date, dueDate: edit.dueDate, priceMode: edit.priceMode, notes: edit.notes, fields: edit.fields, lines: edit.lines.map(lineOut) };
  }
  let saving = $state(false);
  async function save() {
    saving = true;
    try {
      const s = serialize();
      await command('document.update', { id: d.id, ...s, dueDate: s.dueDate || null, notes: s.notes || null });
      dirty = false;
      loadedFor = '';
      toast(T('Saved', 'บันทึกแล้ว'), 'success');
      r.reload();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      saving = false;
    }
  }
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && draft) {
      e.preventDefault();
      save();
    }
  }

  async function releaseRetention() {
    try {
      await command('document.releaseRetention', { id: d.id });
      toast(T('Retention released — it is now due', 'คืนเงินประกันผลงานแล้ว ถึงกำหนดชำระ'), 'success');
      r.reload();
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  }
  const normalConversions = $derived(v ? v.conversions.filter((c: any) => !c.adjusts && c.open > 0) : []);
  const noteConversions = $derived(v ? v.conversions.filter((c: any) => c.adjusts && c.open > 0) : []);
  const payDir = $derived(v?.money === 'payable' ? 'out' : 'in');
  const refundDir = $derived(v?.money === 'payable' ? 'in' : 'out');

  async function convert(type: string) {
    try {
      const res = await command('document.create', { type, sourceId: d.id });
      goto(`/documents/${res.id}`);
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  }
  let comment = $state('');
  async function decide(apId: string, decision: 'approved' | 'rejected') {
    try {
      await command('approval.decide', { id: apId, decision, comment: comment || undefined });
      comment = '';
      toast(decision === 'approved' ? T('Approved', 'อนุมัติแล้ว') : T('Rejected', 'ไม่อนุมัติ'), 'success');
      r.reload();
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  }
  const pendingApprovals = $derived(v ? v.approvals.filter((a: any) => a.state === 'pending') : []);
  const canDecide = (a: any) => app.boot.user.role === a.role || can('all');
  const errors = $derived(v ? v.issues.filter((i: any) => i.level === 'error') : []);
  const warnings = $derived(v ? v.issues.filter((i: any) => i.level === 'warning') : []);
  const partyHref = $derived(v ? `/parties/${v.party.id}` : '');
  $effect(() => {
    if (d?.id) post('read', { subjectType: 'document', subjectId: d.id }).catch(() => {});
  });
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>{v ? `${d.number ?? L(v.docType.label)}` : T('Document', 'เอกสาร')} · Sabi</title></svelte:head>

{#if r.error}
  <div class="page"><p class="err-text">{r.error.message}</p></div>
{:else if v && edit}
  <div class="page wide">
    <nav class="crumbs small muted">
      <a href="/documents">{T('Documents', 'เอกสาร')}</a>
      {#if v.job} / <a href={`/jobs/${v.job.id}`}>{v.job.number} · {v.job.title}</a>{/if}
      {#if v.source} / {T('from', 'จาก')} <a href={`/documents/${v.source.id}`}>{v.source.number}</a>{/if}
    </nav>
    <header class="head">
      <div class="grow">
        <div class="row wrap">
          <h1>{L(v.docType.label)} <span class="mono num">{d.number ?? ''}</span></h1>
          <StatePill label={v.state.label} tone={v.state.tone} />
        </div>
        <p class="sub"><a class="link" href={partyHref}>{v.party.name}</a> · {date(d.date)}{#if d.dueDate} · {L(v.docType.dueLabel) || T('Due', 'ครบกำหนด')} {date(d.dueDate)}{/if}</p>
      </div>
      <div class="amount num">
        <span class="small muted">{T('Total', 'ยอดรวม')}</span>
        <strong>฿{money(d.totals.total)}</strong>
        {#if v.balance !== null}
          {@const due = dueText(d.dueDate)}
          <span class="small" class:text-success={v.balance === 0} class:text-danger={v.balance > 0 && due.tone === 'danger'} class:text-warning={v.balance < 0}>
            {#if v.balance === 0}{T('Settled', 'ชำระครบแล้ว')}
            {:else if v.balance < 0}{v.money === 'payable' ? T('Supplier owes us', 'ผู้ขายต้องคืนเรา') : T('We owe the customer', 'เราต้องคืนลูกค้า')} ฿{money(-v.balance)}
            {:else}{T('Balance', 'คงค้าง')} ฿{money(v.balance)}{due.tone === 'danger' ? ' · ' + due.text : ''}{/if}
          </span>
        {/if}
        {#if v.retention}
          <span class="tiny muted">{v.retention.releasedAt ? T('Retention released', 'คืนเงินประกันแล้ว') : T('Retention held', 'เงินประกันผลงานถูกหัก')} ฿{money(v.retention.amount)}</span>
        {/if}
      </div>
    </header>
    <div class="pipe"><Pipeline states={v.pipeline} current={d.state} /></div>

    <div class="layout">
      <div class="main">
        {#if pendingApprovals.length}
          {#each pendingApprovals as a (a.id)}
            <div class="approval callout warning">
              <p><strong>{T('Approval needed', 'ต้องได้รับอนุมัติ')}</strong> — {roleLabel(a.role)} · {T('asked by', 'ขอโดย')} {userName(a.requestedBy)} {ago(a.requestedAt)}</p>
              {#if a.reason}<p class="small">“{a.reason}”</p>{/if}
              {#if d.totals.maxDiscountPct}<p class="small">{T('Largest line discount', 'ส่วนลดสูงสุดต่อรายการ')}: <strong>{d.totals.maxDiscountPct}%</strong> · {T('Total', 'ยอดรวม')} ฿{money(d.totals.total)}</p>{/if}
              {#if canDecide(a) && a.requestedBy !== app.boot.user.id}
                <div class="row wrap decide">
                  <input bind:value={comment} placeholder={T('Comment (optional)', 'ความเห็น (ถ้ามี)')} />
                  <button class="btn primary" onclick={() => decide(a.id, 'approved')}>{T('Approve', 'อนุมัติ')}</button>
                  <button class="btn danger" onclick={() => decide(a.id, 'rejected')}>{T('Reject', 'ไม่อนุมัติ')}</button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}

        <section class="section">
          <NextStep transitions={v.transitions} subjectType="document" subjectId={d.id} fields={v.docType.fields ?? []} hint={v.state.hint} onchange={() => { loadedFor = ''; r.reload(); }} />
          {#if draft && dirty}<p class="callout warning small">{T('You have unsaved changes — save before issuing.', 'มีการแก้ไขที่ยังไม่บันทึก กรุณาบันทึกก่อนออกเอกสาร')}</p>{/if}
          {#if draft && errors.length}
            <div class="callout danger small issues">
              <strong>{T('Before this can be issued as a tax document:', 'ก่อนออกเป็นเอกสารภาษี ต้องแก้ไข:')}</strong>
              <ul>{#each errors as i (i.code)}<li>{L(i.message)}{#if i.field?.startsWith('party.')} — <a class="link" href={partyHref}>{T('edit customer', 'แก้ไขข้อมูลลูกค้า')}</a>{:else if i.field?.startsWith('seller.')} — <a class="link" href="/settings">{T('company settings', 'ตั้งค่าบริษัท')}</a>{/if}</li>{/each}</ul>
            </div>
          {/if}
          {#if draft && warnings.length}
            <div class="callout warning small issues"><ul>{#each warnings as i (i.code)}<li>{L(i.message)}</li>{/each}</ul></div>
          {/if}
        </section>

        {#if draft}
          <section class="section">
            <div class="hdr-grid">
              <Picker kind="parties" role={v.docType.direction === 'purchase' ? 'supplier' : 'customer'} bind:value={edit.partyId} display={v.party.name} label={v.docType.direction === 'purchase' ? T('Supplier', 'ผู้ขาย') : T('Customer', 'ลูกค้า')} />
              <label class="field"><span>{T('Date', 'วันที่')}</span><input type="date" bind:value={edit.date} /></label>
              <label class="field"><span>{L(v.docType.dueLabel) || T('Due', 'ครบกำหนด')}</span><input type="date" bind:value={edit.dueDate} /></label>
              <label class="field"><span>{T('Prices', 'ราคา')}</span>
                <select bind:value={edit.priceMode}><option value="exclusive">{T('Excl. VAT', 'ไม่รวม VAT')}</option><option value="inclusive">{T('Incl. VAT', 'รวม VAT')}</option></select></label>
              {#each v.docType.fields ?? [] as f (f.key)}
                {#if f.type === 'boolean'}
                  <label class="check"><input type="checkbox" bind:checked={edit.fields[f.key]} /> {L(f.label)}</label>
                {:else if f.type === 'longtext'}
                  <label class="field span2"><span>{L(f.label)}</span><textarea rows="2" bind:value={edit.fields[f.key]}></textarea></label>
                {:else if f.type === 'number'}
                  <label class="field"><span>{L(f.label)}{f.unit ? ` (${f.unit})` : ''}</span><input type="number" step="any" min="0" value={edit.fields[f.key] ?? ''} oninput={(e) => { const x = (e.currentTarget as HTMLInputElement).value; edit.fields[f.key] = x === '' ? null : Number(x); }} /></label>
                {:else if f.type === 'select'}
                  <label class="field"><span>{L(f.label)}</span><select bind:value={edit.fields[f.key]}><option value={null}>—</option>{#each f.options ?? [] as o (o.value)}<option value={o.value}>{L(o.label)}</option>{/each}</select></label>
                {:else if f.type === 'date'}
                  <label class="field"><span>{L(f.label)}</span><input type="date" bind:value={edit.fields[f.key]} /></label>
                {:else}
                  <label class="field"><span>{L(f.label)}</span><input bind:value={edit.fields[f.key]} /></label>
                {/if}
              {/each}
            </div>
          </section>
          <section class="section">
            <LinesEditor bind:lines={edit.lines} priceMode={edit.priceMode} date={edit.date} direction={v.docType.direction} items={v.items} />
          </section>
          <section class="section">
            <label class="field"><span>{T('Notes printed on the document', 'หมายเหตุที่พิมพ์บนเอกสาร')}</span><textarea bind:value={edit.notes} rows="2"></textarea></label>
            <div class="row savebar">
              <button class="btn primary" disabled={!dirty || saving} onclick={save}>{T('Save draft', 'บันทึกร่าง')} <kbd>⌘S</kbd></button>
              <a class="btn ghost" href={`/documents/${d.id}/print`} target="_blank">{T('Preview print', 'ดูตัวอย่างก่อนพิมพ์')}</a>
              {#if dirty}<span class="small text-warning">{T('Unsaved changes', 'ยังไม่ได้บันทึก')}</span>{/if}
            </div>
          </section>
        {:else}
          <section class="section">
            <div class="row printbar">
              <a class="btn" href={`/documents/${d.id}/print`} target="_blank">{T('Print / PDF', 'พิมพ์/PDF')}</a>
              {#each normalConversions as c (c.type)}
                <button class="btn" onclick={() => convert(c.type)}>→ {L(c.label)}</button>
              {/each}
              {#if v.balance > 0 && can('money.write')}
                <a class="btn primary" href={`/money?pay=${payDir}&partyId=${d.partyId}&doc=${d.id}`}>{v.money === 'payable' ? T('Record payment to supplier', 'บันทึกจ่ายเงิน') : T('Record payment received', 'บันทึกรับชำระ')}</a>
              {/if}
              {#if v.balance < 0 && can('money.write')}
                <a class="btn primary" href={`/money?pay=${refundDir}&partyId=${d.partyId}&doc=${d.id}`}>{v.money === 'payable' ? T('Record refund from supplier', 'บันทึกรับเงินคืนจากผู้ขาย') : T('Refund the customer', 'คืนเงินลูกค้า')}</a>
              {/if}
              {#if v.retention && !v.retention.releasedAt && can('money.write') && d.phase !== 'void'}
                <button class="btn" onclick={releaseRetention}>{T('Release retention', 'คืนเงินประกันผลงาน')} ฿{money(v.retention.amount)}</button>
              {/if}
            </div>
            {#if noteConversions.length && can('documents.write')}
              <p class="small muted correct">{T('Something wrong after issue? Documents are never edited — correct with', 'หากต้องแก้ไขหลังออกเอกสาร ไม่แก้ไขเอกสารเดิม ให้ออก')}
                {#each noteConversions as c, i (c.type)}{i ? ` ${T('or', 'หรือ')} ` : ' '}<button class="linkbtn" onclick={() => convert(c.type)}>{L(c.label)}</button>{/each}.</p>
            {/if}
            {#if d.voidReason}<p class="callout danger small">{T('Voided', 'ยกเลิกแล้ว')}: {d.voidReason}</p>{/if}
            <div class="paperwrap"><Paper {v} /></div>
          </section>
        {/if}

        <section class="section" id="discussion">
          <header><h2>{T('Discussion', 'พูดคุย')}</h2></header>
          <Discussion subjectType="document" subjectId={d.id} messages={v.messages} files={v.files} onchange={r.reload} placeholder={T('Comment on this document… @name to ask someone', 'แสดงความเห็นเกี่ยวกับเอกสารนี้… @ชื่อ เพื่อเรียกคน')} />
        </section>
      </div>

      <aside class="side">
        {#if v.noteBasis}
          <section>
            <h3 class="eyebrow">{v.docType.adjusts === 'credit' ? T('Reduces', 'ลดหนี้จาก') : T('Adds to', 'เพิ่มหนี้จาก')}</h3>
            <p><a class="link" href={`/documents/${v.source.id}`}>{v.noteBasis.sourceNumber}</a> <span class="tiny muted">{date(v.noteBasis.sourceDate)}</span></p>
            <dl class="basis num small">
              <dt>{T('Original value', 'มูลค่าเดิม')}</dt><dd>{money(v.noteBasis.original)}</dd>
              <dt>{T('Correct value', 'มูลค่าที่ถูกต้อง')}</dt><dd>{money(v.noteBasis.corrected)}</dd>
              <dt>{T('Difference', 'ผลต่าง')}</dt><dd>{money(v.noteBasis.difference)}</dd>
            </dl>
          </section>
        {/if}
        {#if v.children.length || v.source}
          <section>
            <h3 class="eyebrow">{T('Related documents', 'เอกสารที่เกี่ยวข้อง')}</h3>
            <ul class="rel">
              {#if v.source}<li><a class="link" href={`/documents/${v.source.id}`}>{L(docTypeDef(v.source.type)?.label)} {v.source.number}</a> <span class="tiny muted">{T('source', 'ต้นทาง')}</span></li>{/if}
              {#each v.children as c (c.id)}<li><a class="link" href={`/documents/${c.id}`}>{L(docTypeDef(c.type)?.label)} {c.number ?? T('(draft)', '(ร่าง)')}</a> <StatePill label={c.stateLabel} tone={c.tone} /></li>{/each}
            </ul>
            {#if v.fulfilment !== null && v.children.length}<p class="small muted">{T('Converted', 'แปลงแล้ว')} {Math.round(v.fulfilment * 100)}%</p>{/if}
          </section>
        {/if}
        {#if v.money}
          <section>
            <h3 class="eyebrow">{T('Payments', 'การชำระเงิน')}</h3>
            <ul class="rel">
              {#each v.payments as p (p.id)}
                <li class:void={p.voided}><a class="mono small link" href={`/payments/${p.id}/print`} target="_blank">{p.number}</a> · {date(p.date)} · <span class="num">{p.refund ? '−' : ''}฿{money(p.allocated)}</span>{#if p.refund} <span class="tiny muted">{T('refund', 'คืนเงิน')}</span>{/if}{#if p.whtAmount}<br /><span class="tiny muted">{T('incl. WHT', 'รวมภาษีหัก ณ ที่จ่าย')} ฿{money(p.whtAmount)}{#if p.whtCertificate} · 50ทวิ {p.whtCertificate}{/if}</span>{/if}</li>
              {:else}<li class="small muted">{T('None yet', 'ยังไม่มี')}</li>{/each}
            </ul>
            {#if v.wht.length && v.balance > 0}<p class="tiny muted">{T('Expected withholding', 'คาดว่าจะถูกหัก ณ ที่จ่าย')}: {v.wht.map((w: any) => `${L(w.label)} ฿${money(w.amount)}`).join(', ')}</p>{/if}
          </section>
        {/if}
        {#if v.approvals.length}
          <section>
            <h3 class="eyebrow">{T('Approvals', 'การอนุมัติ')}</h3>
            <ul class="rel small">
              {#each v.approvals as a (a.id)}
                <li><StatePill label={{ pending: T('Pending', 'รออนุมัติ'), approved: T('Approved', 'อนุมัติ'), rejected: T('Rejected', 'ไม่อนุมัติ'), stale: T('Reset', 'ถูกยกเลิก') }[a.state as string]} tone={{ pending: 'warning', approved: 'success', rejected: 'danger', stale: 'neutral' }[a.state as string]} />
                  {roleLabel(a.role)}{#if a.decidedBy} · {userName(a.decidedBy)}{/if}{#if a.comment}<br /><span class="muted">“{a.comment}”</span>{/if}</li>
              {/each}
            </ul>
          </section>
        {/if}
        <section>
          <h3 class="eyebrow">{T('Activity', 'ความเคลื่อนไหว')}</h3>
          <Timeline events={v.timeline} limit={12} />
        </section>
      </aside>
    </div>
  </div>
{:else}
  <div class="page"><p class="muted">{T('Loading…', 'กำลังโหลด…')}</p></div>
{/if}

<style>
  .wide { max-width: 1280px; }
  .crumbs { margin-bottom: 8px; }
  .head { display: flex; gap: 24px; align-items: flex-start; }
  .sub { margin-top: 4px; color: var(--ink-2); }
  .amount { display: flex; flex-direction: column; align-items: flex-end; }
  .amount strong { font-size: 1.5rem; font-weight: 600; }
  .pipe { margin: 16px 0 22px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; }
  .side { display: flex; flex-direction: column; gap: 22px; font-size: 0.9rem; }
  .side h3 { margin-bottom: 8px; }
  .rel { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .approval { margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px; }
  .decide input { width: 260px; background: white; }
  .issues ul { margin: 4px 0 0; padding-left: 18px; }
  .hdr-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 10px; }
  .savebar, .printbar { margin-top: 12px; flex-wrap: wrap; }
  .printbar { margin: 0 0 16px; }
  .paperwrap { background: var(--sunken); border-radius: var(--radius); padding: 20px; overflow-x: auto; }
  .void { opacity: 0.5; text-decoration: line-through; }
  .check { display: flex; align-items: center; gap: 8px; align-self: end; padding-bottom: 8px; font-size: 0.9rem; }
  .span2 { grid-column: span 2; }
  .correct { margin: -6px 0 14px; }
  .linkbtn { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; cursor: pointer; font: inherit; }
  .basis { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin: 6px 0 0; }
  .basis dt { color: var(--muted); }
  .basis dd { margin: 0; text-align: right; }
  .section :global(.callout) { margin-top: 10px; }
  @media (max-width: 1050px) {
    .layout { grid-template-columns: 1fr; }
    .hdr-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
