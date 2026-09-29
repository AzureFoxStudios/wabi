<script lang="ts">
  import { command, ApiError } from '$lib/api.ts';
  import { T, toast } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';
  import Missing from './Missing.svelte';

  let {
    transitions, subjectType, subjectId, fields = [], hint = null, onchange = () => {},
  }: {
    transitions: any[]; subjectType: 'job' | 'document'; subjectId: string; fields?: any[]; hint?: any; onchange?: () => void;
  } = $props();

  const forward = $derived(transitions.filter((t) => t.phase !== 'cancelled' && t.phase !== 'void'));
  const primary = $derived(forward.find((t) => t.primary && !t.auto && t.ok) ?? forward.find((t) => t.primary && !t.auto) ?? forward.find((t) => !t.auto && t.ok));
  const autos = $derived(forward.filter((t) => t.auto && t.primary && !t.ok));
  const others = $derived(transitions.filter((t) => t !== primary && !t.auto));
  let asking = $state<any>(null);
  let reason = $state('');
  let busy = $state(false);
  let blocked = $state<any[] | null>(null);

  async function run(t: any, withReason?: string) {
    if (t.requireReason && !withReason) {
      asking = t;
      reason = '';
      return;
    }
    busy = true;
    try {
      const r = await command(`${subjectType}.transition`, { id: subjectId, transition: t.id, reason: withReason });
      asking = null;
      blocked = null;
      toast(`${L(t.label)} ✓`, 'success');
      for (const w of r?.warnings ?? []) toast(L(w.message), 'warning');
      onchange();
    } catch (e) {
      if (e instanceof ApiError && e.details?.missing) blocked = e.details.missing;
      else if (e instanceof ApiError && e.details?.issues) blocked = e.details.issues.map((i: any) => ({ kind: 'issue', ...i }));
      else toast((e as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }

  async function requestApproval(t: any) {
    busy = true;
    try {
      await command('approval.request', { subjectType, subjectId, transitionId: t.id });
      toast(T('Approval requested', 'ส่งคำขออนุมัติแล้ว'), 'success');
      onchange();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
</script>

<div class="next">
  {#if hint}<p class="hint">{L(hint)}</p>{/if}

  {#if primary}
    <div class="row wrap">
      <button class="btn primary lg" disabled={!primary.ok || busy} onclick={() => run(primary)}>
        {L(primary.label)} →
      </button>
      {#each others.filter((o) => o.phase !== 'cancelled' && o.phase !== 'void' && o.tone !== 'danger') as o (o.id)}
        <button class="btn" class:warning={o.tone === 'warning'} disabled={busy || !o.ok} onclick={() => run(o)} title={o.ok ? '' : T('Not available yet', 'ยังทำไม่ได้')}>{L(o.label)}</button>
      {/each}
    </div>
    {#if !primary.ok}
      <ul class="missing">
        {#each primary.missing as m, i (i)}
          <li>
            <Missing {m} {fields} />
            {#if m.kind === 'approval' && m.status !== 'pending'}
              <button class="btn sm" disabled={busy} onclick={() => requestApproval(primary)}>{T('Ask for approval', 'ขออนุมัติ')}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if !autos.length}
    <p class="muted small">{T('Nothing left to do here.', 'ไม่มีขั้นตอนถัดไป')}</p>
  {/if}

  {#each autos as a (a.id)}
    <p class="auto small">
      <span class="muted">{T('Moves to', 'จะเปลี่ยนเป็น')} <strong>{L(a.toLabel)}</strong> {T('automatically when:', 'อัตโนมัติเมื่อ:')}</span>
      {#each a.missing as m, i (i)}<span class="req"><Missing {m} {fields} /></span>{/each}
    </p>
  {/each}

  {#if blocked}
    <div class="callout danger small">
      <strong>{T('Not yet:', 'ยังทำไม่ได้:')}</strong>
      <ul>
        {#each blocked as m, i (i)}<li>{#if m.kind === 'issue'}{L(m.message)}{:else}<Missing {m} {fields} />{/if}</li>{/each}
      </ul>
    </div>
  {/if}

  {#if asking}
    <form class="reason" onsubmit={(e) => (e.preventDefault(), run(asking, reason.trim()))}>
      <label class="field"><span>{L(asking.label)} — {T('why?', 'เหตุผล')}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <textarea bind:value={reason} rows="2" autofocus required></textarea>
      </label>
      <div class="row">
        <button class="btn" class:danger={asking.tone === 'danger'} disabled={!reason.trim() || busy}>{L(asking.label)}</button>
        <button type="button" class="btn ghost" onclick={() => (asking = null)}>{T('Cancel', 'ยกเลิก')}</button>
      </div>
    </form>
  {/if}

  {#if others.some((o) => o.tone === 'danger' || o.phase === 'cancelled' || o.phase === 'void')}
    <details class="more">
      <summary class="small muted">{T('Other actions', 'การดำเนินการอื่น')}</summary>
      <div class="row wrap">
        {#each others.filter((o) => o.tone === 'danger' || o.phase === 'cancelled' || o.phase === 'void') as o (o.id)}
          <button class="btn sm danger" disabled={busy || !o.ok} onclick={() => run(o)}>{L(o.label)}</button>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  .next { display: flex; flex-direction: column; gap: 10px; }
  .hint { color: var(--ink-2); }
  .missing { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 0.88rem; color: var(--ink-2); }
  .missing li { display: flex; align-items: center; gap: 10px; }
  .missing li::before { content: ''; width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid var(--t-warning); flex: none; }
  .auto { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .req { background: var(--sunken); border-radius: 4px; padding: 0 6px; }
  .callout ul { margin: 4px 0 0; padding-left: 18px; }
  .reason { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--sunken); border-radius: var(--radius); }
  .more summary { cursor: pointer; width: max-content; }
  .more .row { margin-top: 8px; }
</style>
