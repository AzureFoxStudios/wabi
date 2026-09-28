<script lang="ts">
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { channels } from '$lib/socket';
	import type { AdminChannelEntry } from '$lib/adminChannelNavigation';
	let { customChannels, onOpenChannel }: { customChannels?: AdminChannelEntry[]; onOpenChannel?: (channelId: string) => boolean } = $props();

	let minRoles: Record<string, string> = $state({});
	let loading = $state(true);
	let busy = $state('');
	let error = $state('');
	let saved = $state('');
	const ordinary = $derived((customChannels ?? $channels).filter(channel => !['dm', 'group', 'category', 'reception'].includes(channel.type)));

	async function request(path: string, init: RequestInit = {}, server = $activeServerUrl) {
		const token = getAuthToken(server);
		if (!token) throw new Error('Sign in again to manage channel access.');
		const response = await fetch(`${server}/api/server-center${path}`, {
			...init, credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Channel access request failed (${response.status}).`);
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
			saved = 'Channel access saved. Members who no longer qualify have been removed.';
		} catch (cause) { if (server === $activeServerUrl) error = cause instanceof Error ? cause.message : 'Could not save channel access.'; }
		finally { if (server === $activeServerUrl) busy = ''; }
	}
	$effect(() => { const server = $activeServerUrl; minRoles = {}; loading = true; busy = ''; saved = ''; void refresh(server); });
</script>

<details class="channel-gates">
	<summary><strong>Channel role access</strong><span>Choose who can open each ordinary channel.</span></summary>
	<p>These are server-enforced staff-role gates. Self-selected community roles are configured below and can open linked rooms; sidebar visibility is only a personal preference. Changing a gate removes viewers who no longer qualify.</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if saved}<p role="status">{saved}</p>{/if}
	{#if loading}<p>Loading channel access…</p>{:else}
		{#each ordinary as channel (channel.id)}
			<label class="gate-row"><span>#{channel.name}{#if onOpenChannel}<button type="button" class="open-channel" onclick={() => onOpenChannel?.(channel.id)}>Open</button>{/if}</span><select aria-label={`Minimum role for ${channel.name}`} value={minRoles[channel.id] ?? ''} onchange={event => void setRole(channel.id, event.currentTarget.value)} disabled={busy === channel.id}>
				<option value="">All signed-in accounts</option><option value="member">Registered members</option><option value="moderator">Moderators and admins</option><option value="admin">Admins and owner</option>
			</select></label>
		{/each}
	{/if}
</details>

<style>
	.channel-gates{padding:18px;border:1px solid var(--border-default);border-radius:16px;background:var(--surface-raised);margin-bottom:18px}.channel-gates summary{cursor:pointer;display:grid;gap:4px}.channel-gates summary span,.channel-gates p{color:var(--text-secondary);font-size:.84rem}.gate-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--border-default);padding:10px 0}.gate-row span{font-weight:600}.gate-row select{min-width:180px;max-width:100%;padding:8px 10px;border:1px solid var(--border-default);border-radius:9px;background:var(--surface-base);color:var(--text-primary);font:inherit}.open-channel{margin-left:8px;border:0;background:none;color:var(--accent-primary);font:inherit;cursor:pointer}.error{color:var(--danger)}@media(max-width:600px){.gate-row{align-items:stretch;flex-direction:column}.gate-row select{width:100%}}
</style>
