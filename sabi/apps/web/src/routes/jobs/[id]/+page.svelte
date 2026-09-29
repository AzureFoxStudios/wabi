<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get, post, command, authUrl } from '$lib/api.ts';
  import { app, T, toast, docTypeDef, roleLabel, can } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, moneyShort, date, dueText, userName, initials, qty, ago, fmtAddress, unit, mentionHtml } from '$lib/format.ts';
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
    <nav class="crumbs small muted"><a href="/jobs">← {T('All jobs', 'งานทั้งหมด')}</a> · {L(w.jobType.label)} <span class="ref">{w.job.number}</span></nav>
    <header class="head">
      <div class="grow">
        <div class="row wrap titlerow">
          <h1>{w.job.title}</h1>
          <StatePill label={w.state.label} tone={w.state.tone} />
        </div>
        <p class="sub">
          {T('Customer:', 'ลูกค้า:')} <a class="link" href={`/parties/${w.party.id}`}>{w.party.name}</a>
          {#if w.contact}<span class="muted"> · {w.contact.name}{#if w.contact.phone}{' '}{w.contact.phone}{/if}</span>{/if}
          {#if w.party.phone}<span class="muted"> · {w.party.phone}</span>{/if}
          {#if w.job.fields.site_address || w.job.fields.delivery_address}<span class="muted"> · {w.job.fields.site_address ?? w.job.fields.delivery_address}</span>{/if}
        </p>
      </div>
      <dl class="money-strip num">
        {#if w.money.quoted}<div><dt>{T('Price offered', 'ราคาที่เสนอ')}</dt><dd>{moneyShort(w.money.quoted)}</dd></div>{/if}
        {#if w.money.ordered}<div><dt>{T('Customer agreed', 'ลูกค้าตกลงสั่ง')}</dt><dd>{moneyShort(w.money.ordered)}</dd></div>{/if}
        {#if w.money.invoiced}<div><dt>{T('Billed so far', 'เรียกเก็บแล้ว')}</dt><dd>{moneyShort(w.money.invoiced)}</dd></div>{/if}
        {#if w.money.invoiced}<div><dt>{T('Still to collect', 'ยังไม่ได้รับ')}</dt><dd class:text-warning={w.money.outstanding > 0} class:text-success={w.money.outstanding === 0}>{w.money.outstanding ? moneyShort(w.money.outstanding) : T('All paid', 'รับครบแล้ว')}</dd></div>{/if}
      </dl>
    </header>
    <div class="pipe"><p class="tiny muted pipe-lbl">{T('Where this job is now (the steps from first call to finished):', 'งานนี้อยู่ขั้นไหน (ตั้งแต่ลูกค้าติดต่อ จนเสร็จงาน):')}</p><Pipeline states={w.pipeline} current={w.job.state} /></div>

    <div class="layout">
      <div class="main">
        <div class="tabs" role="tablist">
          {#each [
            ['overview', T('Summary', 'สรุป'), 0],
            ['discussion', T('Messages', 'ข้อความ'), unreadMsgs],
            ['documents', T('Documents', 'เอกสาร'), w.documents.length],
            ['tasks', T('To-dos', 'สิ่งที่ต้องทำ'), openTasks],
            ['fulfilment', T('Materials & delivery', 'ของและการส่งของ'), shortLines.length],
            ['money', T('Money', 'เงิน'), 0],
            ['timeline', T('History', 'ประวัติ'), 0],
          ] as [key, label, n] (key)}
            <button role="tab" aria-selected={tab === key} class:on={tab === key} onclick={() => setTab(key as Tab)}>
              {label}{#if n}<span class="count" class:hot={(key === 'discussion' && n) || (key === 'fulfilment' && n)}>{n}</span>{/if}
            </button>
          {/each}
        </div>

        {#if tab === 'overview'}
          <section class="section">
            <header>
              <h2>{T('What happens next', 'ต้องทำอะไรต่อ')}</h2>
              {#if w.state.ownerRole}<span class="small muted">{T('Whose turn:', 'ถึงตาใคร:')} <strong>{roleLabel(w.state.ownerRole)}</strong></span>{/if}
            </header>
            <p class="hint">{T('When this step is done, press the green button to move the job forward. Everyone on the team will see it.', 'เมื่อทำขั้นนี้เสร็จ ให้กดปุ่มสีเขียวเพื่อไปขั้นต่อไป ทุกคนในทีมจะเห็น')}</p>
            <NextStep transitions={w.transitions} subjectType="job" subjectId={w.job.id} fields={w.jobType.fields} hint={w.state.hint} onchange={r.reload} />
          </section>

          {#if shortLines.length || w.approvals.some((a: any) => a.state === 'pending')}
            <section class="section">
              <header><h2>{T('Problems to sort out', 'ปัญหาที่ต้องแก้')}</h2></header>
              <p class="hint">{T('These could stop or delay the job.', 'เรื่องเหล่านี้อาจทำให้งานหยุดหรือล่าช้า')}</p>
              <ul class="rows">
                {#each w.approvals.filter((a: any) => a.state === 'pending') as ap (ap.id)}
                  <a href={`/documents/${ap.subjectId}`}><span class="pill tone-warning">{T('Waiting for OK', 'รออนุมัติ')}</span><span class="grow"><strong>{L(docTypeDef(docNumber(ap.subjectId)?.type)?.label)}</strong> {T('is waiting for the', 'รอ')} {roleLabel(ap.role)} {T('to approve', 'อนุมัติ')}{#if ap.reason} — “{ap.reason}”{/if}</span></a>
                {/each}
                {#each shortLines as l (l.lineId)}
                  <a href="#fulfilment" onclick={(e) => { e.preventDefault(); setTab('fulfilment'); }}>
                    <span class="pill tone-danger">{T('Not enough', 'ของไม่พอ')}</span>
                    <span class="grow"><strong>{l.description}</strong><br /><span class="small">{T(`We need ${qty(l.remaining)} ${unit(l.uom)} but are short by ${qty(-l.available)} ${unit(l.uom)}.`, `ต้องใช้ ${qty(l.remaining)} ${unit(l.uom)} แต่ยังขาดอีก ${qty(-l.available)} ${unit(l.uom)}`)}
                      {#if l.incoming}{#if l.incoming >= -l.available}<span class="text-success">{T(` ${qty(l.incoming)} are already ordered from the supplier — that will be enough.`, ` สั่งจากผู้ขายไว้แล้ว ${qty(l.incoming)} — พอเมื่อของมาถึง`)}</span>{:else}{T(` ${qty(l.incoming)} are ordered, still not enough — order more.`, ` สั่งไว้แล้ว ${qty(l.incoming)} แต่ยังไม่พอ — ต้องสั่งเพิ่ม`)}{/if}{:else}{T(' Nothing ordered yet — order from a supplier.', ' ยังไม่ได้สั่ง — ต้องสั่งซื้อจากผู้ขาย')}{/if}</span></span>
                  </a>
                {/each}
              </ul>
            </section>
          {/if}

          <section class="section">
            <header><h2>{T('Latest messages', 'ข้อความล่าสุด')}</h2><button class="btn ghost sm" onclick={() => setTab('discussion')}>{T('Read all & reply', 'อ่านทั้งหมดและตอบ')}</button></header>
            {#if latest.length}
              <ul class="latest">
                {#each latest as m (m.id)}
                  <li><span class="avatar">{initials(userName(m.authorId))}</span><span class="grow"><span class="small muted">{userName(m.authorId)} · {ago(m.createdAt)}</span><br />{@html mentionHtml(m.body)}</span></li>
                {/each}
              </ul>
            {:else}
              <p class="muted small">{T('No messages yet.', 'ยังไม่มีข้อความ')}</p>
            {/if}
          </section>

          <section class="section">
            <header><h2>{T('Paperwork for this job', 'เอกสารของงานนี้')}</h2><button class="btn ghost sm" onclick={() => setTab('documents')}>{T('Make a new document', 'ทำเอกสารใหม่')}</button></header>
            <p class="hint">{T('Quotes, orders, delivery notes and invoices. The usual order is: quotation → sales order → delivery / invoice → receipt.', 'ใบเสนอราคา ใบสั่ง ใบส่งของ และใบแจ้งหนี้ ลำดับปกติคือ ใบเสนอราคา → ใบสั่งขาย → ใบส่งของ/ใบแจ้งหนี้ → ใบเสร็จ')}</p>
            {@render docList(w.documents.filter((d: any) => d.phase !== 'void'))}
          </section>

          {#if openTasks}
            <section class="section">
              <header><h2>{T('Unfinished to-dos', 'สิ่งที่ยังไม่ได้ทำ')}</h2></header>
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
            <header><h2>{T('Make the next document', 'ทำเอกสารถัดไป')}</h2></header>
            <p class="hint">{T('Buttons that say “from …” copy everything from an existing document, so you don’t type it again.', 'ปุ่มที่เขียนว่า “จาก …” จะคัดลอกรายการจากเอกสารเดิมให้ ไม่ต้องพิมพ์ใหม่')}</p>
            <div class="create-docs">
              {#each w.creatable as c (c.type)}
                {#each c.sources as s (s.id)}
                  <button class="btn" onclick={() => createDoc(c.type, s.id)}>{T('Make a', 'ทำ')} {L(c.label)} {T('from', 'จาก')} {s.number}</button>
                {/each}
                {#if !c.sources.length || c.direction === 'purchase'}
                  <button class="btn ghost" onclick={() => (c.direction === 'purchase' ? createPurchase() : createDoc(c.type))}>+ {T('New blank', 'ทำ')} {L(c.label)}{T('', 'ใหม่ (ว่าง)')}</button>
                {/if}
              {/each}
            </div>
          </section>
        {:else if tab === 'tasks'}
          <Tasks subjectType="job" subjectId={w.job.id} tasks={w.tasks} onchange={r.reload} />
        {:else if tab === 'fulfilment'}
          <section class="section">
            <header><h2>{T('What the customer ordered, and what we delivered', 'ลูกค้าสั่งอะไร และเราส่งไปแล้วเท่าไร')}</h2>
              {#if shortLines.length && can('documents.write')}<button class="btn sm primary" onclick={createPurchase}>{T('Order the missing items from a supplier', 'สั่งซื้อของที่ขาดจากผู้ขาย')}</button>{/if}
            </header>
            <p class="hint">{T('“Still to deliver” is what we owe the customer. “Free in stock” is what is left after other jobs take their share — red means not enough.', '“ยังต้องส่ง” คือของที่ยังค้างส่งลูกค้า “ว่างในคลัง” คือของที่เหลือหลังหักส่วนที่จองให้งานอื่นแล้ว ถ้าเป็นสีแดงแปลว่าไม่พอ')}</p>
            {#if w.fulfilment.length}
              <table class="data">
                <thead><tr><th>{T('Product', 'สินค้า')}</th><th class="num">{T('Ordered', 'ลูกค้าสั่ง')}</th><th class="num">{T('Delivered', 'ส่งแล้ว')}</th><th class="num">{T('Still to deliver', 'ยังต้องส่ง')}</th><th class="num">{T('In stock', 'มีในคลัง')}</th><th class="num">{T('Free in stock', 'ว่างในคลัง')}</th><th></th></tr></thead>
                <tbody>
                  {#each w.fulfilment as l (l.lineId)}
                    <tr>
                      <td>{l.description}<br /><span class="ref">{l.documentNumber}</span></td>
                      <td class="num">{qty(l.ordered)} {unit(l.uom)}</td>
                      <td class="num">{qty(l.delivered)}</td>
                      <td class="num">{qty(l.remaining)}</td>
                      <td class="num">{l.kind === 'stock' ? qty(l.onHand) : '—'}</td>
                      <td class="num" class:text-danger={l.short}>{l.kind === 'stock' ? (l.available < 0 ? T(`${qty(-l.available)} short`, `ขาด ${qty(-l.available)}`) : qty(l.available)) : '—'}</td>
                      <td>{#if l.short}<span class="pill tone-danger">{T('Not enough', 'ไม่พอ')}</span>{#if l.incoming}<br /><span class="tiny muted">{T(`${qty(l.incoming)} on the way`, `สั่งแล้ว ${qty(l.incoming)} กำลังมา`)}</span>{/if}{:else if l.remaining === 0}<span class="pill tone-success">{T('All delivered', 'ส่งครบแล้ว')}</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="muted small">{T('The customer has not ordered yet. Once a sales order is confirmed, you can follow the delivery here.', 'ลูกค้ายังไม่ได้สั่ง เมื่อยืนยันใบสั่งขายแล้ว จะติดตามการส่งของได้ที่นี่')}</p>
            {/if}
          </section>
          <section class="section">
            <header><h2>{T('Materials taken from stock for this job', 'ของที่เบิกจากคลังไปใช้ในงานนี้')}</h2><span class="small muted">{T('Cost of materials', 'ต้นทุนของที่ใช้')}: <strong class="num">฿{money(w.materialCost)}</strong></span></header>
            <p class="hint">{T('Record screws, sealant, offcuts and anything else used on the job but not charged to the customer, so stock stays correct.', 'บันทึกน็อต ซิลิโคน เศษวัสดุ และของอื่นที่ใช้ในงานแต่ไม่ได้คิดเงินลูกค้า เพื่อให้จำนวนของในคลังถูกต้อง')}</p>
            {#if w.materials.length}
              <table class="data">
                <thead><tr><th>{T('Date', 'วันที่')}</th><th>{T('Product', 'สินค้า')}</th><th class="num">{T('Amount', 'จำนวน')}</th><th>{T('What happened', 'เกิดอะไรขึ้น')}</th><th class="num">{T('Cost', 'ต้นทุน')}</th></tr></thead>
                <tbody>
                  {#each w.materials as m (m.id)}
                    <tr><td class="nowrap">{date(m.at)}</td><td>{m.name} <span class="ref">{m.sku}</span>{#if m.note}<br /><span class="tiny muted">{m.note}</span>{/if}</td><td class="num">{qty(m.qty)} {unit(m.uom)}</td>
                      <td class="small">{m.to === 'consumed' ? T('Used on the job', 'เบิกไปใช้ในงาน') : m.to === 'customer' ? T('Delivered to customer', 'ส่งให้ลูกค้า') : m.from === 'customer' ? T('Returned by customer', 'ลูกค้าคืน') : `${m.from} → ${m.to}`}</td><td class="num">{money(m.cost)}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#if can('stock.write')}
              <form class="use" onsubmit={recordUse}>
                <div class="grow"><Picker kind="items" bind:value={useItem} placeholder={T('Pick what was used…', 'เลือกของที่ใช้…')} /></div>
                <input type="number" step="any" min="0" bind:value={useQty} placeholder={T('Qty', 'จำนวน')} required />
                <input bind:value={useNote} placeholder={T('Note (optional)', 'หมายเหตุ (ไม่ใส่ก็ได้)')} />
                <button class="btn" disabled={!useItem || !useQty}>{T('Save', 'บันทึกการเบิก')}</button>
              </form>
            {/if}
          </section>
        {:else if tab === 'money'}
          <section class="section">
            <header><h2>{T('Money for this job', 'เงินของงานนี้')}</h2></header>
            <p class="hint">{T('Read left to right: what we offered, what the customer agreed to, what we billed, what they paid, and what is still owed.', 'อ่านจากซ้ายไปขวา: ราคาที่เสนอ → ลูกค้าตกลง → เรียกเก็บแล้ว → ได้รับแล้ว → ยังค้างอยู่')}</p>
            <dl class="money-grid num">
              <div><dt>{T('Price offered', 'ราคาที่เสนอ')}</dt><dd>฿{money(w.money.quoted)}</dd></div>
              <div><dt>{T('Customer agreed', 'ลูกค้าตกลงสั่ง')}</dt><dd>฿{money(w.money.ordered)}</dd></div>
              <div><dt>{T('Billed so far', 'เรียกเก็บแล้ว')}</dt><dd>฿{money(w.money.invoiced)}</dd></div>
              <div><dt>{T('Paid to us', 'ได้รับเงินแล้ว')}</dt><dd class="text-success">฿{money(w.money.paid)}</dd></div>
              <div><dt>{T('Still owed', 'ยังค้างอยู่')}</dt><dd class:text-warning={w.money.outstanding > 0}>฿{money(w.money.outstanding)}</dd></div>
              <div><dt>{T('What the materials cost us', 'ต้นทุนของที่ใช้')}</dt><dd>฿{money(w.materialCost)}</dd></div>
            </dl>
            {#if w.wht.length && w.money.outstanding > 0}
              <p class="callout info small">{T('This customer is a company, so by law they will keep back part of the payment as tax (withholding tax):', 'ลูกค้าเป็นบริษัท ตามกฎหมายเขาจะหักเงินส่วนหนึ่งไว้เป็นภาษี (ภาษีหัก ณ ที่จ่าย):')} {w.wht.map((x: any) => `${L(x.label)} ฿${money(x.amount)}`).join(', ')}. {T('That is normal — when they pay, ask them for the “50 Tawi” certificate, which proves the tax was paid for you.', 'เป็นเรื่องปกติ เมื่อลูกค้าจ่ายเงิน ให้ขอ “หนังสือรับรอง 50 ทวิ” ไว้เป็นหลักฐานว่าเขาจ่ายภาษีแทนเราแล้ว')}</p>
            {/if}
            {#if w.money.outstanding > 0 && can('money.write')}
              <a class="btn primary" href={`/money?pay=in&partyId=${w.job.partyId}`}>{T('The customer paid — record it', 'ลูกค้าจ่ายแล้ว — บันทึกรับเงิน')}</a>
            {/if}
          </section>
          <section class="section">
            <header><h2>{T('Money received for this job', 'เงินที่ได้รับของงานนี้')}</h2></header>
            <ul class="rows">
              {#each w.payments as p (p.id)}
                <li class:void={p.voided}><span class="grow">{date(p.date)} · {L(app.boot.pack.paymentMethods.find((x: any) => x.id === p.method)?.label) || p.method}{#if p.whtAmount}{' · '}{T('tax kept back', 'หักภาษีไว้')} ฿{money(p.whtAmount)}{/if}{#if p.reference}{' · '}{p.reference}{/if} <span class="ref">{p.number}</span></span><span class="num">฿{money(p.amount)}</span></li>
              {:else}<li class="muted small">{T('No money received yet.', 'ยังไม่ได้รับเงิน')}</li>{/each}
            </ul>
          </section>
        {:else if tab === 'timeline'}
          <Timeline events={w.timeline} />
        {/if}
      </div>

      <aside class="side">
        <section>
          <h3 class="eyebrow">{T('Who and when', 'ใครดูแล และเมื่อไร')}</h3>
          <dl class="facts">
            <dt>{T('In charge', 'ผู้ดูแลงาน')}</dt>
            <dd><select class="bare" value={w.job.ownerId ?? ''} onchange={(e) => setOwner((e.target as HTMLSelectElement).value)}>
              <option value="">—</option>{#each app.boot.users.filter((u: any) => u.active) as u (u.id)}<option value={u.id}>{u.name}</option>{/each}
            </select></dd>
            <dt>{T('Finish by', 'ต้องเสร็จภายใน')}</dt>
            <dd><input class="bare" type="date" value={w.job.dueDate ?? ''} onchange={(e) => setDue((e.target as HTMLInputElement).value)} /></dd>
            <dt>{T('Started', 'เริ่มงานเมื่อ')}</dt><dd>{date(w.job.createdAt)}</dd>
          </dl>
        </section>
        <section>
          <h3 class="eyebrow">{T('Job details', 'รายละเอียดงาน')}</h3>
          <p class="tiny muted">{T('Click any value to change it.', 'กดที่ข้อมูลเพื่อแก้ไข')}</p>
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
            <h3 class="eyebrow">{T('Photos & files', 'รูปและไฟล์')} ({w.files.length})</h3>
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
            <td><strong class="w5">{L(docTypeDef(d.type)?.label)}</strong> <span class="ref">{d.number ?? T('draft', 'ร่าง')}</span></td>
            <td class="small muted nowrap">{date(d.date)}</td>
            <td><StatePill label={d.stateLabel} tone={d.tone} /></td>
            <td class="num">฿{money(d.total)}</td>
            <td class="num small">{#if d.balance !== null}{#if d.balance > 0}<span class:text-danger={d.overdue} class:text-warning={!d.overdue}>{T('still owed', 'ค้าง')} ฿{money(d.balance)}</span>{:else}<span class="text-success">{T('paid', 'จ่ายครบ')}</span>{/if}{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="muted small">{T('No paperwork yet. Usually you start by making a quotation (price offer) for the customer.', 'ยังไม่มีเอกสาร ปกติจะเริ่มจากทำใบเสนอราคาให้ลูกค้า')}</p>
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
  .money-strip dt { font-size: 0.82rem; color: var(--muted); }
  .pipe-lbl { margin-bottom: 6px; }
  .w5 { font-weight: 500; }
  .money-strip dd { margin: 0; font-weight: 600; font-size: 1.05rem; }
  .pipe { margin: 16px 0 22px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; }
  .side { display: flex; flex-direction: column; gap: 0; font-size: 0.95rem; }
  .side > section { padding: 16px 0; border-top: 1px solid var(--line); }
  .side > section:first-child { border-top: 0; padding-top: 0; }
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
  .money-grid dt { font-size: 0.86rem; color: var(--muted); }
  .money-grid dd { margin: 0; font-size: 1.1rem; font-weight: 600; }
  .void { opacity: 0.5; text-decoration: line-through; }
  .files { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .files img { width: 84px; height: 64px; object-fit: cover; border-radius: 5px; border: 1px solid var(--line); display: block; }
  @media (max-width: 1050px) {
    .layout { grid-template-columns: 1fr; }
    .head { flex-direction: column; }
  }
</style>
