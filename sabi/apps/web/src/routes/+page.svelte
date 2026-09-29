<script lang="ts">
  import { get, post } from '$lib/api.ts';
  import { app, T, roleLabel, docTypeDef } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date, dueText, ago, userName, initials, qty, unit, mentionHtml } from '$lib/format.ts';
  import StatePill from '$components/StatePill.svelte';
  import Missing from '$components/Missing.svelte';
  import Timeline from '$components/Timeline.svelte';

  const r = resource(() => get('attention'));
  const a = $derived(r.data as any);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Bangkok' }).format(new Date()));
  const greet = $derived(hour < 12 ? T('Good morning', 'อรุณสวัสดิ์') : hour < 17 ? T('Good afternoon', 'สวัสดีตอนบ่าย') : T('Good evening', 'สวัสดีตอนเย็น'));
  const firstName = $derived(app.boot.user.name.split(' ')[0]);
  const needsCount = $derived(a ? a.approvals.length + a.tasks.length + a.mentions.length + a.nextSteps.length + a.docsWaiting.length : 0);

  async function markSeen() {
    await post('read', { subjectType: 'home', subjectId: 'home' });
    r.reload();
  }
  const hrefFor = (type: string, id: string) => `/${type === 'party' ? 'parties' : type + 's'}/${id}`;
</script>

