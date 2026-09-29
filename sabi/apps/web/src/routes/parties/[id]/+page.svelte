<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { app, T, docTypeDef, can } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, money, date, fmtAddress, dueText } from '$lib/format.ts';
  import StatePill from '$components/StatePill.svelte';
  import PartyForm from '$components/PartyForm.svelte';
  import Discussion from '$components/Discussion.svelte';
  import Timeline from '$components/Timeline.svelte';
  import Tasks from '$components/Tasks.svelte';

  const r = resource(() => get(`parties/${page.params.id}`));
  const v = $derived(r.data as any);
  const p = $derived(v?.party);
  let editing = $state(false);
  let addingContact = $state(false);
  const isCustomer = $derived(p?.roles.includes('customer'));
  const isSupplier = $derived(p?.roles.includes('supplier'));
  const openJobs = $derived(v ? v.jobs.filter((j: any) => j.phase === 'open') : []);
  const doneJobs = $derived(v ? v.jobs.filter((j: any) => j.phase !== 'open') : []);
  const unpaid = $derived(v ? v.documents.filter((d: any) => (d.balance ?? 0) > 0) : []);
  const showField = (f: any, v: any) => {
    if (v === undefined || v === null || v === '') return '—';
    if (f.type === 'boolean') return v ? T('Yes', 'ใช่') : T('No', 'ไม่ใช่');
    if (f.type === 'select') return L(f.options?.find((o: any) => o.value === v)?.label) || v;
    return String(v);
  };
  const extra = $derived([...app.boot.jurisdiction.partyFields, ...app.boot.pack.partyFields]);
</script>

<svelte:head><title>{p?.name ?? ''} · Sabi</title></svelte:head>

