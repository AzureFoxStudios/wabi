<script lang="ts">
	interface Props {
		branches: { name: string; lastCommit: string; lastCommitAt: number; isTag?: boolean }[];
		currentBranch: string;
		onCreate: (name: string, from: string) => void;
		onDelete: (name: string) => void;
		onSwitch: (name: string) => void;
	}

	let { branches, currentBranch, onCreate, onDelete, onSwitch }: Props = $props();

	let showMenu = $state(false);
	let showCreate = $state(false);
	let newName = $state('');
	let sourceBranch = $state('');
	let confirmDelete = $state<string | null>(null);

	function timeAgo(ts: number): string {
		const diff = Date.now() / 1000 - ts;
		if (diff < 60) return `${Math.floor(diff)}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	function handleCreate() {
		if (!newName.trim()) return;
		onCreate(newName.trim(), sourceBranch || currentBranch);
		newName = '';
		sourceBranch = '';
		showCreate = false;
	}
</script>

<div class="branch-picker">
	<button
		class="branch-trigger"
		onclick={() => { showMenu = !showMenu; showCreate = false; confirmDelete = null; }}
		aria-label="Switch branch"
		aria-expanded={showMenu}
	>
		<svg class="branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<line x1="6" y1="3" x2="6" y2="15" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</svg>
		<span class="branch-name">{currentBranch}</span>
		<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</button>

	{#if showMenu}
		<div class="branch-dropdown" role="menu">
			{#if showCreate}
				<div class="create-branch">
					<input
						type="text"
						bind:value={newName}
						placeholder="Branch name"
						aria-label="New branch name"
						onkeydown={(e) => e.key === 'Enter' && handleCreate()}
					/>
					<select bind:value={sourceBranch} aria-label="Source branch">
						{#each branches as b}
							<option value={b.name}>{b.name}</option>
						{/each}
					</select>
					<button class="btn-create" onclick={handleCreate}>Create</button>
					<button class="btn-cancel" onclick={() => showCreate = false}>Cancel</button>
				</div>
			{:else if confirmDelete}
				<div class="confirm-delete">
					<p>Delete <strong>{confirmDelete}</strong>?</p>
					<button class="btn-confirm" onclick={() => { onDelete(confirmDelete); confirmDelete = null; }}>Delete</button>
					<button class="btn-cancel" onclick={() => confirmDelete = null}>Cancel</button>
				</div>
			{:else}
				<button class="btn-new" onclick={() => { showCreate = true; }}>
					+ New branch
				</button>
				{#each branches as branch}
					<button
						class="branch-item {branch.name === currentBranch ? 'active' : ''}"
						class:tag={branch.isTag}
						role="menuitem"
						onclick={() => { onSwitch(branch.name); showMenu = false; }}
						oncontextmenu={(e) => { e.preventDefault(); if (!branch.isTag) confirmDelete = branch.name; }}
					>
						<span class="item-name">{branch.name}</span>
						<span class="item-time" title={branch.lastCommit}>{timeAgo(branch.lastCommitAt)}</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.branch-picker {
		position: relative;
		display: inline-block;
	}

	.branch-trigger {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent);
		border-radius: var(--radius-md);
		color: var(--text-heading);
		cursor: pointer;
		font-size: var(--font-size-sm);
		font-family: var(--font-mono);
		transition: background var(--duration-fast) var(--ease-out);
	}

	.branch-trigger:hover {
		background: color-mix(in srgb, var(--surface-raised) 80%, var(--accent-primary));
	}

	.branch-icon {
		width: 16px;
		height: 16px;
	}

	.chevron {
		width: 14px;
		height: 14px;
		color: var(--text-muted);
	}

	.branch-dropdown {
		position: absolute;
		top: calc(100% + var(--space-1));
		right: 0;
		min-width: 220px;
		max-height: 320px;
		overflow-y: auto;
		background: var(--surface-base);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		border-radius: var(--radius-md);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		z-index: var(--z-dropdown, 200);
		padding: var(--space-1);
	}

	.branch-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		padding: var(--space-1) var(--space-2);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		cursor: pointer;
		font-size: var(--font-size-sm);
		font-family: var(--font-mono);
		text-align: left;
	}

	.branch-item:hover {
		background: var(--surface-raised);
	}

	.branch-item.active {
		background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
	}

	.branch-item.tag .item-name::before {
		content: '🏷 ';
	}

	.item-time {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.btn-new, .btn-create, .btn-confirm, .btn-cancel {
		width: 100%;
		padding: var(--space-1) var(--space-2);
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-size: var(--font-size-sm);
	}

	.btn-new {
		background: transparent;
		color: var(--accent-primary);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
	}

	.btn-new:hover {
		background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
	}

	.create-branch {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-1);
	}

	.create-branch input, .create-branch select {
		padding: var(--space-1);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.btn-create {
		background: var(--accent-primary);
		color: white;
	}

	.btn-cancel {
		background: var(--surface-raised);
		color: var(--text-secondary);
	}

	.confirm-delete {
		padding: var(--space-2);
		text-align: center;
	}

	.confirm-delete p {
		margin: 0 0 var(--space-2);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.confirm-delete button {
		margin: 0 var(--space-1);
		width: auto;
	}

	.btn-confirm {
		background: var(--color-danger, #ef4444);
		color: white;
	}
</style>