<!--
	"Search settings" (design contract §8.9): a 220px chrome field in the Settings header (or at
	the top of the phone page list) that works as a combobox over settingsFrame's search index.

	- Typing opens a listbox of results (label + page); ↑/↓ move, Enter or a click opens one.
	- Esc clears a typed search first and keeps Settings open; with nothing typed it is left to
	  the dialog, so one press closes Settings.
	- The parent calls `focus()` for the "/" shortcut and gets the chosen result in `onpick`.
-->
<script lang="ts">
	import { _ as t } from '$lib/i18n';
	import Icon from '../ui/Icon.svelte';
	import { searchSettings, type SettingsSearchResult } from './settingsFrame';

	interface Props {
		canManageAdmin: boolean;
		/** The phone list puts the field under the nav title and drops the "/" keycap. */
		variant?: 'desk' | 'phone';
		onpick: (result: SettingsSearchResult) => void;
	}

	let { canManageAdmin, variant = 'desk', onpick }: Props = $props();

	let query = $state('');
	let open = $state(false);
	let active = $state(0);
	let input: HTMLInputElement | null = $state(null);

	const results = $derived(searchSettings(query, canManageAdmin));
	const showResults = $derived(open && query.trim().length > 0);
	const activeIndex = $derived(active < results.length ? active : 0);
	const placeholder = $derived(translated('settings.search', 'Search settings'));

	function translated(key: string, fallback: string): string {
		const value = $t(key);
		return value && value !== key ? value : fallback;
	}

	export function focus(): void {
		input?.focus();
	}

	function pick(result: SettingsSearchResult): void {
		query = '';
		open = false;
		active = 0;
		onpick(result);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (!results.length) return;
			event.preventDefault();
			open = true;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = (activeIndex + step + results.length) % results.length;
		} else if (event.key === 'Enter') {
			const result = results[activeIndex];
			if (!result) return;
			event.preventDefault();
			pick(result);
		} else if (event.key === 'Escape' && (showResults || query)) {
			// Clear the search first; with nothing typed, Escape closes Settings.
			event.preventDefault();
			event.stopPropagation();
			query = '';
			open = false;
		}
	}
</script>

<div class="settings-search" class:settings-search--phone={variant === 'phone'}>
	<label class="w-field w-field--chrome settings-search__field">
		<Icon name="search" size={16} />
		<input
			bind:this={input}
			bind:value={query}
			type="text"
			role="combobox"
			aria-label={placeholder}
			aria-expanded={showResults}
			aria-controls={showResults ? 'settings-search-results' : undefined}
			aria-autocomplete="list"
			aria-activedescendant={showResults && results.length ? `settings-search-option-${activeIndex}` : undefined}
			{placeholder}
			autocomplete="off"
			spellcheck="false"
			oninput={() => {
				open = true;
				active = 0;
			}}
			onfocus={() => (open = true)}
			onblur={() => window.setTimeout(() => (open = false), 120)}
			onkeydown={handleKeydown}
		/>
		{#if variant === 'desk' && !query}<kbd class="w-kbd" aria-hidden="true">/</kbd>{/if}
	</label>
	{#if showResults}
		<div class="settings-search__pop w-pop">
			{#if results.length}
				<ul class="settings-search__list" id="settings-search-results" role="listbox" aria-label={placeholder}>
					{#each results as result, index (result.tab + result.label)}
						<li
							id="settings-search-option-{index}"
							class="settings-search__option"
							role="option"
							aria-selected={index === activeIndex}
							onmousedown={(event) => {
								event.preventDefault();
								pick(result);
							}}
							onmouseenter={() => (active = index)}
						>
							<span class="settings-search__label">{result.label}</span>
							<span class="settings-search__page">{result.pageLabel}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="settings-search__empty" id="settings-search-results" role="status">
					Nothing in Settings matches “{query.trim()}”.
				</p>
			{/if}
		</div>
	{/if}
</div>
