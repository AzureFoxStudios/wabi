<script lang="ts">
	export let searchPlaceholder: string | undefined = undefined;
	export let pills: { key: string; label: string; active?: boolean }[] | undefined = undefined;
	export let sortOptions: string[] | undefined = undefined;
	export let onSearch: ((q: string) => void) | undefined = undefined;
	export let onPill: ((key: string) => void) | undefined = undefined;
	export let onSort: ((value: string) => void) | undefined = undefined;

	let searchValue = '';

	function handleSearchInput() {
		onSearch?.(searchValue);
	}

	function handlePillClick(key: string) {
		onPill?.(key);
	}

	function handleSortChange(e: Event) {
		const target = e.target as HTMLSelectElement;
		onSort?.(target.value);
	}
</script>

<div class="surface-toolbar">
	<input
		type="text"
		class="surface-search"
		placeholder={searchPlaceholder || 'Search\u2026'}
		bind:value={searchValue}
		on:input={handleSearchInput}
	/>
	{#if pills}
		<div class="surface-pill-group">
			{#each pills as pill}
				<button
					class="surface-pill"
					class:active={pill.active}
					on:click={() => handlePillClick(pill.key)}
				>
					{pill.label}
				</button>
			{/each}
		</div>
	{/if}
	<slot />
	{#if sortOptions}
		<select class="surface-sort" on:change={handleSortChange}>
			{#each sortOptions as option}
				<option value={option}>{option}</option>
			{/each}
		</select>
	{/if}
</div>
