<script lang="ts">
	import { MESSAGE_RETENTION_LABELS, MESSAGE_RETENTION_PRESETS } from '../../../../shared/messageRetention.js';

	export let value = '';
	export let onChange: (event: Event) => void;
	export let compact = false;
</script>

<div class="dm-lifetime" class:compact>
	<span class="dm-lifetime-icon" aria-hidden="true">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 1.8"/></svg>
	</span>
	<div class="dm-lifetime-copy">
		<strong>Message lifetime</strong>
		<span>Changes apply to new messages only</span>
	</div>
	<label class="dm-lifetime-picker">
		<span class="sr-only">Keep new messages for</span>
		<select {value} on:change={onChange} aria-label="Keep new messages for">
			<option value="">Forever</option>
			{#each MESSAGE_RETENTION_PRESETS as duration}
				<option value={duration}>{MESSAGE_RETENTION_LABELS[duration]}</option>
			{/each}
		</select>
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
	</label>
</div>

<style>
	.dm-lifetime {
		display: flex;
		align-items: center;
		flex: 0 0 auto;
		flex-wrap: wrap;
		gap: var(--space-2, 8px);
		min-width: 0;
		width: 100%;
		padding: var(--space-2, 8px) var(--space-4, 16px);
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--surface-base) 92%, var(--surface-raised) 8%);
	}
	.dm-lifetime.compact {
		flex: 1 1 250px;
		width: auto;
		padding: 0;
		border: 0;
		background: transparent;
	}
	.dm-lifetime-icon {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		flex: 0 0 30px;
		border-radius: var(--radius-md, 8px);
		background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
		color: var(--accent-secondary, #818cf8);
	}
	.dm-lifetime-icon svg { width: 17px; height: 17px; }
	.dm-lifetime-copy {
		display: flex;
		flex: 1 1 135px;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.dm-lifetime-copy strong {
		color: var(--text-heading);
		font-size: var(--font-size-sm, 13px);
		font-weight: var(--font-weight-semibold, 600);
		line-height: 1.25;
	}
	.dm-lifetime-copy span {
		color: var(--text-muted);
		font-size: var(--font-size-xs, 11px);
		line-height: 1.25;
	}
	.dm-lifetime-picker {
		display: flex;
		align-items: center;
		position: relative;
		flex: 0 1 160px;
		min-width: 130px;
		min-height: 36px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 8px);
		background: var(--surface-base);
		color: var(--text-heading);
	}
	.dm-lifetime-picker:hover { border-color: var(--accent-secondary, #818cf8); }
	.dm-lifetime-picker:focus-within { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
	.dm-lifetime-picker select {
		appearance: none;
		width: 100%;
		min-width: 0;
		min-height: 34px;
		padding: 0 30px 0 var(--space-3, 12px);
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: var(--font-size-sm, 13px);
		font-weight: var(--font-weight-medium, 500);
		cursor: pointer;
	}
	.dm-lifetime-picker select:focus { outline: none; }
	.dm-lifetime-picker svg { position: absolute; right: 10px; width: 14px; height: 14px; pointer-events: none; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	@media (max-width: 600px) {
		.dm-lifetime { padding-inline: var(--space-3, 12px); }
		.dm-lifetime.compact { padding-inline: 0; }
	}
</style>
