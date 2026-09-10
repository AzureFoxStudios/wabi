<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { currentUser } from '$lib/socket';
	import { getApiBase } from '$lib/api/utils';
	import { getAuthToken, authSessionGeneration } from '$lib/authSession';
	import { ALL_LORE_CAPABILITIES, BUILT_IN_LORE_ROLES, CAPABILITY_DESCRIPTIONS, CAPABILITY_LABELS,
		deleteLoreRole, fetchLoreRoles, setLoreDefaultPolicy, upsertLoreRole,
		type LoreDefaultPolicy, type LoreRoleDef, type LoreRolesState } from '$lib/api/lore';
	import { sameRoleDraft } from '$lib/lore/workspacePresentation';
	import LoreIcon from './LoreIcon.svelte';

	let { onClose = () => {}, onDirtyChange }: { onClose?: () => void; onDirtyChange?: (dirty: boolean) => void } = $props();
	const server = getApiBase();
	const generation = authSessionGeneration(server);
	let alive = true;
	let isAdmin = $derived(['owner', 'admin'].includes(($currentUser?.highestRole ?? '').toLowerCase()));
	let loading = $state(true);
	let busy = $state(false);
	let roles = $state<LoreRoleDef[]>([]);
	let policy = $state<LoreDefaultPolicy>('view');
	let policyDraft = $state<LoreDefaultPolicy>('view');
	let selected = $state('');
	let draft = $state({ name: '', description: '', capabilities: ['lore.view'] as string[] });
	let status = $state('');
	let error = $state('');
	let role = $derived(roles.find(item => item.id === selected));
	let locked = $derived(selected === 'owner' || selected === 'admin');
	let isNew = $derived(selected === '@new');
	let dirty = $derived(selected === '@policy' ? policyDraft !== policy : isNew ? !!draft.name || !!draft.description || !sameRoleDraft(draft, { name: '', description: '', capabilities: ['lore.view'] }) : !!role && !sameRoleDraft(draft, role));
	$effect(() => { const value = dirty || busy; untrack(() => onDirtyChange?.(value)); });
	onDestroy(() => { alive = false; onDirtyChange?.(false); });
	function active() { return alive && isAdmin && getApiBase() === server && authSessionGeneration(server) === generation; }
	function token() {
		if (!active()) throw new Error('Your session changed. Reopen the role editor.');
		const value = getAuthToken(server); if (!value) throw new Error('Sign in to manage repository roles.'); return value;
	}
	function apply(state: LoreRolesState) { roles = state.roles; policy = state.defaultPolicy; }
	function choose(id: string, ask = true) {
		if (busy || (ask && dirty && !window.confirm('Discard unsaved permission changes?'))) return;
		selected = id; policyDraft = policy;
		const found = roles.find(item => item.id === id);
		draft = found ? { name: found.name, description: found.description, capabilities: [...found.capabilities] } : { name: '', description: '', capabilities: ['lore.view'] };
		error = ''; status = '';
	}
	async function load() {
		if (busy || (dirty && !window.confirm('Discard unsaved changes and reload roles?'))) return;
		loading = true; error = '';
		try { const state = await fetchLoreRoles(token()); if (!active()) return; apply(state); choose(roles[0]?.id ?? '@new', false); }
		catch (e) { if (alive) error = e instanceof Error ? e.message : 'Could not load repository roles.'; }
		finally { if (alive) loading = false; }
	}
	onMount(() => { if (isAdmin) void load(); else loading = false; });
	function toggle(capability: string) {
		if (busy || locked) return;
		draft.capabilities = draft.capabilities.includes(capability) ? draft.capabilities.filter(item => item !== capability) : [...draft.capabilities, capability];
	}
	async function save() {
		if (busy || !dirty || locked) return;
		error = ''; status = '';
		if (selected !== '@policy' && !draft.name.trim()) { error = 'Give this role a name.'; return; }
		busy = true;
		try {
			const existing = new Set(roles.map(item => item.id));
			const state = selected === '@policy' ? await setLoreDefaultPolicy(token(), policyDraft) : await upsertLoreRole(token(), {
				...(isNew ? {} : { id: selected }), name: draft.name.trim(), description: draft.description.trim(), capabilities: [...draft.capabilities]
			});
			if (!active()) return;
			apply(state);
			if (isNew) selected = state.roles.find(item => !existing.has(item.id))?.id ?? '@new';
			const updated = roles.find(item => item.id === selected);
			if (updated) draft = { name: updated.name, description: updated.description, capabilities: [...updated.capabilities] };
			policyDraft = policy; status = 'Changes saved on the server.';
		} catch (e) { if (alive) error = e instanceof Error ? e.message : 'Save failed. Your draft is still here.'; }
		finally { if (alive) busy = false; }
	}
	async function remove() {
		if (busy || !role || BUILT_IN_LORE_ROLES.includes(role.id)) return;
		if (!window.confirm(`Delete the “${role.name}” role across this server? Members lose the access provided by it.`)) return;
		busy = true; error = '';
		try {
			const state = await deleteLoreRole(token(), role.id); if (!active()) return;
			apply(state); busy = false; choose(roles[0]?.id ?? '@new', false); status = 'Role deleted.';
		} catch (e) { if (alive) error = e instanceof Error ? e.message : 'Could not delete this role.'; }
		finally { if (alive) busy = false; }
	}
	function close() { if (!busy && (!dirty || window.confirm('Discard unsaved permission changes?'))) onClose(); }
