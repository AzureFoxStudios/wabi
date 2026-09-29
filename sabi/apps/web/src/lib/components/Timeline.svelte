<script lang="ts">
  import { T } from '$lib/state.svelte.ts';
  import { L, date, time, userName, initials } from '$lib/format.ts';
  let { events, showWhere = false, limit = 0 }: { events: any[]; showWhere?: boolean; limit?: number } = $props();
  let all = $state(false);
  const shown = $derived(limit && !all ? events.slice(0, limit) : events);
  const groups = $derived.by(() => {
    const out: { day: string; items: any[] }[] = [];
    for (const e of shown) {
      const day = new Date(new Date(e.at).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  });
</script>

<div class="tl">
  {#each groups as g (g.day)}
    <h4 class="eyebrow">{date(g.day)}</h4>
    <ol>
      {#each g.items as e (e.seq)}
        <li class:auto={e.auto}>
          <span class="avatar" class:sys={e.actorId === 'system' || e.auto}>{e.actorId === 'system' ? 'S' : initials(userName(e.actorId))}</span>
          <div class="grow">
            <p><span class="who">{userName(e.actorId)}</span> <span class="what tone-text-{e.tone ?? 'neutral'}">{L(e.summary)}</span>
              {#if e.auto}<span class="tiny faint">· {T('automatic', 'อัตโนมัติ')}</span>{/if}
              {#if showWhere && e.where}<a class="small link" href={`/${e.where.subjectType === 'party' ? 'parties' : e.where.subjectType + 's'}/${e.where.subjectId}`}>{e.where.label}</a>{/if}
            </p>
            {#if e.detail}<p class="detail small">“{e.detail.length > 240 ? e.detail.slice(0, 240) + '…' : e.detail}”</p>{/if}
          </div>
          <time class="tiny faint">{time(e.at)}</time>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="muted small">{T('Nothing yet.', 'ยังไม่มีความเคลื่อนไหว')}</p>
  {/each}
  {#if limit && events.length > limit && !all}
    <button class="btn ghost sm" onclick={() => (all = true)}>{T(`Show all ${events.length}`, `แสดงทั้งหมด ${events.length}`)}</button>
  {/if}
</div>

<style>
  .tl h4 { margin: 14px 0 6px; }
  .tl h4:first-child { margin-top: 0; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; font-size: 0.9rem; }
  li .avatar { width: 22px; height: 22px; font-size: 0.64rem; }
  .who { font-weight: 500; }
  .auto .what { color: var(--muted); }
  .detail { color: var(--ink-2); margin-top: 2px; border-left: 2px solid var(--line-strong); padding-left: 8px; }
  .tone-text-success { color: var(--t-success); }
  .tone-text-danger { color: var(--t-danger); }
  .tone-text-warning { color: var(--t-warning); }
</style>
