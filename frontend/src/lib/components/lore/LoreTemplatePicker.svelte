<script lang="ts">
	interface Props {
		templates: Array<{
			id: string;
			name: string;
			description?: string;
			file_path: string;
			language?: string;
			category: string;
		}>;
		onSelect: (template: any) => void;
	}

	let { templates, onSelect }: Props = $props();

	let searchQuery = $state('');
	let selectedCategory = $state<string>('all');

	let categories = $derived(() => {
		const cats = new Set(templates.map(t => t.category));
		return ['all', ...cats];
	});

	let filtered = $derived(templates.filter(t => {
		const matchesSearch = !searchQuery ||
			t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			t.file_path.toLowerCase().includes(searchQuery.toLowerCase());
		const matchesCategory = selectedCategory === 'all' || t.category === selectedCategory;
		return matchesSearch && matchesCategory;
	}));
</script>

<div class="template-picker">
	<div class="picker-header">
		<input
			type="text"
			class="template-search"
			bind:value={searchQuery}
			placeholder="Search templates..."
			aria-label="Search templates"
		/>
		<select class="category-filter" bind:value={selectedCategory}>
			{#each categories() as cat}
				<option value={cat}>{cat}</option>
			{/each}
		</select>
	</div>

	<div class="template-grid">
		{#each filtered as template (template.id)}
			<button class="template-card" onclick={() => onSelect(template)}>
				<div class="template-icon">
					{#if template.language}
						<span class="lang-badge">{template.language}</span>
					{/if}
					<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
						<polyline points="14 2 14 8 20 8"/>
					</svg>
				</div>
				<div class="template-info">
					<span class="template-name">{template.name}</span>
					<span class="template-path">{template.file_path}</span>
					{#if template.description}
						<span class="template-desc">{template.description}</span>
					{/if}
				</div>
			</button>
		{/each}
	</div>
</div>

<style>
	.template-picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.picker-header {
		display: flex;
		gap: var(--space-1);
	}

	.template-search {
		flex: 1;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.category-filter {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.template-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: var(--space-2);
	}

	.template-card {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2);
		background: var(--surface-raised);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: left;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.template-card:hover {
		border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
		background: var(--surface-hover);
		transform: translateY(-1px);
	}

	.template-icon {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-muted);
	}

	.lang-badge {
		font-size: var(--font-size-2xs);
		background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
		color: var(--accent-primary);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		text-transform: uppercase;
	}

	.template-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.template-name {
		font-weight: 600;
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.template-path {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.template-desc {
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
	}
</style>