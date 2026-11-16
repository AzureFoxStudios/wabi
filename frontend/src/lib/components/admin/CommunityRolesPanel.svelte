<script lang="ts">
	import { _ } from '$lib/i18n';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { channels } from '$lib/socket';

	type CommunityRole = { id: string; name: string; description: string };
	let roles: CommunityRole[] = $state([]);
	let channelRoles: Record<string, string> = $state({});
	let revision = $state(0);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state('');
	const rooms = $derived($channels.filter(channel => !['dm', 'group', 'category', 'reception'].includes(channel.type)));

	async function request(path: string, init: RequestInit = {}, server = $activeServerUrl) {
		const token = getAuthToken(server);
		if (!token) throw new Error($_('community_roles.sign_in_again'));
		const response = await fetch(`${server}/api/server-center${path}`, {
			...init, credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(body.error || $_('community_roles.request_failed', { values: { status: response.status } }));
		return body;
	}

	async function refresh(server = $activeServerUrl) {
		loading = true; error = '';
		try {
			const data = await request('/community-roles', {}, server);
			if (server !== $activeServerUrl) return;
			roles = data.roles ?? [];
			channelRoles = data.channelRoles ?? {};
			revision = data.revision ?? 0;
		} catch (cause) {
			if (server === $activeServerUrl) error = cause instanceof Error ? cause.message : $_('community_roles.load_failed');
		} finally { if (server === $activeServerUrl) loading = false; }
	}

	function addRole() {
		if (roles.length >= 16) return;
		const unique = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		roles = [...roles, { id: `community-${unique}`, name: '', description: '' }];
		saved = '';
	}
	function updateRole(id: string, field: 'name' | 'description', value: string) {
		roles = roles.map(role => role.id === id ? { ...role, [field]: value } : role);
		saved = '';
	}
	function removeRole(id: string) {
		roles = roles.filter(role => role.id !== id);
		channelRoles = Object.fromEntries(Object.entries(channelRoles).filter(([, roleId]) => roleId !== id));
		saved = '';
	}
	async function save() {
		const server = $activeServerUrl;
		saving = true; error = ''; saved = '';
		try {
			const currentRoomIds = new Set(rooms.map(room => room.id));
			const data = await request('/community-roles', { method: 'PUT', body: JSON.stringify({
				expectedRevision: revision,
				roles: roles.map(role => ({ ...role, name: role.name.trim(), description: role.description.trim() })),
				channelRoles: Object.fromEntries(Object.entries(channelRoles).filter(([channel, role]) => role && currentRoomIds.has(channel)))
			}) }, server);
			if (server !== $activeServerUrl) return;
			revision = data.revision;
			saved = $_('community_roles.saved');
		} catch (cause) {
			if (server === $activeServerUrl) error = cause instanceof Error ? cause.message : $_('community_roles.save_failed');
		} finally { if (server === $activeServerUrl) saving = false; }
	}

	$effect(() => { const server = $activeServerUrl; roles = []; channelRoles = {}; saved = ''; void refresh(server); });
</script>

<details class="community-roles" open>
	<summary><strong>{$_('community_roles.summary_title')}</strong><span>{$_('community_roles.summary_hint')}</span></summary>
	<p>{$_('community_roles.description')}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if saved}<p role="status">{saved}</p>{/if}
	{#if loading}<p>{$_('community_roles.loading')}</p>{:else}
		<div class="role-list">
			{#each roles as role (role.id)}
				<div class="role-row">
					<label>{$_('community_roles.role_name')}<input maxlength="40" value={role.name} oninput={event => updateRole(role.id, 'name', event.currentTarget.value)} placeholder={$_('community_roles.role_name_ph')} /></label>
					<label>{$_('community_roles.role_for')}<input maxlength="240" value={role.description} oninput={event => updateRole(role.id, 'description', event.currentTarget.value)} placeholder={$_('community_roles.role_for_ph')} /></label>
					<button type="button" onclick={() => removeRole(role.id)} aria-label={$_('community_roles.remove', { values: { name: role.name || $_('community_roles.new_role') } })}>{$_('community_roles.remove_btn')}</button>
				</div>
			{/each}
			<button type="button" onclick={addRole} disabled={roles.length >= 16}>{$_('community_roles.add_role')}</button>
		</div>
		{#if roles.length}
			<h3>{$_('community_roles.rooms_heading')}</h3>
			<div class="room-list">
				{#each rooms as room (room.id)}
					<label><span>#{room.name}{#if room.description}<small>{room.description}</small>{/if}</span>
						<select aria-label={$_('community_roles.room_role_label', { values: { name: room.name } })} value={channelRoles[room.id] ?? ''} onchange={event => { channelRoles = { ...channelRoles, [room.id]: event.currentTarget.value }; saved = ''; }}>
							<option value="">{$_('community_roles.no_role_required')}</option>
							{#each roles as role (role.id)}<option value={role.id}>{role.name || $_('community_roles.unnamed')}</option>{/each}
						</select>
					</label>
				{/each}
			</div>
		{/if}
		<div class="actions"><button class="save" type="button" onclick={save} disabled={saving || roles.some(role => !role.name.trim())}>{saving ? $_('community_roles.saving') : $_('community_roles.save_roles')}</button><button type="button" onclick={() => refresh()} disabled={saving}>{$_('community_roles.reload')}</button></div>
	{/if}
</details>

<style>
	.community-roles { padding: 18px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-bg2); margin-bottom: 18px; }
	summary { cursor: pointer; display: grid; gap: 4px; }
	summary strong { font: 600 calc(16px * var(--w-fs, 1)) var(--w-sans); color: var(--w-text); }
	summary span, p, small { color: var(--w-mute); font: 400 calc(13px * var(--w-fs, 1))/1.5 var(--w-sans); }
	h3 { margin: 18px 0 4px; font: 600 calc(17px * var(--w-fs, 1)) var(--w-serif); color: var(--w-text); text-transform: none; letter-spacing: 0.01em; }
	.role-list, .room-list { display: grid; gap: 10px; margin: 14px 0; }
	.role-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) auto; gap: 10px; align-items: end; padding: 12px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-bg); }
	label { display: grid; gap: 5px; font: 600 calc(12px * var(--w-fs, 1)) var(--w-sans); color: var(--w-mute); }
	input, select { min-width: 0; min-height: 36px; padding: 7px 10px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-sink); color: var(--w-text); font: 400 calc(14px * var(--w-fs, 1)) var(--w-sans); }
	input:focus, select:focus { outline: none; border-color: var(--w-accent); box-shadow: var(--w-ring); }
	.room-list label { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-top: var(--w-bw, 1px) solid var(--w-line); color: var(--w-text); font-weight: 500; }
	.room-list small { display: block; margin-top: 3px; }
	.room-list select { min-width: 190px; }
	button { min-height: 34px; padding: 6px 13px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); background: transparent; color: var(--w-text); font: 600 calc(13px * var(--w-fs, 1)) var(--w-sans); cursor: pointer; }
	button:hover:not(:disabled) { background: var(--w-raise); border-color: var(--w-accent); }
	button:disabled { opacity: 0.45; cursor: not-allowed; }
	.actions { display: flex; gap: 10px; margin-top: 10px; }
	.save { background: var(--w-text); color: var(--w-bg); border-color: transparent; }
	.save:hover:not(:disabled) { background: color-mix(in srgb, var(--w-text) 88%, var(--w-accent)); border-color: transparent; }
	.error { color: var(--w-danger); }
	@media (max-width: 650px) { .role-row { grid-template-columns: 1fr; } .room-list label { align-items: stretch; flex-direction: column; } .room-list select { width: 100%; } }
</style>
