<script lang="ts">
	import { onMount } from 'svelte';
	import { currentUser } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import {
		ALL_LORE_CAPABILITIES,
		BUILT_IN_LORE_ROLES,
		CAPABILITY_DESCRIPTIONS,
		CAPABILITY_LABELS,
		deleteLoreRole,
		fetchLoreRoles,
		setLoreDefaultPolicy,
		upsertLoreRole,
		type LoreDefaultPolicy,
		type LoreRoleDef
	} from '$lib/api/lore';

	let { onClose = () => {} }: { onClose?: () => void } = $props();

	let isAdmin = $derived(
		$currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin'
	);
	let loading = $state(true);
	let roles = $state<LoreRoleDef[]>([]);
	let defaultPolicy = $state<LoreDefaultPolicy>('view');
	let status = $state<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
	/** Role id currently saving/deleting, or 'new' / 'policy'. */
	let busy = $state<string | null>(null);

	interface RoleDraft {
		name: string;
		description: string;
		capabilities: string[];
	}
	let drafts = $state<Record<string, RoleDraft>>({});
	let newDraft = $state<RoleDraft>({ name: '', description: '', capabilities: ['lore.view'] });

	function isBuiltIn(id: string): boolean {
		return BUILT_IN_LORE_ROLES.includes(id);
	}
	/** Owner + admin always carry every capability; the server enforces it. */
	function isLockedFull(id: string): boolean {
		return id === 'owner' || id === 'admin';
	}
	function canEditName(id: string): boolean {
		return id !== 'owner' && id !== 'admin';
	}

	function draftFor(role: LoreRoleDef): RoleDraft {
		return {
			name: role.name,
			description: role.description,
			capabilities: [...role.capabilities]
		};
	}

	function setStatus(kind: 'ok' | 'error' | 'info', text: string) {
		status = { kind, text };
	}

	function requireToken(): string | null {
		const token = getAuthToken();
		if (!token) setStatus('error', 'Sign in again to manage repository roles.');
		return token;
	}

	async function load() {
		const token = requireToken();
		if (!token) {
			loading = false;
			return;
		}
		loading = true;
		setStatus('info', 'Loading repository roles…');
		try {
			const state = await fetchLoreRoles(token);
			roles = state.roles;
			defaultPolicy = state.defaultPolicy;
			const next: Record<string, RoleDraft> = {};
			for (const role of state.roles) next[role.id] = draftFor(role);
			drafts = next;
			status = null;
		} catch (e) {
			setStatus('error', e instanceof Error ? e.message : 'Could not load repository roles.');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		if (isAdmin) void load();
		else loading = false;
	});

	function toggleCapability(draft: RoleDraft, capability: string) {
		if (draft.capabilities.includes(capability)) {
			draft.capabilities = draft.capabilities.filter((c) => c !== capability);
		} else {
			draft.capabilities = ALL_LORE_CAPABILITIES.filter(
				(c) => c === capability || draft.capabilities.includes(c)
			);
		}
	}

	async function saveRole(role: LoreRoleDef) {
		const token = requireToken();
		const draft = drafts[role.id];
		if (!token || !draft || busy) return;
		const name = draft.name.trim();
		if (!name) {
			setStatus('error', 'Give the role a name before saving.');
			return;
		}
		busy = role.id;
		try {
			const state = await upsertLoreRole(token, {
				id: role.id,
				name,
				description: draft.description.trim(),
				capabilities: isLockedFull(role.id) ? [...ALL_LORE_CAPABILITIES] : draft.capabilities
			});
			roles = state.roles;
			defaultPolicy = state.defaultPolicy;
			const saved = state.roles.find((r) => r.id === role.id);
			if (saved) drafts = { ...drafts, [role.id]: draftFor(saved) };
			setStatus('ok', `Saved role “${name}”.`);
		} catch (e) {
			setStatus('error', e instanceof Error ? e.message : `Could not save role “${role.name}”.`);
		} finally {
			busy = null;
		}
	}

	async function createRole() {
		const token = requireToken();
		if (!token || busy) return;
		const name = newDraft.name.trim();
		if (!name) {
			setStatus('error', 'Give the new role a name before creating it.');
			return;
		}
		busy = 'new';
		try {
			const state = await upsertLoreRole(token, {
				name,
				description: newDraft.description.trim(),
				capabilities: newDraft.capabilities
			});
			roles = state.roles;
			defaultPolicy = state.defaultPolicy;
			const next: Record<string, RoleDraft> = {};
			for (const role of state.roles) next[role.id] = draftFor(role);
			drafts = next;
			newDraft = { name: '', description: '', capabilities: ['lore.view'] };
			setStatus('ok', `Created role “${name}”.`);
		} catch (e) {
			setStatus('error', e instanceof Error ? e.message : 'Could not create the role.');
		} finally {
			busy = null;
		}
	}

	async function removeRole(role: LoreRoleDef) {
		const token = requireToken();
		if (!token || busy) return;
		if (!window.confirm(`Delete the “${role.name}” role? Members with this role lose its access.`)) {
			return;
		}
		busy = role.id;
		try {
			const state = await deleteLoreRole(token, role.id);
			roles = state.roles;
			defaultPolicy = state.defaultPolicy;
			const next = { ...drafts };
			delete next[role.id];
			drafts = next;
			setStatus('ok', `Deleted role “${role.name}”.`);
		} catch (e) {
			setStatus('error', e instanceof Error ? e.message : `Could not delete role “${role.name}”.`);
		} finally {
			busy = null;
		}
	}

	async function changeDefaultPolicy(policy: LoreDefaultPolicy) {
		const token = requireToken();
		if (!token || busy || policy === defaultPolicy) return;
		busy = 'policy';
		try {
			const state = await setLoreDefaultPolicy(token, policy);
			roles = state.roles;
			defaultPolicy = state.defaultPolicy;
			setStatus('ok', `Users with no role now have ${policy === 'open' ? 'open access' : 'view-only access'}.`);
		} catch (e) {
			setStatus('error', e instanceof Error ? e.message : 'Could not update the default policy.');
		} finally {
			busy = null;
		}
	}
