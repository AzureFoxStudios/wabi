<script lang="ts">
	interface Props {
		events: Array<{
			id: string;
			type: string;
			author_id: string;
			description: string;
			timestamp: number;
			details: Record<string, any>;
		}>;
		onFreezeUser: (userId: string) => void;
		onPauseEgress: () => void;
	}

	let { events, onFreezeUser, onPauseEgress }: Props = $props();

	let filterType = $state('all');
	let searchQuery = $state('');

	let eventTypes = $derived(() => {
		const types = new Set(events.map(e => e.type));
		return ['all', ...types];
	});

	let filtered = $derived(events.filter(e => {
		const matchesType = filterType === 'all' || e.type === filterType;
		const matchesSearch = !searchQuery ||
			e.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
			e.author_id.toLowerCase().includes(searchQuery.toLowerCase());
		return matchesType && matchesSearch;
	}));

	function timeAgo(ts: number): string {
		const diff = Date.now() / 1000 - ts;
		if (diff < 60) return `${Math.floor(diff)}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return new Date(ts * 1000).toLocaleDateString();
	}
</script>

<div class="audit-viewer">
	<div class="audit-header">
		<h3 class="audit-title">Audit Log</h3>
		<div class="audit-controls">
			<input
				type="text"
				class="audit-search"
				bind:value={searchQuery}
				placeholder="Search events..."
			/>
			<select class="audit-filter" bind:value={filterType}>
				{#each eventTypes() as type}
					<option value={type}>{type}</option>
				{/each}
			</select>
		</div>
	</div>

	<div class="incident-tools">
		<button class="tool-btn danger" onclick={onPauseEgress}>⏸ Pause Egress</button>
	</div>

	<div class="audit-list">
		{#each filtered as event (event.id)}
			<div class="audit-event">
				<div class="event-meta">
					<span class="event-type">{event.type}</span>
					<span class="event-author">@{event.author_id}</span>
					<span class="event-time">{timeAgo(event.timestamp)}</span>
				</div>
				<div class="event-description">{event.description}</div>
				{#if Object.keys(event.details).length > 0}
					<pre class="event-details">{JSON.stringify(event.details, null, 2)}</pre>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.audit-viewer {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2);
	}

	.audit-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.audit-title {
		margin: 0;
		font-size: var(--font-size-base);
		color: var(--text-heading);
	}

	.audit-controls {
		display: flex;
		gap: var(--space-1);
	}

	.audit-search {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.audit-filter {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.incident-tools {
		display: flex;
		gap: var(--space-1);
		padding: var(--space-1);
		background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 30%, transparent);
		border-radius: var(--radius-md);
	}

	.tool-btn {
		padding: var(--space-1) var(--space-2);
		border: none;
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		font-weight: 600;
		cursor: pointer;
	}

	.tool-btn.danger {
		background: var(--color-danger, #ef4444);
		color: white;
	}

	.tool-btn.danger:hover {
		filter: brightness(1.1);
	}

	.audit-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.audit-event {
		padding: var(--space-2);
		background: var(--surface-raised);
		border-radius: var(--radius-md);
		border-left: 3px solid var(--accent-primary);
	}

	.event-meta {
		display: flex;
		gap: var(--space-2);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		margin-bottom: var(--space-1);
	}

	.event-type {
		background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
		color: var(--accent-primary);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		text-transform: uppercase;
		font-weight: 600;
	}

	.event-description {
		color: var(--text-secondary);
		font-size: var(--font-size-sm);
		margin-bottom: var(--space-1);
	}

	.event-details {
		margin: 0;
		padding: var(--space-1);
		background: var(--surface-sunken);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		overflow-x: auto;
		white-space: pre;
	}
</style>