</script>

<section class="roles-admin" aria-label="Repository role editor" aria-busy={busy || loading}>
	<header class="roles-head"><div><h2>Repository permissions</h2><p>Server-wide roles. Changes apply across projects, not just this repository.</p></div><button onclick={close} disabled={busy} aria-label="Close role editor"><LoreIcon name="close" /></button></header>
	{#if !isAdmin}<p role="alert">Only server administrators can edit repository roles.</p>
	{:else if loading}<p role="status">Loading repository roles…</p>
	{:else}
		{#if error}<p class="roles-error" role="alert">{error} <button disabled={busy} onclick={() => void load()}>Reload roles</button></p>{/if}
		{#if status}<p class="roles-status" role="status">{status}</p>{/if}
		<div class="roles-layout">
			<nav class="roles-list" aria-label="Choose a repository role">
				<p class="roles-eyebrow">Roles</p>
				{#each roles as item (item.id)}<button class:chosen={selected === item.id} aria-current={selected === item.id ? 'true' : undefined} disabled={busy} onclick={() => choose(item.id)}><span>{item.name}</span><small>{['owner', 'admin'].includes(item.id) ? 'System role' : `${item.capabilities.length} permissions`}</small></button>{/each}
				<button class:chosen={isNew} disabled={busy} onclick={() => choose('@new')}>+ New role</button>
				<hr /><button class:chosen={selected === '@policy'} disabled={busy} onclick={() => choose('@policy')}>Default access<small>Members without a role</small></button>
			</nav>
			<div class="role-editor">
				<div class="role-fields">
					{#if selected === '@policy'}
						<h3>Default repository access</h3><p>Choose what members without a recognized repository role can do.</p>
						<label class="permission-row"><input type="radio" name="lore-policy" value="view" bind:group={policyDraft} disabled={busy} /><span><strong>View only</strong><small>Members need an assigned role to make changes. Recommended.</small></span></label>
						<label class="permission-row"><input type="radio" name="lore-policy" value="open" bind:group={policyDraft} disabled={busy} /><span><strong>Open access</strong><small>Grants the server's open-access policy to members without a recognized role.</small></span></label>
					{:else if locked}
						<div class="system-role"><LoreIcon name="shield" size={30} /><h3>{role?.name}</h3><p>System role — all repository capabilities.</p><p>The server enforces this access. It cannot be removed here.</p></div>
					{:else}
						<label class="role-field">Role name<input bind:value={draft.name} maxlength="48" disabled={busy} placeholder="For example, Animator" /></label>
						<label class="role-field">Description<textarea bind:value={draft.description} maxlength="280" rows="2" disabled={busy} placeholder="What does this role do?"></textarea></label>
						<h3>Permissions</h3>
						{#each ALL_LORE_CAPABILITIES as capability}<label class="permission-row"><input type="checkbox" checked={draft.capabilities.includes(capability)} disabled={busy} onchange={() => toggle(capability)} /><span><strong>{CAPABILITY_LABELS[capability] ?? capability}</strong><small>{CAPABILITY_DESCRIPTIONS[capability] ?? capability}</small></span></label>{/each}
					{/if}
				</div>
				<footer class="role-footer"><span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span><div>
					{#if role && !BUILT_IN_LORE_ROLES.includes(role.id)}<button class="role-delete" disabled={busy} onclick={() => void remove()}>Delete role…</button>{/if}
					<button disabled={busy || !dirty} onclick={() => choose(selected)}>Cancel</button><button class="role-save" disabled={busy || !dirty || locked} onclick={() => void save()}>{busy ? 'Saving…' : isNew ? 'Create role' : 'Save changes'}</button>
				</div></footer>
			</div>
		</div>
	{/if}
</section>

<style>
	.roles-admin { display:flex; flex-direction:column; min-height:0; width:100%; max-height:80vh; color:var(--text-primary, #e8eded); background:var(--bg-primary, #111b20); font-size:14px; }
	.roles-head { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; padding:22px; border-bottom:1px solid var(--border-color, #334047); }
	h2 { margin:0; font-size:20px; } h3 { margin:20px 0 12px; font-size:16px; } p { line-height:1.6; margin:6px 0; }
	.roles-head p,small,.role-footer>span { color:var(--text-secondary, #b7c3c9); } small { display:block; margin-top:4px; font-size:13px; line-height:1.5; }
	button,input,textarea { font:inherit; color:inherit; } button { min-height:36px; border:1px solid var(--border-color, #334047); border-radius:7px; padding:8px 12px; background:var(--bg-secondary, #1b292f); cursor:pointer; } button:disabled { opacity:.5; cursor:not-allowed; }
	button:focus-visible,input:focus-visible,textarea:focus-visible { outline:2px solid var(--accent-color, #7cbeb2); outline-offset:3px; }
	.roles-layout { display:grid; grid-template-columns:210px minmax(0,1fr); flex:1; min-height:0; }
	.roles-list { overflow:auto; padding:16px 12px; border-right:1px solid var(--border-color, #334047); }.roles-list button { display:block; width:100%; text-align:left; margin:5px 0; border-color:transparent; background:transparent; }.roles-list button.chosen { border-color:var(--accent-color, #7cbeb2); background:var(--bg-secondary, #1b292f); }
	.roles-eyebrow { font-size:11px; letter-spacing:.1em; text-transform:uppercase; padding:0 12px; }.roles-list hr { border:0; border-top:1px solid var(--border-color, #334047); margin:18px 0; }
	.role-editor { display:flex; flex-direction:column; min-height:0; }.role-fields { padding:24px; overflow:auto; flex:1; }.role-field { display:block; margin-bottom:18px; font-size:13px; }
	.role-field input,.role-field textarea { display:block; width:100%; box-sizing:border-box; margin-top:7px; padding:10px 12px; border:1px solid var(--border-color, #334047); border-radius:7px; background:var(--bg-secondary, #1b292f); }.role-field textarea { resize:vertical; }
	.permission-row { display:flex; align-items:flex-start; gap:14px; padding:15px 0; border-bottom:1px solid var(--border-color, #334047); cursor:pointer; }.permission-row input { width:18px; height:18px; margin:3px 0; flex-shrink:0; accent-color:var(--accent-color, #7cbeb2); }
	.role-footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:16px 22px; border-top:1px solid var(--border-color, #334047); background:var(--bg-secondary, #1b292f); }.role-footer div { display:flex; flex-wrap:wrap; gap:8px; }.role-footer>span { font-size:12px; }.role-save { border-color:var(--accent-color, #7cbeb2); font-weight:650; }.role-delete { color:var(--danger-color, #e68b87); }
	.roles-error,.roles-status { padding:12px 22px; }.roles-error { border-left:3px solid var(--danger-color, #e68b87); }.system-role { padding:20px 0; max-width:55ch; }.system-role :global(svg) { color:var(--accent-color, #7cbeb2); }
	@media(max-width:650px) { .roles-layout { grid-template-columns:1fr; }.roles-list { display:flex; flex-wrap:wrap; max-height:190px; border-right:0; border-bottom:1px solid var(--border-color, #334047); }.roles-list button { width:auto; flex:1 0 130px; }.roles-eyebrow,.roles-list hr { display:none; }.role-fields { padding:18px; }.roles-admin { max-height:none; } }
</style>
