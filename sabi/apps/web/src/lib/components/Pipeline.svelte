<script lang="ts">
  import { L } from '$lib/format.ts';
  import { T } from '$lib/state.svelte.ts';
  let { states, current }: { states: any[]; current: string } = $props();
  const idx = $derived(states.findIndex((s) => s.id === current));
  const off = $derived(idx < 0);
</script>

<!-- Numbered steps: ✓ = done, filled = where the work is now, grey = still to come. -->
<ol class="pipe" class:off aria-label={T('Progress', 'ความคืบหน้า')}>
  {#each states as s, i (s.id)}
    <li class:done={!off && i < idx} class:now={s.id === current} aria-current={s.id === current ? 'step' : undefined}>
      <span class="dot">{!off && i < idx ? '✓' : i + 1}</span><span class="lbl">{L(s.label)}</span>
    </li>
  {/each}
</ol>

<style>
  .pipe { display: flex; list-style: none; margin: 0; padding: 2px 0 4px; gap: 0; overflow-x: auto; }
  li { display: flex; align-items: center; gap: 7px; font-size: 0.88rem; color: var(--faint); white-space: nowrap; padding-right: 10px; position: relative; }
  li:not(:last-child)::after { content: ''; width: 16px; height: 1px; background: var(--line-strong); margin-left: 4px; }
  .dot { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-strong); background: var(--surface); flex: none; display: grid; place-items: center; font-size: 0.7rem; font-weight: 600; line-height: 1; }
  li.done { color: var(--muted); }
  li.done .dot { background: var(--accent); border-color: var(--accent); color: white; }
  li.now .lbl { color: var(--ink); font-weight: 600; background: var(--accent-soft); padding: 2px 10px; border-radius: 999px; }
  li.now .dot { background: var(--accent); border-color: var(--accent); color: white; box-shadow: 0 0 0 3px var(--accent-soft); }
  .off li { opacity: 0.55; }
</style>
