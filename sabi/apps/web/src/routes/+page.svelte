<script lang="ts">
  import { get, post } from '$lib/api.ts';
  import { app, T, roleLabel, docTypeDef } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date, dueText, ago, userName, initials, qty } from '$lib/format.ts';
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
      <p class="muted small">{date(app.today)} · {roleLabel(app.boot.user.role)}</p>
      <h1>{greet}, {firstName}</h1>
    </div>
    {#if a}
      <p class="muted">{needsCount ? T(needsCount === 1 ? '1 thing needs you' : `${needsCount} things need you`, `มี ${needsCount} เรื่องรอคุณอยู่`) : T('Nothing is waiting on you.', 'ไม่มีเรื่องค้างที่รอคุณ')}</p>
    {/if}
  </header>

  {#if !a}
    <p class="muted">{T('Loading…', 'กำลังโหลด…')}</p>
  {:else}
    <div class="cols">
      <div class="main">
        {#if a.approvals.length}
          <section class="section">
            <header><h2>{T('Waiting for your approval', 'รอคุณอนุมัติ')}</h2></header>
            <ul class="rows">
              {#each a.approvals as ap (ap.id)}
                <a href={`/documents/${ap.subjectId}`} data-nav>
                  <span class="avatar">{initials(userName(ap.requestedBy))}</span>
                  <span class="grow">
                    <strong>{L(docTypeDef(ap.document?.type)?.label)}</strong> {T('for', 'ของ')} {ap.document?.partyName}
                    · <span class="num">฿{money(ap.document?.total)}</span>
                    {#if ap.maxDiscountPct}<span class="text-warning"> · {T('discount', 'ส่วนลด')} {ap.maxDiscountPct}%</span>{/if}
                    <br /><span class="small muted">{userName(ap.requestedBy)}: “{ap.reason}” · {ago(ap.requestedAt)}</span>
                  </span>
                  <span class="btn sm">{T('Review', 'ตรวจสอบ')}</span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.mentions.length}
          <section class="section">
            <header><h2>{T('Mentioned you', 'มีคนเรียกคุณ')}</h2></header>
            <ul class="rows">
              {#each a.mentions as m (m.id)}
                <a href={hrefFor(m.subjectType, m.subjectId) + '#discussion'} data-nav>
                  <span class="avatar">{initials(userName(m.authorId))}</span>
                  <span class="grow">
                    <span class="small muted">{userName(m.authorId)} · {m.subjectLabel} · {ago(m.createdAt)}</span><br />
                    <span class="quote">{m.body}</span>
                  </span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.nextSteps.length}
          <section class="section">
            <header><h2>{T('Jobs waiting on you', 'งานที่รอคุณดำเนินการ')}</h2><a class="small link" href="/jobs">{T('All jobs', 'งานทั้งหมด')}</a></header>
            <ul class="rows">
              {#each a.nextSteps as s (s.jobId)}
                <a href={`/jobs/${s.jobId}`} data-nav>
                  <span class="grow">
                    <span class="row wrap"><span class="mono muted">{s.number}</span> <strong>{s.title}</strong> <span class="muted small">· {s.partyName}</span></span>
                    <span class="small">
                      {#if s.next}
                        <span class="nextlbl">{T('Next', 'ถัดไป')}: {L(s.next.label)}</span>
                        {#if !s.next.ok && s.next.missing[0]}<span class="muted"> — <Missing m={s.next.missing[0]} /></span>{/if}
                      {:else if s.hint}<span class="muted">{L(s.hint)}</span>{/if}
                    </span>
                  </span>
                  <span class="stack right">
                    <StatePill label={s.stateLabel} tone={s.tone} />
                    {#if s.idleDays >= 3}<span class="tiny text-warning">{T(`idle ${s.idleDays} days`, `ไม่ขยับ ${s.idleDays} วัน`)}</span>{/if}
                  </span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.tasks.length}
          <section class="section">
            <header><h2>{T('Your tasks', 'งานที่ต้องทำ')}</h2></header>
            <ul class="rows">
              {#each a.tasks as t (t.id)}
                {@const d = dueText(t.due)}
                <a href={hrefFor(t.subjectType, t.subjectId)} data-nav>
                  <span class="grow">{t.title}<br /><span class="small muted">{t.subjectLabel}{#if !t.assigneeId && t.role} · {T('for', 'สำหรับ')} {roleLabel(t.role)}{/if}</span></span>
                  {#if d.text}<span class="small nowrap text-{d.tone}">{d.text}</span>{/if}
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.docsWaiting.length}
          <section class="section">
            <header><h2>{T('Documents to finish', 'เอกสารที่รอดำเนินการ')}</h2></header>
            <ul class="rows">
              {#each a.docsWaiting as d (d.id)}
                <a href={`/documents/${d.id}`} data-nav>
                  <span class="grow"><strong>{L(docTypeDef(d.type)?.label)}</strong> {d.number ?? T('(draft)', '(ร่าง)')} <span class="muted small">· {d.partyName}</span></span>
                  <span class="num small">฿{money(d.total)}</span>
                  <StatePill label={d.stateLabel} tone={d.tone} />
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.money}
          <section class="section">
            <header>
              <h2>{T('Money', 'การเงิน')}</h2>
              <span class="small muted">{T('To collect', 'รอเก็บเงิน')} <strong class="num">฿{money(a.money.receivableTotal)}</strong> · {T('To pay', 'รอจ่าย')} <strong class="num">฿{money(a.money.payableTotal)}</strong></span>
            </header>
            {#if !a.money.overdue.length && !a.money.payableSoon.length}
              <p class="muted small">{T('Nothing overdue, nothing due this week.', 'ไม่มีหนี้เกินกำหนด และไม่มีรายการครบกำหนดสัปดาห์นี้')}</p>
            {/if}
            <ul class="rows">
              {#each a.money.overdue as d (d.id)}
                {@const due = dueText(d.dueDate)}
                <a href={`/documents/${d.id}`} data-nav>
                  <span class="grow"><strong>{d.partyName}</strong> <span class="muted small">· {d.number}</span></span>
                  <span class="small text-danger nowrap">{due.text}</span>
                  <span class="num">฿{money(d.balance)}</span>
                </a>
              {/each}
              {#each a.money.payableSoon as d (d.id)}
                {@const due = dueText(d.dueDate)}
                <a href={`/documents/${d.id}`} data-nav>
                  <span class="grow">{T('Pay', 'จ่าย')} <strong>{d.partyName}</strong> <span class="muted small">· {d.number}</span></span>
                  <span class="small nowrap text-{due.tone}">{due.text}</span>
                  <span class="num">฿{money(d.balance)}</span>
                </a>
              {/each}
            </ul>
          </section>
        {/if}

        {#if a.stock.length}
          <section class="section">
            <header><h2>{T('Stock to watch', 'สต็อกที่ต้องดู')}</h2><a class="small link" href="/items">{T('Stock', 'สต็อก')}</a></header>
            <ul class="rows">
              {#each a.stock as s (s.itemId)}
                <a href={`/items/${s.itemId}`} data-nav>
                  <span class="grow">
                    <span class="mono muted">{s.sku}</span> {s.name}<br />
                    <span class="small muted">
                      {T('On hand', 'คงเหลือ')} {qty(s.onHand)} · {T('promised', 'จองแล้ว')} {qty(s.reserved)}{#if s.incoming} · {T('on order', 'กำลังมา')} {qty(s.incoming)}{/if} {s.uom}
                      {#if s.jobs.length} · {s.jobs.map((j: any) => j.number).join(', ')}{/if}
                    </span>
                  </span>
                  {#if s.short}
                    <span class="pill {s.covered ? 'tone-warning' : 'tone-danger'}">{s.covered ? T('Short, PO covers it', 'ขาด แต่สั่งแล้ว') : T(`Short ${qty(-s.available)} ${s.uom}`, `ขาด ${qty(-s.available)} ${s.uom}`)}</span>
                  {:else}
                    <span class="pill tone-neutral">{T('Below reorder point', 'ต่ำกว่าจุดสั่งซื้อ')}</span>
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
          <h2>{T('Since you last looked', 'ตั้งแต่ครั้งที่แล้ว')}</h2>
          {#if a.changes.length}<button class="btn ghost sm" onclick={markSeen}>{T('Mark seen', 'อ่านแล้ว')}</button>{/if}
        </div>
        {#if a.changes.length}
          <Timeline events={a.changes} showWhere limit={25} />
        {:else}
          <p class="muted small">{T('No changes by others since your last visit.', 'ไม่มีการเปลี่ยนแปลงจากคนอื่นตั้งแต่ครั้งที่แล้ว')}</p>
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 40px; }
  .side { border-left: 1px solid var(--line); padding-left: 28px; }
  .side-head { margin-bottom: 12px; }
  .side h2 { font-size: 0.95rem; }
  .quote { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .nextlbl { color: var(--accent); font-weight: 500; }
  .calm { padding: 40px 0; color: var(--muted); }
  @media (max-width: 1000px) {
    .cols { grid-template-columns: 1fr; }
    .side { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); padding-top: 18px; }
  }
</style>
