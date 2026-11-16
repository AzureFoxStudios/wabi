<script lang="ts">
	import { _ } from '$lib/i18n';
	import { countShortcuts, searchShortcutAreas, shortcutAreas } from '$lib/shortcuts/appShortcuts';

	// Read-only: this page shows the keys Wabi binds today (the list lives in lib/shortcuts/appShortcuts.ts, where
	// each group names the file that handles it). Nothing here rebinds a key.
	const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	const areas = shortcutAreas(mac);
	let query = '';
	$: shown = searchShortcutAreas(areas, query);
	$: total = countShortcuts(shown);
</script>

<section class="settings-block" aria-labelledby="keys-title">
	<h3 class="settings-block__title" id="keys-title">{$_('settings.keyboard.title')}</h3>
	<p class="settings-keys__intro">{mac ? $_('settings.keyboard.intro_mac') : $_('settings.keyboard.intro')}</p>
	<label class="settings-keys__search">
		<span class="sr-only">{$_('settings.keyboard.search_label')}</span>
		<input class="w-field" type="search" bind:value={query} placeholder={$_('settings.keyboard.search_placeholder')} autocomplete="off" spellcheck="false" />
	</label>
	<p class="settings-keys__count" role="status" aria-live="polite">
		{query.trim() ? $_('settings.keyboard.count_matching', { values: { count: total } }) : $_('settings.keyboard.count_all', { values: { count: total } })}
	</p>
</section>

{#each shown as area (area.id)}
	<section class="settings-block" aria-labelledby={`keys-${area.id}`}>
		<h3 class="settings-block__title" id={`keys-${area.id}`}>{area.title}</h3>
		<p class="settings-keys__where">{area.where}</p>
		{#each area.groups as group (group.title)}
			<h4 class="settings-keys__group">{group.title}</h4>
			<dl class="settings-keys__list">
				{#each group.rows as row (row.keys)}
					<dt><kbd>{row.keys}</kbd></dt>
					<dd>{row.action}</dd>
				{/each}
			</dl>
		{/each}
	</section>
{/each}

{#if !shown.length}
	<p class="settings-keys__empty">{$_('settings.keyboard.empty', { values: { query: query.trim() } })}</p>
{/if}

<p class="settings-keys__note">{$_('settings.keyboard.unlisted')}</p>

<style>
	.settings-keys__intro,
	.settings-keys__where,
	.settings-keys__count,
	.settings-keys__note,
	.settings-keys__empty {
		margin: 0 0 12px;
		color: var(--w-mute);
	}
	.settings-keys__search {
		display: block;
		max-width: 420px;
		margin: 0 0 8px;
	}
	.settings-keys__count {
		font: var(--w-t-micro);
	}
	.settings-keys__group {
		margin: 14px 0 8px;
		color: var(--w-mute);
		font: var(--w-t-label);
	}
	.settings-keys__list {
		display: grid;
		/* One fixed key column for every group, so the descriptions line up down the whole page. */
		grid-template-columns: 15rem 1fr;
		gap: 6px 20px;
		margin: 0 0 8px;
	}
	.settings-keys__list dt,
	.settings-keys__list dd {
		margin: 0;
		min-width: 0;
	}
	.settings-keys__list dd {
		color: var(--w-mute);
	}
	.settings-keys__list kbd {
		color: var(--w-text);
		font: var(--w-t-mono);
		font-size: calc(12px * var(--w-fs));
		overflow-wrap: anywhere;
	}
	.settings-keys__note {
		font: var(--w-t-micro);
	}
	@media (max-width: 560px) {
		.settings-keys__list {
			grid-template-columns: 1fr;
			gap: 2px 0;
		}
		.settings-keys__list dd {
			margin-bottom: 8px;
		}
	}
</style>
