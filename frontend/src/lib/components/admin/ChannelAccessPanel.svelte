<script lang="ts">
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { channels, currentUser, type Channel } from '$lib/socket';
	import { createChannel, deleteChannel, updateChannelSettings, type CreateableChannelType } from '$lib/channelStore';
	import { getChannelTypeLabel } from '$lib/channelTypes';
	import type { AdminChannelEntry } from '$lib/adminChannelNavigation';
	import ChannelSettingsModal from '../sidebar/ChannelSettingsModal.svelte';

	let { customChannels, onOpenChannel }: { customChannels?: AdminChannelEntry[]; onOpenChannel?: (channelId: string) => boolean } = $props();

	let minRoles: Record<string, string> = $state({});
	let loading = $state(true);
	let busy = $state('');
	let error = $state('');
	let saved = $state('');
	let editing = $state<Channel | null>(null);
	let confirmDelete = $state<Channel | null>(null);
	let deleting = $state(false);

	// New channel
	let newName = $state('');
	let newType = $state<CreateableChannelType>('text');
	let creating = $state(false);

	const TYPES: CreateableChannelType[] = ['text', 'voice', 'forum', 'gallery', 'wiki', 'stage', 'planning'];
	const isOwner = $derived($currentUser?.highestRole === 'owner');
	const isStaff = $derived(['owner', 'admin'].includes($currentUser?.highestRole || ''));
	const ordinary = $derived(
		(customChannels ?? $channels).flatMap((entry) => {
			const full = $channels.find((channel) => channel.id === entry.id);
			return full && !['dm', 'group', 'category', 'reception'].includes(String(full.type)) ? [full] : [];
		})
	);

	function retentionLabel(channel: Channel): string {
		const value = (channel as { autoDeleteAfter?: string | null }).autoDeleteAfter;
		if (value === null) return 'Keep forever';
		if (value === undefined) return '—';
		return value === 'live' ? 'Live session' : value;
	}

	async function request(path: string, init: RequestInit = {}, server = $activeServerUrl) {
		const token = getAuthToken(server);
		if (!token) throw new Error('Sign in again to manage channels.');
		const response = await fetch(`${server}/api/server-center${path}`, {
			...init, credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
		return data;
	}
	async function refresh(server = $activeServerUrl) {
		loading = true; error = '';
		try { const data = await request('/channel-gates', {}, server); if (server === $activeServerUrl) minRoles = data.minRoles ?? {}; }
		catch (cause) { if (server === $activeServerUrl) error = cause instanceof Error ? cause.message : 'Could not load channel access.'; }
		finally { if (server === $activeServerUrl) loading = false; }
	}
	async function setRole(channelId: string, role: string) {
		const server = $activeServerUrl;
		busy = channelId; error = ''; saved = '';
		try {
			await request(`/channel-gates/${encodeURIComponent(channelId)}`, { method: 'PUT', body: JSON.stringify({ minRole: role || null }) }, server);
			if (server !== $activeServerUrl) return;
			minRoles = { ...minRoles, [channelId]: role };
			saved = 'Access saved. Members who no longer qualify have been removed from the room.';
		} catch (cause) { if (server === $activeServerUrl) error = cause instanceof Error ? cause.message : 'Could not save channel access.'; }
		finally { if (server === $activeServerUrl) busy = ''; }
	}
	async function submitCreate() {
		const name = newName.trim();
		if (!name || creating) return;
		creating = true; error = ''; saved = '';
		try {
			const id = await createChannel(name, undefined, newType);
			if (!id) throw new Error('The server did not create the channel.');
			newName = '';
			saved = `Created #${name}.`;
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Could not create the channel.'; }
		finally { creating = false; }
	}
	async function confirmRemoval() {
		if (!confirmDelete || deleting) return;
		deleting = true; error = '';
		try { const name = confirmDelete.name; await deleteChannel(confirmDelete.id); saved = `Deleted #${name}.`; confirmDelete = null; }
		catch (cause) { error = cause instanceof Error ? cause.message : 'Could not delete the channel.'; }
		finally { deleting = false; }
	}
	function saveSettings(event: CustomEvent<{ channelId: string; updates: Parameters<typeof updateChannelSettings>[1] }>) {
		updateChannelSettings(event.detail.channelId, event.detail.updates);
		editing = null;
		saved = 'Channel settings saved.';
	}
	function requestDelete(event: CustomEvent<{ channel: Channel }>) { editing = null; confirmDelete = event.detail.channel; }

	$effect(() => { const server = $activeServerUrl; minRoles = {}; loading = true; busy = ''; saved = ''; void refresh(server); });
</script>

<section class="channels-center" aria-labelledby="channels-center-title">
	<header class="cc-head">
		<div>
			<h3 id="channels-center-title">Channels</h3>
			<p>Every room on this server: create, rename and tune it, and choose who may open it.</p>
		</div>
		<span class="cc-count">{ordinary.length} rooms</span>
	</header>

	{#if error}<p class="cc-note cc-error" role="alert">{error}</p>{/if}
	{#if saved}<p class="cc-note" role="status">{saved}</p>{/if}

	{#if isStaff}
		<form class="cc-create" onsubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
			<label class="cc-field"><span>New channel</span>
				<input class="w-field" bind:value={newName} placeholder="channel-name" maxlength="64" aria-label="New channel name" />
			</label>
			<label class="cc-field cc-type"><span>Type</span>
				<select class="w-field" bind:value={newType} aria-label="New channel type">
					{#each TYPES as type}<option value={type}>{getChannelTypeLabel(type)}</option>{/each}
				</select>
			</label>
			<button type="submit" class="w-btn w-btn--primary" disabled={!newName.trim() || creating}>{creating ? 'Creating…' : 'Create'}</button>
		</form>
	{/if}

	{#if loading}
		<p class="cc-empty">Loading channels…</p>
	{:else if ordinary.length === 0}
		<p class="cc-empty">No channels yet. Create the first one above.</p>
	{:else}
		<div class="cc-table" role="table" aria-label="Channels">
			<div class="cc-row cc-row--head" role="row">
				<span role="columnheader">Room</span><span role="columnheader">Kind</span><span role="columnheader">Messages</span><span role="columnheader">Who can open</span><span role="columnheader"></span>
			</div>
			{#each ordinary as channel (channel.id)}
				<div class="cc-row" role="row">
					<span class="cc-name" role="cell"><b>#{channel.name}</b>{#if channel.description}<small>{channel.description}</small>{/if}</span>
					<span class="w-mono cc-kind" role="cell">{getChannelTypeLabel(channel.type as any)}</span>
					<span class="w-mono cc-ret" role="cell">{retentionLabel(channel)}</span>
					<span role="cell">
						<select class="w-field" aria-label={`Minimum role for ${channel.name}`} value={minRoles[channel.id] ?? ''} onchange={(event) => void setRole(channel.id, event.currentTarget.value)} disabled={busy === channel.id || !isStaff}>
							<option value="">All signed-in accounts</option><option value="member">Registered members</option><option value="moderator">Moderators and admins</option><option value="admin">Admins and owner</option>
						</select>
					</span>
					<span class="cc-actions" role="cell">
						{#if onOpenChannel}<button type="button" class="w-btn w-btn--quiet" onclick={() => onOpenChannel?.(channel.id)}>Open</button>{/if}
						{#if isStaff}<button type="button" class="w-btn" onclick={() => (editing = channel)}>Edit</button>{/if}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</section>

{#if editing}
	<ChannelSettingsModal channel={editing} canTogglePersistMessages={isOwner} canManageWatchQueue={isStaff} canManageVoiceSettings={isStaff} on:save={saveSettings} on:delete={requestDelete} on:close={() => (editing = null)} />
{/if}

{#if confirmDelete}
	<div class="cc-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cc-del-title">
		<div class="cc-confirm-card">
			<h4 id="cc-del-title">Delete #{confirmDelete.name}?</h4>
			<p>This removes the room and its messages for everyone. It cannot be undone.</p>
			<div class="cc-confirm-actions">
				<button type="button" class="w-btn" onclick={() => (confirmDelete = null)} disabled={deleting}>Cancel</button>
				<button type="button" class="w-btn w-btn--danger" onclick={() => void confirmRemoval()} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete channel'}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.channels-center { padding: 20px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-bg2); margin-bottom: 18px; }
	.cc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
	h3 { margin: 0; font: 600 calc(22px * var(--w-fs, 1))/1.2 var(--w-serif); color: var(--w-text); }
	.cc-head p { margin: 4px 0 0; font: 400 calc(13.5px * var(--w-fs, 1))/1.5 var(--w-sans); color: var(--w-mute); }
	.cc-count { font: 500 calc(12px * var(--w-fs, 1)) var(--w-mono); color: var(--w-faint); white-space: nowrap; }
	.cc-note { margin: 0 0 12px; padding: 8px 12px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-bg); font: 500 calc(13px * var(--w-fs, 1)) var(--w-sans); color: var(--w-mute); }
	.cc-error { border-color: color-mix(in srgb, var(--w-danger) 60%, transparent); color: var(--w-danger); }
	.cc-create { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; padding: 12px; margin-bottom: 14px; border: var(--w-bw, 1px) dashed var(--w-line-strong); border-radius: calc(12px * var(--w-rs, 1)); }
	.cc-field { display: grid; gap: 4px; flex: 1 1 200px; font: 600 calc(11.5px * var(--w-fs, 1)) var(--w-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--w-faint); }
	.cc-field.cc-type { flex: 0 1 180px; }
	.cc-empty { color: var(--w-mute); font: 400 calc(14px * var(--w-fs, 1)) var(--w-sans); }
	.cc-table { overflow-x: auto; }
	.cc-row { display: grid; grid-template-columns: minmax(160px, 2fr) 90px 110px minmax(180px, 1.4fr) 130px; gap: 12px; align-items: center; padding: 10px 4px; border-top: var(--w-bw, 1px) solid var(--w-line); min-width: 720px; }
	.cc-row--head { border-top: 0; padding-top: 0; font: 600 calc(11px * var(--w-fs, 1)) var(--w-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--w-faint); }
	.cc-name { display: grid; gap: 2px; min-width: 0; }
	.cc-name b { font: 600 calc(14.5px * var(--w-fs, 1)) var(--w-sans); color: var(--w-text); }
	.cc-name small { font: 400 calc(12.5px * var(--w-fs, 1)) var(--w-sans); color: var(--w-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.cc-kind, .cc-ret { font-size: calc(12px * var(--w-fs, 1)); color: var(--w-mute); }
	.cc-actions { display: flex; gap: 6px; justify-content: flex-end; }
	.cc-confirm { position: fixed; inset: 0; z-index: 2300; display: grid; place-items: center; background: color-mix(in srgb, var(--w-sink) 78%, transparent); }
	.cc-confirm-card { width: min(420px, 92vw); padding: 20px; border: var(--w-bw, 1px) solid var(--w-line-strong); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-bg); box-shadow: var(--w-shadow); }
	.cc-confirm-card h4 { margin: 0 0 6px; font: 600 calc(18px * var(--w-fs, 1)) var(--w-serif); color: var(--w-text); }
	.cc-confirm-card p { margin: 0 0 16px; font: 400 calc(13.5px * var(--w-fs, 1))/1.5 var(--w-sans); color: var(--w-mute); }
	.cc-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
