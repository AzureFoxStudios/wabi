<script lang="ts">
	import { _ } from '$lib/i18n';
 import { revisionCalendar } from '$lib/lore/activityCalendar';
 let { revisions }: { revisions: readonly { timestamp: number }[] } = $props();
 let days = $derived(revisionCalendar(revisions));
 let maxCount = $derived(Math.max(1, ...days.map(day => day.count)));
</script>
<details class="activity-calendar" open>
 <summary>{$_('lcal.summary')} <span>{$_('lcal.shown', { values: { count: days.reduce((total, day) => total + day.count, 0) } })}</span></summary>
 <div class="activity-days" aria-label={$_('lcal.aria')}>
  {#each days as day}<span class="activity-day" style:background={day.count ? `color-mix(in srgb, var(--accent-primary) ${25 + 75 * day.count / maxCount}%, var(--bg-secondary))` : 'var(--bg-secondary)'} title={$_('lcal.day_title', { values: { date: day.date, count: day.count } })}></span>{/each}
 </div>
 <small>{$_('lcal.note')}</small>
</details>
<style>
 .activity-calendar { padding: 16px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-primary); margin: 12px; }
 summary { cursor: pointer; font-weight: 600; color: var(--text-heading); } summary span { font-weight: 400; color: var(--text-muted); margin-left: 8px; }
 .activity-days { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 10px); grid-auto-columns: 10px; gap: 3px; overflow-x: auto; margin: 16px 0 10px; padding-bottom: 4px; }
 .activity-day { width: 10px; height: 10px; border-radius: 2px; } small { color: var(--text-muted); }
</style>