{#if r.error}<div class="page"><p class="err-text">{r.error.message}</p></div>
{:else if v}
  <div class="page wide">
    <nav class="small muted crumbs"><a href="/parties">← {T('All customers & suppliers', 'ลูกค้าและผู้ขายทั้งหมด')}</a>{#if v.parent} / <a href={`/parties/${v.parent.id}`}>{v.parent.name}</a>{/if}</nav>
    <header class="head">
      <div class="grow">
        <h1>{p.name}</h1>
        <p class="sub">
          {#each p.roles as role (role)}<span class="pill tone-neutral">{({ customer: T('Customer', 'ลูกค้า'), supplier: T('Supplier', 'ผู้ขาย'), contact: T('Contact person', 'ผู้ติดต่อ') } as Record<string, string>)[role] ?? role}</span> {/each}
          {#if p.phone}<a class="link" href={`tel:${p.phone}`}>{p.phone}</a>{/if}
          {#if p.email} · <a class="link" href={`mailto:${p.email}`}>{p.email}</a>{/if}
        </p>
      </div>
      <div class="row">
        {#if isCustomer}<a class="btn primary" href={`/jobs/new?partyId=${p.id}`}>+ {T('New job for them', 'เปิดงานใหม่ให้ลูกค้านี้')}</a>{/if}
        {#if isSupplier}<a class="btn" href={`/documents/new?type=purchase_order&partyId=${p.id}`}>+ {T('Order from them', 'สั่งของจากผู้ขายนี้')}</a>{/if}
      </div>
    </header>

    {#if v.balance.receivable || v.balance.payable}
      <div class="strip num">
        {#if v.balance.receivable}<div><span class="small muted">{T('They still owe us', 'เขายังค้างจ่ายเรา')}</span><strong class:text-danger={v.balance.overdue > 0}>฿{money(v.balance.receivable)}</strong>{#if v.balance.overdue}<span class="tiny text-danger">{T('of which late', 'ในนี้เลยกำหนดแล้ว')} ฿{money(v.balance.overdue)}</span>{/if}</div>{/if}
        {#if v.balance.payable}<div><span class="small muted">{T('We still owe them', 'เรายังค้างจ่ายเขา')}</span><strong>฿{money(v.balance.payable)}</strong></div>{/if}
        {#if v.balance.receivable && can('money.write')}<a class="btn sm" href={`/money?pay=in&partyId=${p.id}`}>{T('They paid — record it', 'เขาจ่ายแล้ว — บันทึกรับเงิน')}</a>{/if}
      </div>
    {/if}

    <div class="layout">
      <div class="main">
        <section class="section">
          <header><h2>{T('Their jobs', 'งานของลูกค้านี้')}</h2></header>
          {#if openJobs.length || doneJobs.length}
            <ul class="rows">
              {#each [...openJobs, ...doneJobs.slice(0, 5)] as j (j.id)}
                <li><a href={`/jobs/${j.id}`} class="jobrow"><span class="grow"><strong class="w500">{j.title}</strong> <span class="ref">{j.number}</span></span><StatePill label={j.stateLabel} tone={j.tone} /></a></li>
              {/each}
            </ul>
          {:else}<p class="muted small">{T('No jobs yet. Press “New job for them” when they ask for something.', 'ยังไม่มีงาน เมื่อลูกค้าขออะไร กด “เปิดงานใหม่ให้ลูกค้านี้”')}</p>{/if}
        </section>

        {#if unpaid.length}
          <section class="section">
            <header><h2>{T('Bills not paid yet', 'บิลที่ยังไม่ได้จ่าย')}</h2></header>
            <table class="data">
              <tbody>
                {#each unpaid as d (d.id)}
                  {@const due = dueText(d.dueDate)}
                  <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}><td>{L(docTypeDef(d.type)?.label)}</td><td class="mono small">{d.number}</td><td class="small">{date(d.date)}</td><td class="small" class:text-danger={d.overdue}>{d.dueDate ? due.text : ''}</td><td class="num">฿{money(d.balance)}</td></tr>
                {/each}
              </tbody>
            </table>
          </section>
        {/if}

        <section class="section">
          <header><h2>{T('Their documents', 'เอกสารของรายนี้')}</h2><a class="small link" href={`/documents?partyId=${p.id}`}>{T('See all', 'ดูทั้งหมด')}</a></header>
          <table class="data">
            <tbody>
              {#each v.documents.slice(0, 12) as d (d.id)}
                <tr class="clickable" onclick={() => goto(`/documents/${d.id}`)}><td>{L(docTypeDef(d.type)?.label)} <span class="ref">{d.number ?? T('draft', 'ร่าง')}</span></td><td class="small">{date(d.date)}</td><td><StatePill label={d.stateLabel} tone={d.tone} /></td><td class="num">{money(d.total)}</td></tr>
              {:else}<tr><td class="muted small">{T('No documents yet.', 'ยังไม่มีเอกสาร')}</td></tr>{/each}
            </tbody>
          </table>
        </section>

        <section class="section">
          <header><h2>{T('Notes about them', 'บันทึกเกี่ยวกับรายนี้')}</h2></header>
          <p class="hint small">{T('Anything the team should remember: how they like to be contacted, credit, problems, preferences.', 'สิ่งที่ทีมควรรู้ เช่น ชอบให้ติดต่อทางไหน เครดิต ปัญหาที่เคยมี หรือความชอบ')}</p>
          <Discussion subjectType="party" subjectId={p.id} messages={v.messages} files={v.files} onchange={r.reload} placeholder={T('Notes about this customer — preferences, credit, who to call…', 'บันทึกเกี่ยวกับลูกค้า เช่น ความชอบ เครดิต ติดต่อใคร…')} />
        </section>
      </div>

      <aside class="side">
        <section>
          <div class="spread"><h3 class="eyebrow">{T('Contact details', 'ข้อมูลติดต่อ')}</h3>{#if can('parties.write') && !editing}<button class="btn ghost sm" onclick={() => (editing = true)}>{T('Edit', 'แก้ไข')}</button>{/if}</div>
          {#if editing}
            <PartyForm party={p} onsaved={() => { editing = false; r.reload(); }} oncancel={() => (editing = false)} />
          {:else}
            <dl class="facts">
              <dt>{T('Tax ID', 'เลขผู้เสียภาษี')}</dt><dd class="mono">{p.taxId ?? '—'}</dd>
              {#each extra as x (x.key)}<dt>{L(x.label)}</dt><dd>{showField(x, p.fields[x.key])}</dd>{/each}
              <dt>{T('Address', 'ที่อยู่')}</dt><dd>{fmtAddress(p.address) || '—'}</dd>
              {#if p.paymentTermsDays !== undefined && p.paymentTermsDays !== null}<dt>{T('Pays within', 'เครดิต')}</dt><dd>{p.paymentTermsDays} {T('days', 'วัน')}</dd>{/if}
            </dl>
          {/if}
        </section>
        {#if !v.parent}
          <section>
            <div class="spread"><h3 class="eyebrow">{T('People to talk to', 'ผู้ติดต่อ')}</h3>{#if can('parties.write')}<button class="btn ghost sm" onclick={() => (addingContact = !addingContact)}>+ {T('Add person', 'เพิ่มคน')}</button>{/if}</div>
            {#if addingContact}<PartyForm parentId={p.id} onsaved={() => { addingContact = false; r.reload(); }} oncancel={() => (addingContact = false)} />{/if}
            <ul class="plain">
              {#each v.contacts as c (c.id)}<li><a class="link" href={`/parties/${c.id}`}>{c.name}</a>{#if c.phone} · <a href={`tel:${c.phone}`} class="small">{c.phone}</a>{/if}</li>
              {:else}<li class="small muted">{T('Nobody added yet', 'ยังไม่มี')}</li>{/each}
            </ul>
          </section>
        {/if}
        <section>
          <h3 class="eyebrow">{T('Things to follow up', 'เรื่องที่ต้องติดตาม')}</h3>
          <Tasks subjectType="party" subjectId={p.id} tasks={v.tasks} onchange={r.reload} />
        </section>
        {#if v.payments.length}
          <section>
            <h3 class="eyebrow">{T('Money in and out', 'การรับ–จ่ายเงิน')}</h3>
            <ul class="plain small">{#each v.payments.slice(0, 8) as pm (pm.id)}<li class:void={pm.voided}>{date(pm.date)} · {pm.direction === 'out' ? T('we paid', 'เราจ่าย') : T('they paid', 'เขาจ่าย')} ฿{money(pm.amount)} <a class="ref" href={`/payments/${pm.id}/print`}>{pm.number}</a></li>{/each}</ul>
          </section>
        {/if}
        <section>
          <h3 class="eyebrow">{T('History', 'ประวัติ')}</h3>
          <Timeline events={v.timeline} limit={10} />
        </section>
      </aside>
    </div>
  </div>
{:else}<div class="page"><p class="muted">{T('Loading…', 'กำลังโหลด…')}</p></div>{/if}

<style>
  .wide { max-width: 1240px; }
  .crumbs { margin-bottom: 8px; }
  .head { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 16px; }
  .sub { margin-top: 6px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 0.92rem; }
  .strip { display: flex; gap: 36px; align-items: center; padding: 12px 0 16px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
  .strip > div { display: flex; flex-direction: column; }
  .strip strong { font-size: 1.25rem; font-weight: 600; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 40px; }
  .side { display: flex; flex-direction: column; gap: 22px; font-size: 0.9rem; }
  .side h3 { margin-bottom: 8px; }
  .jobrow { display: flex; gap: 12px; align-items: center; padding: 8px 4px; color: inherit; text-decoration: none; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  .plain { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
  .void { opacity: 0.5; text-decoration: line-through; }
  @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
</style>
