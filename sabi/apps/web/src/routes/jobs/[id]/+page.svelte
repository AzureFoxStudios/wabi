<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get, post, command, authUrl } from '$lib/api.ts';
  import { app, T, toast, docTypeDef, roleLabel, can } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, moneyShort, date, dueText, userName, initials, qty, ago, fmtAddress } from '$lib/format.ts';
  import StatePill from '$components/StatePill.svelte';
  import Pipeline from '$components/Pipeline.svelte';
  import NextStep from '$components/NextStep.svelte';
  import Discussion from '$components/Discussion.svelte';
  import Tasks from '$components/Tasks.svelte';
  import Timeline from '$components/Timeline.svelte';
  import Fields from '$components/Fields.svelte';
  import Picker from '$components/Picker.svelte';

  const id = $derived(page.params.id);
  const r = resource(() => get(`jobs/${id}`));
  const w = $derived(r.data as any);

  type Tab = 'overview' | 'discussion' | 'documents' | 'tasks' | 'fulfilment' | 'money' | 'timeline';
  let tab = $state<Tab>((page.url.hash.slice(1) as Tab) || 'overview');
  // Follow in-page hash links (e.g. #fulfilment from the overview or from another screen).
  $effect(() => {
    const h = page.url.hash.slice(1) as Tab;
    if (h) tab = h;
  });
  function setTab(t: Tab) {
    tab = t;
    history.replaceState(history.state, '', `#${t}`);
  }

  // Mark read when opened / when new activity arrives while viewing.
  $effect(() => {
    if (w?.job?.id) post('read', { subjectType: 'job', subjectId: w.job.id }).catch(() => {});
  });

  const allMessages = $derived(w ? [...w.messages, ...w.docMessages] : []);
  const unreadMsgs = $derived(w ? allMessages.filter((m: any) => m.seq > w.lastRead && m.authorId !== app.boot.user.id && !m.label).length : 0);
  const openTasks = $derived(w ? w.tasks.filter((t: any) => !t.doneAt).length : 0);
  const shortLines = $derived(w ? w.fulfilment.filter((l: any) => l.short) : []);
  const docNumber = (docId: string) => w?.documents.find((d: any) => d.id === docId);
  const docContext = (m: any) => {
    if (m.subjectType !== 'document') return null;
    const d = docNumber(m.subjectId);
    return d ? { label: d.number ?? L(docTypeDef(d.type)?.label), href: `/documents/${d.id}` } : null;
  };
  const latest = $derived([...allMessages].filter((m: any) => !m.label).sort((a: any, b: any) => b.seq - a.seq).slice(0, 3));

  async function saveFields(patch: Record<string, any>) {
    await command('job.update', { id: w.job.id, fields: patch });
    toast(T('Saved', 'บันทึกแล้ว'), 'success');
  }
  async function setOwner(ownerId: string) {
    await command('job.update', { id: w.job.id, ownerId: ownerId || null });
  }
  async function setDue(dueDate: string) {
    await command('job.update', { id: w.job.id, dueDate: dueDate || null });
  }

  async function createDoc(type: string, sourceId?: string) {
    try {
      const res = await command('document.create', { type, jobId: w.job.id, sourceId, partyId: docTypeDef(type).direction === 'sales' ? w.job.partyId : undefined, lines: sourceId ? undefined : [] });
      goto(`/documents/${res.id}`);
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  }
  async function createPurchase() {
    goto(`/documents/new?type=purchase_order&jobId=${w.job.id}&short=1`);
  }

  // Material used on the job (not billed): stock.issue
  let useItem = $state('');
  let useQty = $state<number | null>(null);
  let useNote = $state('');
  async function recordUse(e: Event) {
    e.preventDefault();
    try {
      await command('stock.issue', { jobId: w.job.id, itemId: useItem, qty: useQty, note: useNote || undefined });
      useItem = '';
      useQty = null;
      useNote = '';
      toast(T('Material recorded', 'บันทึกการเบิกใช้แล้ว'), 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
</script>

<svelte:head><title>{w ? `${w.job.number} ${w.job.title}` : T('Job', 'งาน')} · Sabi</title></svelte:head>

{#if r.error}
  <div class="page"><p class="err-text">{r.error.message}</p></div>
{:else if w}
  <div class="page wide">
    <nav class="crumbs small muted"><a href="/jobs">{T('Jobs', 'งาน')}</a> / <span class="mono">{w.job.number}</span> · {L(w.jobType.label)}</nav>
    <header class="head">
      <div class="grow">
        <div class="row wrap titlerow">
          <h1>{w.job.title}</h1>
          <StatePill label={w.state.label} tone={w.state.tone} />
        </div>
        <p class="sub">
          <a class="link" href={`/parties/${w.party.id}`}>{w.party.name}</a>
          {#if w.contact}<span class="muted"> · {w.contact.name}{#if w.contact.phone} {w.contact.phone}{/if}</span>{/if}
          {#if w.party.phone}<span class="muted"> · {w.party.phone}</span>{/if}
          {#if w.job.fields.site_address || w.job.fields.delivery_address}<span class="muted"> · {w.job.fields.site_address ?? w.job.fields.delivery_address}</span>{/if}
        </p>
      </div>
      <dl class="money-strip num">
        {#if w.money.quoted}<div><dt>{T('Quoted', 'เสนอราคา')}</dt><dd>{moneyShort(w.money.quoted)}</dd></div>{/if}
        {#if w.money.ordered}<div><dt>{T('Ordered', 'สั่งซื้อ')}</dt><dd>{moneyShort(w.money.ordered)}</dd></div>{/if}
        {#if w.money.invoiced}<div><dt>{T('Invoiced', 'แจ้งหนี้')}</dt><dd>{moneyShort(w.money.invoiced)}</dd></div>{/if}
        {#if w.money.invoiced}<div><dt>{T('Outstanding', 'ค้างรับ')}</dt><dd class:text-warning={w.money.outstanding > 0} class:text-success={w.money.outstanding === 0}>{w.money.outstanding ? moneyShort(w.money.outstanding) : T('Paid ✓', 'รับครบ ✓')}</dd></div>{/if}
      </dl>
    </header>
    <div class="pipe"><Pipeline states={w.pipeline} current={w.job.state} /></div>

    <div class="layout">
      <div class="main">
        <div class="tabs" role="tablist">
          {#each [
            ['overview', T('Overview', 'ภาพรวม'), 0],
            ['discussion', T('Discussion', 'พูดคุย'), unreadMsgs],
            ['documents', T('Documents', 'เอกสาร'), w.documents.length],
            ['tasks', T('Tasks', 'งานย่อย'), openTasks],
            ['fulfilment', T('Materials & delivery', 'วัสดุและการส่ง'), shortLines.length],
            ['money', T('Money', 'การเงิน'), 0],
            ['timeline', T('Activity', 'ความเคลื่อนไหว'), 0],
          ] as [key, label, n] (key)}
            <button role="tab" aria-selected={tab === key} class:on={tab === key} onclick={() => setTab(key as Tab)}>
              {label}{#if n}<span class="count" class:hot={(key === 'discussion' && n) || (key === 'fulfilment' && n)}>{n}</span>{/if}
            </button>
          {/each}
        </div>

        {#if tab === 'overview'}
          <section class="section">
            <header>
              <h2>{T('Next step', 'ขั้นตอนถัดไป')}</h2>
              {#if w.state.ownerRole}<span class="small muted">{T('Owner of this step', 'ผู้รับผิดชอบขั้นนี้')}: <strong>{roleLabel(w.state.ownerRole)}</strong></span>{/if}
            </header>
            <NextStep transitions={w.transitions} subjectType="job" subjectId={w.job.id} fields={w.jobType.fields} hint={w.state.hint} onchange={r.reload} />
          </section>

          {#if shortLines.length || w.approvals.some((a: any) => a.state === 'pending')}
            <section class="section">
              <header><h2>{T('Blocked or at risk', 'ติดขัด/มีความเสี่ยง')}</h2></header>
              <ul class="rows">
                {#each w.approvals.filter((a: any) => a.state === 'pending') as ap (ap.id)}
                  <a href={`/documents/${ap.subjectId}`}><span class="pill tone-warning">{T('Approval', 'รออนุมัติ')}</span><span class="grow">{docNumber(ap.subjectId)?.number ?? L(docTypeDef(docNumber(ap.subjectId)?.type)?.label)} — {T('waiting for', 'รอ')} {roleLabel(ap.role)}: “{ap.reason}”</span></a>
                {/each}
                {#each shortLines as l (l.lineId)}
                  <a href="#fulfilment" onclick={(e) => { e.preventDefault(); setTab('fulfilment'); }}>
                    <span class="pill tone-danger">{T('Short', 'ของขาด')}</span>
                    <span class="grow">{l.description}: {T('need', 'ต้องใช้')} {qty(l.remaining)} {l.uom} · {T('in stock', 'มีในคลัง')} {qty(l.onHand)} · <strong>{T('short', 'ขาด')} {qty(-l.available)}</strong>{#if l.incoming} · {T('on order', 'สั่งแล้ว')} {qty(l.incoming)}{#if l.incoming >= -l.available} <span class="text-success">({T('covers it', 'พอแล้ว')})</span>{/if}{/if}</span>
                  </a>
                {/each}
              </ul>
            </section>
          {/if}

          <section class="section">
            <header><h2>{T('Latest discussion', 'พูดคุยล่าสุด')}</h2><button class="btn ghost sm" onclick={() => setTab('discussion')}>{T('Open discussion', 'เปิดการพูดคุย')}</button></header>
            {#if latest.length}
              <ul class="latest">
                {#each latest as m (m.id)}
                  <li><span class="avatar">{initials(userName(m.authorId))}</span><span class="grow"><span class="small muted">{userName(m.authorId)} · {ago(m.createdAt)}</span><br />{m.body}</span></li>
                {/each}
              </ul>
            {:else}
              <p class="muted small">{T('No messages yet.', 'ยังไม่มีข้อความ')}</p>
            {/if}
          </section>

          <section class="section">
            <header><h2>{T('Documents', 'เอกสาร')}</h2><button class="btn ghost sm" onclick={() => setTab('documents')}>{T('All documents', 'เอกสารทั้งหมด')}</button></header>
            {@render docList(w.documents.filter((d: any) => d.phase !== 'void'))}
          </section>

          {#if openTasks}
            <section class="section">
              <header><h2>{T('Open tasks', 'งานที่ค้าง')}</h2></header>
              <Tasks subjectType="job" subjectId={w.job.id} tasks={w.tasks} onchange={r.reload} compact />
            </section>
          {/if}
        {:else if tab === 'discussion'}
          <div id="discussion">
            <Discussion subjectType="job" subjectId={w.job.id} messages={allMessages} files={w.files} contextOf={docContext} onchange={r.reload} lastRead={w.lastRead} />
          </div>
        {:else if tab === 'documents'}
          <section class="section">
            {@render docList(w.documents)}
          </section>
          <section class="section">
            <header><h2>{T('Create', 'สร้างเอกสาร')}</h2></header>
            <div class="create-docs">
              {#each w.creatable as c (c.type)}
                {#each c.sources as s (s.id)}
                  <button class="btn" onclick={() => createDoc(c.type, s.id)}>{L(c.label)} {T('from', 'จาก')} {s.number}</button>
                {/each}
                {#if !c.sources.length || c.direction === 'purchase'}
                  <button class="btn ghost" onclick={() => (c.direction === 'purchase' ? createPurchase() : createDoc(c.type))}>+ {L(c.label)}</button>
                {/if}
              {/each}
            </div>
            <p class="tiny muted">{T('Converting copies the lines that are still open, so nothing is typed twice.', 'การแปลงเอกสารจะคัดลอกรายการที่ยังค้าง ไม่ต้องพิมพ์ซ้ำ')}</p>
          </section>
        {:else if tab === 'tasks'}
          <Tasks subjectType="job" subjectId={w.job.id} tasks={w.tasks} onchange={r.reload} />
        {:else if tab === 'fulfilment'}
          <section class="section">
            <header><h2>{T('Ordered vs delivered', 'สั่ง vs ส่งแล้ว')}</h2>
              {#if shortLines.length && can('documents.write')}<button class="btn sm" onclick={createPurchase}>{T('Order shortage from supplier', 'สั่งซื้อของที่ขาด')}</button>{/if}
            </header>
            {#if w.fulfilment.length}
              <table class="data">
                <thead><tr><th>{T('Item', 'รายการ')}</th><th class="num">{T('Ordered', 'สั่ง')}</th><th class="num">{T('Delivered', 'ส่งแล้ว')}</th><th class="num">{T('Remaining', 'คงค้าง')}</th><th class="num">{T('In stock', 'ในคลัง')}</th><th class="num">{T('Free', 'ว่าง')}</th><th></th></tr></thead>
                <tbody>
                  {#each w.fulfilment as l (l.lineId)}
                    <tr>
                      <td>{l.description}<br /><span class="tiny muted">{l.documentNumber}</span></td>
                      <td class="num">{qty(l.ordered)} {l.uom}</td>
                      <td class="num">{qty(l.delivered)}</td>
                      <td class="num">{qty(l.remaining)}</td>
                      <td class="num">{l.kind === 'stock' ? qty(l.onHand) : '—'}</td>
                      <td class="num" class:text-danger={l.short}>{l.kind === 'stock' ? qty(l.available) : '—'}</td>
                      <td>{#if l.short}<span class="pill tone-danger">{T('Short', 'ขาด')}</span>{#if l.incoming}<br /><span class="tiny muted">{T('on order', 'สั่งแล้ว')} {qty(l.incoming)}</span>{/if}{:else if l.remaining === 0}<span class="pill tone-success">{T('Done', 'ครบ')}</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="muted small">{T('Nothing ordered yet. Confirm a sales order to track delivery here.', 'ยังไม่มีคำสั่งซื้อ เมื่อยืนยันใบสั่งขายแล้วจะติดตามการส่งของได้ที่นี่')}</p>
            {/if}
          </section>
          <section class="section">
            <header><h2>{T('Stock movements for this job', 'การเคลื่อนไหวสต็อกของงานนี้')}</h2><span class="small muted">{T('Material cost', 'ต้นทุนวัสดุ')}: <strong class="num">฿{money(w.materialCost)}</strong></span></header>
            {#if w.materials.length}
              <table class="data">
                <thead><tr><th>{T('When', 'เมื่อ')}</th><th>{T('Item', 'สินค้า')}</th><th class="num">{T('Qty', 'จำนวน')}</th><th>{T('Movement', 'การเคลื่อนไหว')}</th><th class="num">{T('Cost', 'ต้นทุน')}</th></tr></thead>
                <tbody>
                  {#each w.materials as m (m.id)}
                    <tr><td class="nowrap">{date(m.at)}</td><td><span class="mono small">{m.sku}</span> {m.name}{#if m.note}<br /><span class="tiny muted">{m.note}</span>{/if}</td><td class="num">{qty(m.qty)} {m.uom}</td>
                      <td class="small">{m.to === 'consumed' ? T('Used on job', 'เบิกใช้') : m.to === 'customer' ? T('Delivered', 'ส่งลูกค้า') : `${m.from} → ${m.to}`}</td><td class="num">{money(m.cost)}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if can('stock.write')}
              <form class="use" onsubmit={recordUse}>
                <div class="grow"><Picker kind="items" bind:value={useItem} placeholder={T('Material used (not billed)…', 'วัสดุที่เบิกใช้ (ไม่คิดเงิน)…')} /></div>
                <input type="number" step="any" min="0" bind:value={useQty} placeholder={T('Qty', 'จำนวน')} required />
                <input bind:value={useNote} placeholder={T('Note', 'หมายเหตุ')} />
                <button class="btn" disabled={!useItem || !useQty}>{T('Record use', 'บันทึกเบิก')}</button>
              </form>
            {/if}
          </section>
        {:else if tab === 'money'}
          <section class="section">
            <dl class="money-grid num">
              <div><dt>{T('Quoted', 'เสนอราคา')}</dt><dd>฿{money(w.money.quoted)}</dd></div>
              <div><dt>{T('Ordered', 'ยอดสั่ง')}</dt><dd>฿{money(w.money.ordered)}</dd></div>
              <div><dt>{T('Invoiced', 'แจ้งหนี้แล้ว')}</dt><dd>฿{money(w.money.invoiced)}</dd></div>
              <div><dt>{T('Received', 'รับแล้ว')}</dt><dd class="text-success">฿{money(w.money.paid)}</dd></div>
              <div><dt>{T('Outstanding', 'คงค้าง')}</dt><dd class:text-warning={w.money.outstanding > 0}>฿{money(w.money.outstanding)}</dd></div>
              <div><dt>{T('Material cost', 'ต้นทุนวัสดุ')}</dt><dd>฿{money(w.materialCost)}</dd></div>
            </dl>
            {#if w.wht.length && w.money.outstanding > 0}
              <p class="callout info small">{T('This customer is a company: expect them to withhold', 'ลูกค้าเป็นนิติบุคคล คาดว่าจะหัก ณ ที่จ่าย')} {w.wht.map((x: any) => `${L(x.label)} ฿${money(x.amount)}`).join(', ')}. {T('Ask for the 50 Tawi certificate when they pay.', 'ขอหนังสือรับรอง 50 ทวิ เมื่อรับชำระ')}</p>
            {/if}
            {#if w.money.outstanding > 0 && can('money.write')}
              <a class="btn primary" href={`/money?pay=in&partyId=${w.job.partyId}`}>{T('Record payment', 'บันทึกรับชำระ')}</a>
            {/if}
          </section>
          <section class="section">
            <header><h2>{T('Payments', 'การชำระเงิน')}</h2></header>
            <ul class="rows">
              {#each w.payments as p (p.id)}
                <li class:void={p.voided}><span class="mono small">{p.number}</span><span class="grow">{date(p.date)} · {p.method}{#if p.whtAmount} · WHT ฿{money(p.whtAmount)}{/if}{#if p.reference} · {p.reference}{/if}</span><span class="num">฿{money(p.amount)}</span></li>
              {:else}<li class="muted small">{T('No payments yet.', 'ยังไม่มีการชำระ')}</li>{/each}
            </ul>
          </section>
        {:else if tab === 'timeline'}
          <Timeline events={w.timeline} />
        {/if}
      </div>

      <aside class="side">
        <section>
          <h3 class="eyebrow">{T('Job', 'งาน')}</h3>
          <dl class="facts">
            <dt>{T('Owner', 'ผู้ดูแล')}</dt>
            <dd><select class="bare" value={w.job.ownerId ?? ''} onchange={(e) => setOwner((e.target as HTMLSelectElement).value)}>
              <option value="">—</option>{#each app.boot.users.filter((u: any) => u.active) as u (u.id)}<option value={u.id}>{u.name}</option>{/each}
            </select></dd>
            <dt>{T('Due', 'กำหนดเสร็จ')}</dt>
            <dd><input class="bare" type="date" value={w.job.dueDate ?? ''} onchange={(e) => setDue((e.target as HTMLInputElement).value)} /></dd>
            <dt>{T('Opened', 'เปิดงาน')}</dt><dd>{date(w.job.createdAt)}</dd>
          </dl>
        </section>
        <section>
          <h3 class="eyebrow">{T('Details', 'รายละเอียด')}</h3>
          <Fields defs={w.jobType.fields} values={w.job.fields} onsave={saveFields} editable={can('jobs.write')} />
        </section>
        <section>
          <h3 class="eyebrow">{T('Customer', 'ลูกค้า')}</h3>
          <p><a class="link" href={`/parties/${w.party.id}`}>{w.party.name}</a></p>
          <p class="small muted">{[w.party.phone, w.party.fields?.line_id ? `LINE ${w.party.fields.line_id}` : '', fmtAddress(w.party.address)].filter(Boolean).join(' · ')}</p>
          {#if w.contacts.length}<p class="small">{T('Contacts', 'ผู้ติดต่อ')}: {w.contacts.map((c: any) => `${c.name}${c.phone ? ' ' + c.phone : ''}`).join(', ')}</p>{/if}
        </section>
        {#if w.files.length}
          <section>
            <h3 class="eyebrow">{T('Files', 'ไฟล์')} · {w.files.length}</h3>
            <ul class="files">
              {#each w.files as f (f.id)}
                <li>
                  {#if f.mime.startsWith('image/')}<a href={authUrl(`/api/files/${f.id}`)} target="_blank" rel="noopener"><img src={authUrl(`/api/files/${f.id}`)} alt={f.name} loading="lazy" /></a>
                  {:else}<a class="link small" href={authUrl(`/api/files/${f.id}`)} target="_blank" rel="noopener">{f.name}</a>{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </aside>
    </div>
  </div>
{:else}
  <div class="page"><p class="muted">{T('Loading…', 'กำลังโหลด…')}</p></div>
{/if}

{#snippet docList(docs: any[])}
  {#if docs.length}
    <table class="data">
      <tbody>
        {#each docs as d (d.id)}
          <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}>
            <td>{L(docTypeDef(d.type)?.label)}</td>
            <td class="mono small">{d.number ?? T('draft', 'ร่าง')}</td>
            <td class="small muted nowrap">{date(d.date)}</td>
            <td><StatePill label={d.stateLabel} tone={d.tone} /></td>
            <td class="num">฿{money(d.total)}</td>
            <td class="num small">{#if d.balance !== null}{#if d.balance > 0}<span class:text-danger={d.overdue} class:text-warning={!d.overdue}>{T('due', 'ค้าง')} {money(d.balance)}</span>{:else}<span class="text-success">{T('paid', 'ชำระแล้ว')}</span>{/if}{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="muted small">{T('No documents yet. Start with a quotation.', 'ยังไม่มีเอกสาร เริ่มจากใบเสนอราคา')}</p>
  {/if}
{/snippet}

<style>
  .wide { max-width: 1280px; }
  .crumbs { margin-bottom: 8px; }
  .crumbs a:hover { color: var(--ink); }
  .head { display: flex; gap: 24px; align-items: flex-start; }
  .titlerow { gap: 12px; }
  .sub { margin-top: 4px; }
  .money-strip { display: flex; gap: 22px; margin: 0; }
  .money-strip dt { font-size: 0.75rem; color: var(--muted); }
  .money-strip dd { margin: 0; font-weight: 600; font-size: 1.05rem; }
  .pipe { margin: 16px 0 22px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; }
  .side { display: flex; flex-direction: column; gap: 22px; font-size: 0.92rem; }
  .side h3 { margin-bottom: 8px; }
  .facts { display: grid; grid-template-columns: minmax(80px, auto) 1fr; gap: 4px 12px; margin: 0; align-items: center; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; }
  .facts select, .facts input { min-height: 28px; padding: 2px 6px; margin-left: -6px; }
  .latest { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .latest li { display: flex; gap: 10px; }
  .create-docs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .use { display: grid; grid-template-columns: 1fr 100px 1fr auto; gap: 6px; margin-top: 12px; align-items: end; }
  .money-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px 24px; margin: 0 0 16px; }
  .money-grid dt { font-size: 0.78rem; color: var(--muted); }
  .money-grid dd { margin: 0; font-size: 1.1rem; font-weight: 600; }
  .void { opacity: 0.5; text-decoration: line-through; }
  .files { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .files img { width: 84px; height: 64px; object-fit: cover; border-radius: 5px; border: 1px solid var(--line); display: block; }
  @media (max-width: 1050px) {
    .layout { grid-template-columns: 1fr; }
    .head { flex-direction: column; }
  }
</style>