</script>

<div class="roles-admin">
	<div class="roles-head">
		<div>
			<h2>Repository roles</h2>
			<p class="roles-sub">Named bundles of access — assign them from any member menu.</p>
		</div>
		<button class="roles-close" onclick={onClose} aria-label="Close role editor">✕</button>
	</div>

	{#if !isAdmin}
		<p class="roles-status error" role="alert">Only server admins can edit repository roles.</p>
	{:else if loading}
		<p class="roles-status info" role="status">Loading repository roles…</p>
	{:else}
		{#if roles.length === 0}
			<p class="roles-empty">No roles yet. Create the first one below.</p>
		{/if}

		{#each roles as role (role.id)}
			{@const draft = drafts[role.id]}
			{@const locked = isLockedFull(role.id)}
			<section class="role-card" aria-label={`Role ${role.name}`}>
				<div class="role-top">
					{#if canEditName(role.id)}
						<input
							class="role-name"
							bind:value={draft.name}
							maxlength={48}
							placeholder="Role name"
							aria-label={`Name for role ${role.id}`}
							disabled={busy !== null}
						/>
					{:else}
						<span class="role-name locked" title="Built-in roles keep their name">{role.name}</span>
					{/if}
					{#if !isBuiltIn(role.id)}
						<span class="role-id" title="Role id used by the assign-role flow">{role.id}</span>
					{/if}
				</div>
				<textarea
					class="role-desc"
					bind:value={draft.description}
					rows={2}
					maxlength={280}
					placeholder="What is this role for?"
					aria-label={`Description for role ${role.name}`}
					disabled={busy !== null}
				></textarea>
				<div class="cap-grid">
					{#each ALL_LORE_CAPABILITIES as capability}
						{@const checked = locked || draft.capabilities.includes(capability)}
						<label
							class="cap"
							class:locked
							title={CAPABILITY_DESCRIPTIONS[capability] ?? capability}
						>
							<input
								type="checkbox"
								checked={checked}
								disabled={locked || busy !== null}
								onchange={() => toggleCapability(draft, capability)}
							/>
							<span>{CAPABILITY_LABELS[capability] ?? capability}</span>
						</label>
					{/each}
				</div>
				{#if locked}
					<p class="role-note">
						{role.id === 'owner'
							? 'The owner role is fully locked.'
							: 'Admins always keep every capability — the server enforces this.'}
					</p>
				{/if}
				<div class="role-actions">
					<button
						class="roles-btn primary"
						disabled={busy !== null}
						onclick={() => void saveRole(role)}
					>
						{busy === role.id ? 'Saving…' : 'Save'}
					</button>
					{#if !isBuiltIn(role.id)}
						<button
							class="roles-btn danger"
							disabled={busy !== null}
							onclick={() => void removeRole(role)}
						>
							{busy === role.id ? 'Deleting…' : 'Delete'}
						</button>
					{/if}
				</div>
			</section>
		{/each}

		<section class="role-card new" aria-label="Create a new role">
			<div class="role-top">
				<input
					class="role-name"
					bind:value={newDraft.name}
					maxlength={48}
					placeholder="New role name"
					aria-label="New role name"
					disabled={busy !== null}
				/>
			</div>
			<textarea
				class="role-desc"
				bind:value={newDraft.description}
				rows={2}
				maxlength={280}
				placeholder="What is this role for?"
				aria-label="New role description"
				disabled={busy !== null}
			></textarea>
			<div class="cap-grid">
				{#each ALL_LORE_CAPABILITIES as capability}
					<label class="cap" title={CAPABILITY_DESCRIPTIONS[capability] ?? capability}>
						<input
							type="checkbox"
							checked={newDraft.capabilities.includes(capability)}
							disabled={busy !== null}
							onchange={() => toggleCapability(newDraft, capability)}
						/>
						<span>{CAPABILITY_LABELS[capability] ?? capability}</span>
					</label>
				{/each}
			</div>
			<div class="role-actions">
				<button
					class="roles-btn primary"
					disabled={busy !== null || !newDraft.name.trim()}
					onclick={() => void createRole()}
				>
					{busy === 'new' ? 'Creating…' : 'Create role'}
				</button>
			</div>
		</section>

		<section class="role-card policy" aria-label="Default policy for users with no role">
			<span class="policy-label">Users with no role:</span>
			<div class="policy-options" role="radiogroup" aria-label="Default policy">
				<label class="policy-option" class:selected={defaultPolicy === 'view'}>
					<input
						type="radio"
						name="lore-default-policy"
						checked={defaultPolicy === 'view'}
						disabled={busy !== null}
						onchange={() => void changeDefaultPolicy('view')}
					/>
					<span>View only (recommended)</span>
				</label>
				<label class="policy-option" class:selected={defaultPolicy === 'open'}>
					<input
						type="radio"
						name="lore-default-policy"
						checked={defaultPolicy === 'open'}
						disabled={busy !== null}
						onchange={() => void changeDefaultPolicy('open')}
					/>
					<span>Open access</span>
				</label>
			</div>
			<p class="role-note">
				Open = everyone can do everything until you restrict. View = read-only until you grant a role.
				{busy === 'policy' ? 'Saving…' : ''}
			</p>
		</section>
	{/if}

	{#if status}
		<p class="roles-status {status.kind}" role="status">{status.text}</p>
	{/if}
</div>

<style>
	.roles-admin {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		color: var(--text-body, inherit);
	}
	.roles-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.roles-head h2 {
		margin: 0;
		font-size: var(--font-size-md, 1rem);
		color: var(--text-heading);
	}
	.roles-sub {
		margin: 2px 0 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}
	.roles-close {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 14px;
	}
	.roles-close:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}
	.role-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
		border-radius: var(--radius-md);
	}
	.role-top {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.role-name {
		flex: 1;
		min-width: 0;
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		background: var(--surface-base, transparent);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		font-weight: 600;
	}
	.role-name.locked {
		border: none;
		background: none;
		padding-left: 0;
	}
	.role-id {
		flex-shrink: 0;
		font-family: var(--font-family-mono, monospace);
		font-size: var(--font-size-2xs);
		color: var(--text-muted);
	}
	.role-desc {
		width: 100%;
		box-sizing: border-box;
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		background: var(--surface-base, transparent);
		color: var(--text-secondary);
		font-size: var(--font-size-xs);
		font-family: inherit;
		resize: vertical;
	}
	.cap-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 4px var(--space-2);
	}
	.cap {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
		cursor: pointer;
	}
	.cap.locked {
		cursor: default;
		opacity: 0.85;
	}
	.cap input {
		accent-color: var(--accent-primary);
	}
	.role-note {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}
	.role-actions {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
	}
	.roles-btn {
		padding: 4px var(--space-3);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		background: var(--surface-raised);
		color: var(--text-heading);
		font-size: var(--font-size-xs);
		font-weight: 600;
		cursor: pointer;
	}
	.roles-btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.roles-btn.primary {
		background: var(--accent-primary);
		border-color: transparent;
		color: #fff;
	}
	.roles-btn.danger {
		background: transparent;
		border-color: color-mix(in srgb, var(--color-danger, #ef4444) 45%, transparent);
		color: var(--color-danger, #ef4444);
	}
	.policy-label {
		font-size: var(--font-size-sm);
		font-weight: 600;
		color: var(--text-heading);
	}
	.policy-options {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.policy-option {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
		cursor: pointer;
	}
	.policy-option.selected {
		border-color: color-mix(in srgb, var(--accent-primary) 60%, transparent);
		color: var(--text-heading);
	}
	.policy-option input {
		accent-color: var(--accent-primary);
	}
	.roles-status {
		margin: 0;
		font-size: var(--font-size-xs);
	}
	.roles-status.ok {
		color: var(--color-success, #22c55e);
	}
	.roles-status.error {
		color: var(--color-danger, #ef4444);
	}
	.roles-status.info {
		color: var(--text-muted);
	}
	.roles-empty {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--text-muted);
	}
</style>
