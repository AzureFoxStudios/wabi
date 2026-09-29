<script lang="ts">
  import { L } from '$lib/format.ts';
  let { states, current }: { states: any[]; current: string } = $props();
  const idx = $derived(states.findIndex((s) => s.id === current));
  const off = $derived(idx < 0);
</script>

<ol class="pipe" class:off aria-label="Progress">
  {#each states as s, i (s.id)}
    <li class:done={!off && i < idx} class:now={s.id === current} aria-current={s.id === current ? 'step' : undefined}>
      <span class="dot"></span><span class="lbl">{L(s.label)}</span>
    </li>
  {/each}
</ol>

<style>
  .pipe { display: flex; list-style: none; margin: 0; padding: 0; gap: 0; overflow-x: auto; }
  li { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--faint); white-space: nowrap; padding-right: 14px; position: relative; }
  li:not(:last-child)::after { content: ''; width: 14px; height: 1px; background: var(--line-strong); margin-left: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--line-strong); background: var(--surface); flex: none; }
  li.done { color: var(--muted); }
  li.done .dot { background: var(--accent); border-color: var(--accent); }
  li.now { color: var(--ink); font-weight: 600; }
  li.now .dot { background: var(--surface); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); width: 10px; height: 10px; }
  .off li { opacity: 0.55; }
</style>