<svelte:head><title>{T('Today', 'วันนี้')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <p class="muted small">{date(app.today)} · {T('You are signed in as', 'คุณเข้าใช้ในฐานะ')} {roleLabel(app.boot.user.role)}</p>
      <h1>{greet}, {firstName}</h1>
      {#if a}
        <p class="hint">
          {#if needsCount}
            {T('This page shows only what needs you today. Start at the top — the most urgent things come first.', 'หน้านี้แสดงเฉพาะเรื่องที่ต้องให้คุณทำวันนี้ เริ่มจากด้านบนก่อน เรื่องที่ด่วนที่สุดอยู่บนสุด')}
          {:else}
            {T('Nothing is waiting for you right now. New work will appear here when it needs you.', 'ตอนนี้ไม่มีเรื่องที่รอคุณ เมื่อมีงานที่ต้องให้คุณทำ จะขึ้นที่หน้านี้')}
          {/if}
        </p>
      {/if}
    </div>
  </header>

  {#if !a}
    <p class="muted">{T('Loading…', 'กำลังโหลด…')}</p>
  {:else}
    {#if needsCount}
      <ul class="summary" aria-label={T('Summary', 'สรุป')}>
        {#if a.approvals.length}<li><a href="#approvals"><strong class="num">{a.approvals.length}</strong> {T('waiting for your OK', 'เรื่องรอคุณอนุมัติ')}</a></li>{/if}
        {#if a.mentions.length}<li><a href="#mentions"><strong class="num">{a.mentions.length}</strong> {T(a.mentions.length === 1 ? 'message for you' : 'messages for you', 'ข้อความถึงคุณ')}</a></li>{/if}
        {#if a.nextSteps.length}<li><a href="#jobs"><strong class="num">{a.nextSteps.length}</strong> {T(a.nextSteps.length === 1 ? 'job waiting for you' : 'jobs waiting for you', 'งานที่ถึงตาคุณ')}</a></li>{/if}
        {#if a.tasks.length}<li><a href="#todo"><strong class="num">{a.tasks.length}</strong> {T('to-dos', 'สิ่งที่ต้องทำ')}</a></li>{/if}
        {#if a.docsWaiting.length}<li><a href="#docs"><strong class="num">{a.docsWaiting.length}</strong> {T('unfinished documents', 'เอกสารที่ยังไม่เสร็จ')}</a></li>{/if}
      </ul>
    {/if}
    <div class="cols">
      <div class="main">
        {#if a.approvals.length}
          <section class="section" id="approvals">
            <header><h2>{T('Waiting for your OK', 'รอคุณอนุมัติ')}</h2></header>
            <p class="hint">{T('Someone on the team needs you to check these before they can continue. Open each one and choose Approve or Reject.', 'มีคนในทีมรอให้คุณตรวจก่อนจึงจะทำต่อได้ เปิดดูทีละเรื่องแล้วกด อนุมัติ หรือ ไม่อนุมัติ')}</p>
            <ul class="rows">
              {#each a.approvals as ap (ap.id)}
                <a href={`/documents/${ap.subjectId}`} data-nav>
                  <span class="avatar">{initials(userName(ap.requestedBy))}</span>
                  <span class="grow">
                    <strong>{L(docTypeDef(ap.document?.type)?.label)}</strong> {T('for', 'ของ')} <strong>{ap.document?.partyName}</strong>
                    {#if ap.maxDiscountPct}<span class="text-warning"> — {T(`gives a ${ap.maxDiscountPct}% discount`, `ให้ส่วนลด ${ap.maxDiscountPct}%`)}</span>{/if}
                    <br /><span class="small muted">{T('Asked by', 'ขอโดย')} {userName(ap.requestedBy)} · {ago(ap.requestedAt)}{#if ap.reason}{' · '}{T('reason', 'เหตุผล')}: “{ap.reason}”{/if}</span>
                  </span>
                  <span class="amount num">฿{money(ap.document?.total)}</span>
                  <span class="btn sm primary">{T('Check it', 'เปิดตรวจ')}</span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.mentions.length}
          <section class="section" id="mentions">
            <header><h2>{T('Messages for you', 'ข้อความถึงคุณ')}</h2></header>
            <p class="hint">{T('Someone wrote your name in a message. Open it to read and reply.', 'มีคนพิมพ์ชื่อคุณในข้อความ กดเพื่ออ่านและตอบกลับ')}</p>
            <ul class="rows">
              {#each a.mentions as m (m.id)}
                <a href={hrefFor(m.subjectType, m.subjectId) + '#discussion'} data-nav>
                  <span class="avatar">{initials(userName(m.authorId))}</span>
                  <span class="grow">
                    <span class="small muted"><strong class="ink">{userName(m.authorId)}</strong> {T('wrote in', 'เขียนใน')} <strong class="ink">{L(m.subjectLabel)}</strong> · {ago(m.createdAt)}</span><br />
                    <span class="quote">{@html mentionHtml(m.body)}</span>
                  </span>
                  <span class="btn sm">{T('Reply', 'ตอบ')}</span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.nextSteps.length}
          <section class="section" id="jobs">
            <header><h2>{T('Jobs waiting for you', 'งานที่ถึงตาคุณ')}</h2><a class="small link" href="/jobs">{T('See all jobs', 'ดูงานทั้งหมด')}</a></header>
            <p class="hint">{T('The next step of these jobs is yours. The green line says what to do next.', 'ขั้นต่อไปของงานเหล่านี้เป็นหน้าที่ของคุณ บรรทัดสีเขียวบอกว่าต้องทำอะไรต่อ')}</p>
            <ul class="rows">
              {#each a.nextSteps as s (s.jobId)}
                <a href={`/jobs/${s.jobId}`} data-nav>
                  <span class="grow">
                    <span class="row wrap"><strong>{s.title}</strong> <span class="muted small">· {s.partyName}</span> <span class="ref">{s.number}</span></span>
                    <span class="small">
                      {#if s.next}
                        <span class="nextlbl">{T('Next step', 'ต่อไป')}: {L(s.next.label)}</span>
                        {#if !s.next.ok && s.next.missing[0]}<br /><span class="muted">{T('Before that:', 'ก่อนหน้านั้น:')} <Missing m={s.next.missing[0]} /></span>{/if}
                      {:else if s.hint}<span class="muted">{L(s.hint)}</span>{/if}
                    </span>
                  </span>
                  <span class="stack right">
                    <StatePill label={s.stateLabel} tone={s.tone} />
                    {#if s.idleDays >= 3}<span class="tiny text-warning">{T(`No progress for ${s.idleDays} days`, `ไม่มีความคืบหน้ามา ${s.idleDays} วัน`)}</span>{/if}
                  </span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.tasks.length}
          <section class="section" id="todo">
            <header><h2>{T('Your to-do list', 'สิ่งที่คุณต้องทำ')}</h2></header>
            <p class="hint">{T('Small jobs someone gave to you (or to everyone in your role). Tick them off inside the job when done.', 'งานย่อยที่มีคนมอบให้คุณ (หรือทุกคนในตำแหน่งของคุณ) ทำเสร็จแล้วให้ติ๊กในหน้างานนั้น')}</p>
            <ul class="rows">
              {#each a.tasks as t (t.id)}
                {@const d = dueText(t.due)}
                <a href={hrefFor(t.subjectType, t.subjectId)} data-nav>
                  <span class="grow"><strong class="w5">{t.title}</strong><br /><span class="small muted">{T('In', 'ใน')} {L(t.subjectLabel)}{#if !t.assigneeId && t.role} · {T('for any', 'สำหรับ')} {roleLabel(t.role)}{/if}</span></span>
                  {#if d.text}<span class="small nowrap text-{d.tone}">{d.text}</span>{/if}
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.docsWaiting.length}
          <section class="section" id="docs">
            <header><h2>{T('Documents to finish', 'เอกสารที่ยังไม่เสร็จ')}</h2></header>
            <p class="hint">{T('Quotes, orders and invoices you started or that are waiting on you — for example still a draft, or not sent yet.', 'ใบเสนอราคา ใบสั่ง หรือใบแจ้งหนี้ ที่ยังค้างอยู่กับคุณ เช่น ยังเป็นฉบับร่าง หรือยังไม่ได้ส่ง')}</p>
            <ul class="rows">
              {#each a.docsWaiting as d (d.id)}
                <a href={`/documents/${d.id}`} data-nav>
                  <span class="grow"><strong>{L(docTypeDef(d.type)?.label)}</strong> {T('for', 'ของ')} {d.partyName} {#if d.number}<span class="ref">{d.number}</span>{/if}</span>
                  <span class="amount num">฿{money(d.total)}</span>
                  <StatePill label={d.stateLabel} tone={d.tone} />
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.money}
          <section class="section">
            <header><h2>{T('Money to collect and to pay', 'เงินที่ต้องเก็บ และต้องจ่าย')}</h2><a class="small link" href="/money">{T('Open Money', 'ไปหน้าการเงิน')}</a></header>
            <div class="totals">
              <div><span class="muted small">{T('Customers still owe us', 'ลูกค้ายังค้างจ่ายเรา')}</span><strong class="num">฿{money(a.money.receivableTotal)}</strong></div>
              <div><span class="muted small">{T('We still owe suppliers', 'เรายังค้างจ่ายผู้ขาย')}</span><strong class="num">฿{money(a.money.payableTotal)}</strong></div>
            </div>
            {#if !a.money.overdue.length && !a.money.payableSoon.length}
              <p class="muted small">{T('Nothing is late and nothing has to be paid this week.', 'ไม่มีรายการเลยกำหนด และไม่มีอะไรต้องจ่ายในสัปดาห์นี้')}</p>
            {:else}
              <p class="hint">{T('These are late or due soon. Call the customer, or pay the supplier.', 'รายการเหล่านี้เลยกำหนดหรือใกล้ถึงกำหนด โทรตามลูกค้า หรือจ่ายเงินผู้ขาย')}</p>
            {/if}
            <ul class="rows">
              {#each a.money.overdue as d (d.id)}
                {@const due = dueText(d.dueDate)}
                <a href={`/documents/${d.id}`} data-nav>
                  <span class="grow"><strong>{d.partyName}</strong> {T('has not paid us yet', 'ยังไม่จ่ายเงินเรา')} <span class="ref">{d.number}</span></span>
                  <span class="small text-danger nowrap">{due.text}</span>
                  <span class="amount num">฿{money(d.balance)}</span>
                </a>
              {/each}
              {#each a.money.payableSoon as d (d.id)}
                {@const due = dueText(d.dueDate)}
                <a href={`/documents/${d.id}`} data-nav>
                  <span class="grow">{T('We need to pay', 'เราต้องจ่ายเงินให้')} <strong>{d.partyName}</strong> <span class="ref">{d.number}</span></span>
                  <span class="small nowrap text-{due.tone}">{due.text}</span>
                  <span class="amount num">฿{money(d.balance)}</span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.stock.length}
          <section class="section">
            <header><h2>{T('Products running low', 'สินค้าที่ใกล้หมดหรือไม่พอ')}</h2><a class="small link" href="/items">{T('See all products', 'ดูสินค้าทั้งหมด')}</a></header>
            <p class="hint">{T('Either there is not enough for the jobs already promised, or it is below the amount you want to keep. Consider ordering more.', 'ของไม่พอสำหรับงานที่รับไว้แล้ว หรือเหลือน้อยกว่าที่ควรมีไว้ ควรพิจารณาสั่งซื้อเพิ่ม')}</p>
            <ul class="rows">
              {#each a.stock as s (s.itemId)}
                <a href={`/items/${s.itemId}`} data-nav>
                  <span class="grow">
                    <strong class="w5">{s.name}</strong> <span class="ref">{s.sku}</span><br />
                    <span class="small muted">
                      {T('In stock', 'มีในคลัง')} {qty(s.onHand)} {unit(s.uom)} · {T('already promised to jobs', 'จองไว้ให้งานแล้ว')} {qty(s.reserved)} {unit(s.uom)}{#if s.incoming} · {T('ordered, not arrived yet', 'สั่งแล้ว ยังไม่มาถึง')} {qty(s.incoming)} {unit(s.uom)}{/if}
                    </span>
                  </span>
                  {#if s.short}
                    <span class="pill {s.covered ? 'tone-warning' : 'tone-danger'}">{s.covered ? T('Not enough yet — the order on the way will cover it', 'ยังไม่พอ แต่ของที่สั่งไว้จะพอ') : T(`Missing ${qty(-s.available)} ${unit(s.uom)}`, `ขาดอีก ${qty(-s.available)} ${unit(s.uom)}`)}</span>
                  {:else}
                    <span class="pill tone-neutral">{T('Running low', 'ใกล้หมด')}</span>
                  {/if}
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if !needsCount && !a.money && !a.stock.length}
          <div class="calm">
            <p>{T('All clear. New work shows up here when it needs you.', 'เรียบร้อยทุกอย่าง เมื่อมีงานที่ต้องให้คุณทำจะแสดงที่นี่')}</p>
          </div>
        {/if}
      </div>

      <aside class="side">
        <div class="spread side-head">
          <h2>{T('What others did', 'คนอื่นทำอะไรไปบ้าง')}</h2>
          {#if a.changes.length}<button class="btn ghost sm" onclick={markSeen}>{T('I’ve seen these', 'ดูแล้ว')}</button>{/if}
        </div>
        <p class="hint small">{T('Everything your team changed since you last pressed “I’ve seen these”.', 'สิ่งที่คนในทีมทำ ตั้งแต่คุณกด “ดูแล้ว” ครั้งล่าสุด')}</p>
        {#if a.changes.length}
          <Timeline events={a.changes} showWhere limit={12} />
        {:else}
          <p class="muted small">{T('Nothing new from the team.', 'ยังไม่มีอะไรใหม่จากทีม')}</p>
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 40px; }
  .side { border-left: 1px solid var(--line); padding-left: 28px; }
  .side-head { margin-bottom: 12px; }
  .side h2 { font-size: 1.05rem; }
  .side .hint { margin-bottom: 14px; }
  .summary { list-style: none; margin: -8px 0 26px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 10px; }
  .summary a { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 14px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--ink); background: var(--surface); }
  .summary a:hover { border-color: var(--accent); text-decoration: none; }
  .summary strong { font-size: 1.05rem; color: var(--accent); }
  .totals { display: flex; flex-wrap: wrap; gap: 12px 48px; margin: 6px 0 14px; }
  .totals div { display: flex; flex-direction: column; }
  .totals strong { font-size: 1.35rem; font-weight: 600; }
  .amount { white-space: nowrap; font-weight: 500; }
  .ink { color: var(--ink); font-weight: 500; }
  .w5 { font-weight: 500; }
  .quote { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .nextlbl { color: var(--accent); font-weight: 600; }
  .calm { padding: 40px 0; color: var(--muted); }
  @media (max-width: 1000px) {
    .cols { grid-template-columns: 1fr; }
    .side { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); padding-top: 18px; }
  }
</style>
