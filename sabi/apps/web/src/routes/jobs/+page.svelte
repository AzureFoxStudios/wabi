<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get } from '$lib/api.ts';
  import { app, T, jobTypeDef } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, moneyShort, ago, dueText, userName, initials, date } from '$lib/format.ts';
  import StatePill from '$components/StatePill.svelte';

  let phase = $state(page.url.searchParams.get('phase') ?? 'open');
  let type = $state(page.url.searchParams.get('type') ?? '');
  let mine = $state(false);
  let search = $state('');
  let stateFilter = $state('');

  const r = resource(() => get('jobs', { phase: phase === 'all' ? undefined : phase, type, mine, search }));
  const jobs = $derived((r.data as any[]) ?? []);
  const types = $derived(app.boot.pack.jobTypes);

  // Group by workflow state in pipeline order across job types.
  const groups = $derived.by(() => {
    const order: { key: string; label: any; tone: string; jobs: any[]; type: any }[] = [];
    const byKey = new Map<string, (typeof order)[number]>();
    for (const t of types) {
      if (type && t.id !== type) continue;
      for (const s of t.workflow.states) {
        const key = `${t.id}:${s.id}`;
        const g = { key, label: s.label, tone: s.tone ?? 'neutral', jobs: [] as any[], type: t };
        byKey.set(key, g);
        order.push(g);
      }
    }
    for (const j of jobs) byKey.get(`${j.type}:${j.state}`)?.jobs.push(j);
    return order.filter((g) => g.jobs.length);
  });
  const multi = $derived(!type && new Set(jobs.map((j) => j.type)).size > 1);
  // Summary values: show select options by their label, not their stored value.
  const showField = (jobType: string, k: string, v: any) => {
    const f = jobTypeDef(jobType)?.fields.find((x: any) => x.key === k);
    return f?.type === 'select' ? L(f.options?.find((o: any) => o.value === v)?.label) || v : v;
  };
  const visible = $derived(stateFilter ? groups.filter((g) => g.key === stateFilter) : groups);
</script>

<svelte:head><title>{T('Jobs', 'งาน')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <h1>{T('Jobs', 'งาน')}</h1>
      <p class="muted small">{T('Every customer request, from first call to paid.', 'ทุกงานของลูกค้า ตั้งแต่สอบถามจนรับเงิน')}</p>
    </div>
    <a class="btn primary" href="/jobs/new">+ {T('New job', 'งานใหม่')}</a>
  </header>

  <div class="filters">
    <div class="seg" role="tablist">
      {#each [['open', T('Open', 'กำลังทำ')], ['done', T('Done', 'เสร็จแล้ว')], ['cancelled', T('Lost', 'ไม่ได้งาน')], ['all', T('All', 'ทั้งหมด')]] as [v, lbl] (v)}
        <button role="tab" aria-selected={phase === v} class:on={phase === v} onclick={() => ((phase = v), (stateFilter = ''))}>{lbl}</button>
      {/each}
    </div>
    <select bind:value={type} aria-label={T('Job type', 'ประเภทงาน')}>
      <option value="">{T('All types', 'ทุกประเภท')}</option>
      {#each types as t (t.id)}<option value={t.id}>{L(t.label)}</option>{/each}
    </select>
    <label class="row small"><input type="checkbox" bind:checked={mine} /> {T('Mine', 'ของฉัน')}</label>
    <input class="grow" type="search" bind:value={search} placeholder={T('Search number, title, customer…', 'ค้นหาเลขที่ ชื่องาน ลูกค้า…')} />
  </div>

  {#if groups.length > 1}
    <div class="stages">
      {#each groups as g (g.key)}
        <button class:on={stateFilter === g.key} onclick={() => (stateFilter = stateFilter === g.key ? '' : g.key)}>
          <span class="n">{g.jobs.length}</span> <span class="small">{L(g.label)}</span>{#if multi}<span class="tiny faint"> · {L(g.type.label)}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  {#each visible as g (g.key)}
    <section class="grp">
      <h2 class="eyebrow"><StatePill label={g.label} tone={g.tone} /> {#if multi}<span class="typ">{L(g.type.label)}</span>{/if} <span class="faint">{g.jobs.length}</span></h2>
      <ul class="rows">
        {#each g.jobs as j (j.id)}
          {@const due = dueText(j.summaryFields.delivery_date ?? j.dueDate)}
          <a href={`/jobs/${j.id}`} data-nav class="job">
            <span class="num mono muted id">{j.number}</span>
            <span class="grow">
              <span class="title" class:unread={j.unread}>{j.title}</span>
              <span class="small muted"> · {j.partyName}</span>
              <br />
              <span class="small muted">
                {#each Object.entries(j.summaryFields).filter(([k, v]) => v && k !== 'delivery_date') as [k, v] (k)}{showField(j.type, k, v)} · {/each}
                {L(jobTypeDef(j.type)?.label)}
              </span>
            </span>
            <span class="money small num right">
              {#if j.money.outstanding > 0}<span class="text-warning">{T('Due', 'ค้าง')} {moneyShort(j.money.outstanding)}</span>
              {:else if j.money.invoiced > 0}<span class="text-success">{T('Paid', 'รับแล้ว')} {moneyShort(j.money.paid)}</span>
              {:else if j.money.ordered > 0}{T('Order', 'สั่ง')} {moneyShort(j.money.ordered)}
              {:else if j.money.quoted > 0}<span class="muted">{T('Quote', 'เสนอ')} {moneyShort(j.money.quoted)}</span>{/if}
            </span>
            <span class="meta small right">
              {#if due.text}<span class="text-{due.tone}">{due.text}</span><br />{/if}
              <span class="faint tiny">{ago(j.lastAt)}</span>
            </span>
            <span class="avatar" title={userName(j.ownerId)}>{j.ownerId ? initials(userName(j.ownerId)) : '·'}</span>
          </a>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="muted empty">{r.loading ? T('Loading…', 'กำลังโหลด…') : T('No jobs here.', 'ไม่มีงาน')}</p>
  {/each}
</div>

<style>
  .typ { text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--muted); }
  .filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .filters select { width: auto; }
  .seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); overflow: hidden; background: var(--surface); }
  .seg button { font: inherit; font-size: 0.88rem; background: none; border: 0; padding: 6px 12px; cursor: pointer; color: var(--muted); border-left: 1px solid var(--line); }
  .seg button:first-child { border-left: 0; }
  .seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
  .stages { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 18px; }
  .stages button { font: inherit; display: inline-flex; align-items: baseline; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; cursor: pointer; }
  .stages button.on { border-color: var(--accent); background: var(--accent-soft); }
  .stages .n { font-weight: 600; font-variant-numeric: tabular-nums; }
  .grp { margin-bottom: 22px; }
  .grp h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .job .id { width: 92px; flex: none; font-size: 0.8rem; }
  .title { font-weight: 500; }
  .title.unread::after { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-left: 6px; vertical-align: middle; }
  .money { width: 120px; flex: none; }
  .meta { width: 110px; flex: none; line-height: 1.3; }
  .empty { padding: 30px 0; }
  @media (max-width: 760px) { .money, .job .id { display: none; } }
</style>
