<script lang="ts">
  import { command } from '$lib/api.ts';
  import { app, T, toast, roleLabel } from '$lib/state.svelte.ts';
  import { dueText, userName, ago } from '$lib/format.ts';

  let { subjectType, subjectId, tasks, onchange = () => {}, compact = false }: { subjectType: string; subjectId: string; tasks: any[]; onchange?: () => void; compact?: boolean } = $props();
  let title = $state('');
  let assigneeId = $state('');
  let due = $state('');
  let showDone = $state(false);
  const open = $derived(tasks.filter((t) => !t.doneAt));
  const done = $derived(tasks.filter((t) => t.doneAt));

  async function add(e: Event) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await command('task.create', { subjectType, subjectId, title: title.trim(), assigneeId: assigneeId || undefined, due: due || undefined });
      title = '';
      due = '';
      onchange();
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  async function toggle(t: any) {
    try {
      await command(t.doneAt ? 'task.reopen' : 'task.complete', { id: t.id });
      onchange();
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  const whoFor = (t: any) => (t.assigneeId ? userName(t.assigneeId) : t.role ? roleLabel(t.role) : T('Anyone', 'ใครก็ได้'));
</script>

<div class="tk">
<ul class="tasks">
  {#each open as t (t.id)}
    {@const d = dueText(t.due)}
    <li>
      <input type="checkbox" checked={false} onchange={() => toggle(t)} aria-label={T('Tick when finished', 'ติ๊กเมื่อทำเสร็จ')} />
      <span class="grow">{t.title}</span>
      <span class="small muted nowrap">{whoFor(t)}</span>
      {#if d.text}<span class="small nowrap text-{d.tone}">{d.text}</span>{/if}
    </li>
  {:else}
    <li class="muted small">{T('Nothing left to do. Add a to-do below if someone needs to do something.', 'ไม่มีอะไรค้าง ถ้ามีเรื่องที่ต้องให้ใครทำ เพิ่มได้ด้านล่าง')}</li>
  {/each}
</ul>

{#if !compact}
  <form class="add" onsubmit={add}>
    <input bind:value={title} placeholder={T('What needs doing? e.g. “Call customer to confirm date”', 'ต้องทำอะไร? เช่น “โทรนัดวันกับลูกค้า”')} aria-label={T('Task', 'งาน')} />
    <select bind:value={assigneeId} aria-label={T('Assignee', 'ผู้รับผิดชอบ')}>
      <option value="">{T('Who? (anyone)', 'ใครทำ? (ใครก็ได้)')}</option>
      {#each app.boot.users.filter((u: any) => u.active) as u (u.id)}<option value={u.id}>{u.name}</option>{/each}
    </select>
    <input type="date" bind:value={due} aria-label={T('Due', 'กำหนด')} />
    <button class="btn" disabled={!title.trim()}>{T('Add to-do', 'เพิ่ม')}</button>
  </form>
{/if}

{#if done.length}
  <button class="btn ghost sm" onclick={() => (showDone = !showDone)}>{showDone ? T('Hide', 'ซ่อน') : T('Show', 'ดู')} {T(`${done.length} finished`, `${done.length} รายการที่เสร็จแล้ว`)}</button>
  {#if showDone}
    <ul class="tasks done">
      {#each done as t (t.id)}
        <li>
          <input type="checkbox" checked onchange={() => toggle(t)} aria-label={T('Reopen', 'เปิดใหม่')} />
          <span class="grow">{t.title}</span>
          <span class="tiny faint">{userName(t.doneBy)} · {ago(t.doneAt)}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
</div>

<style>
  .tasks { list-style: none; margin: 0 0 10px; padding: 0; }
  .tasks li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); }
  .tasks li:first-child { border-top: 0; }
  .tasks.done li span.grow { text-decoration: line-through; color: var(--muted); }
  .add { display: grid; grid-template-columns: 1fr 150px 140px auto; gap: 6px; margin-bottom: 8px; }
  .tk { container-type: inline-size; }
  @container (max-width: 520px) {
    .add { grid-template-columns: 1fr 1fr; }
    .add > :first-child { grid-column: 1 / -1; }
  }
</style>
