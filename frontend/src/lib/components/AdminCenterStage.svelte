<script lang="ts">
	import { onMount, tick } from 'svelte';
	import '$lib/../styles/components/admin-center-stage.css';
	import '$lib/../styles/components/admin-workbench.css';
	import { currentUser } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getAuthToken, authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
	import { activeServerUrl } from '$lib/serverUrl';
	import { tryRefresh } from '$lib/api/authRefresh';
	import { adminSectionsFor, canManageServer, resolveAdminSection, type AdminSection } from '$lib/adminNavigation';
	import { adminSection } from '$lib/adminNavigationState';
	import { createAdminDashboardResource, emptyAdminSnapshot, AdminDashboardAccessError } from '$lib/adminDashboardResource';
	import type { WorkspacePanelIcon as IconName } from '$lib/workspacePanels';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import OverviewSection from './admin/OverviewSection.svelte';
	import ServerHealthSection from './admin/ServerHealthSection.svelte';
	import AdminWorkspace from './AdminWorkspace.svelte';

	const icons: Partial<Record<AdminSection, IconName>> = {
		overview: 'activity', runtime: 'activity', users: 'users', roles: 'admin',
		channels: 'messages', branding: 'media', settings: 'settings', payments: 'box',
	};
	let snapshot = $state.raw(emptyAdminSnapshot());
	let now = $state(Date.now());
	let resource: ReturnType<typeof createAdminDashboardResource> | null = null;
	const role = $derived($currentUser?.highestRole?.toLowerCase() ?? 'member');
	const accountId = $derived($currentUser?.dbUserId ?? $currentUser?.id ?? null);
	const sections = $derived(adminSectionsFor(role));
	const section = $derived(resolveAdminSection($adminSection, role));
	const selected = $derived(sections.find(item => item.id === section));
	const stale = $derived(Boolean(snapshot.stats && (snapshot.error || !snapshot.receivedAt || now - snapshot.receivedAt > 90_000)));

	$effect(() => {
		const server = $activeServerUrl;
		const identity = accountId;
		const allowed = canManageServer(role);
		snapshot = emptyAdminSnapshot();
		const off = onAuthSessionCleared(cleared => {
			if (cleared !== server) return;
			resource?.dispose();
			snapshot = emptyAdminSnapshot();
			// Retire the whole privileged editor, not only its statistics.
			// A same-account re-login must not inherit this session's draft.
			layoutStore.setCenterPanelView('chat');
		});
		if (!allowed || !identity) return off;
		const generation = authSessionGeneration(server);
		const isCurrent = () => authSessionGeneration(server) === generation;
		const owner = createAdminDashboardResource({
			onChange: next => { snapshot = next; now = Date.now(); },
			read: async signal => {
				const request = async () => {
					signal.throwIfAborted();
					if (!isCurrent()) throw new AdminDashboardAccessError('Your session changed. Reopen Administration.');
					const token = getAuthToken(server);
					if (!token) throw new AdminDashboardAccessError('Sign in again to view server status.');
					return fetch(server + '/api/admin/stats', { headers: { Authorization: 'Bearer ' + token }, credentials: 'include', signal });
				};
				let response = await request();
				if (response.status === 401 && isCurrent() && !signal.aborted && await tryRefresh(server)) response = await request();
				signal.throwIfAborted();
				if (!isCurrent()) throw new AdminDashboardAccessError('Your session changed. Reopen Administration.');
				if (response.status === 401 || response.status === 403) throw new AdminDashboardAccessError('Administrator access is no longer available. Sign in again or contact the owner.');
				if (!response.ok) throw new Error('Could not read server status (HTTP ' + response.status + ').');
				if (!/\bjson\b/i.test(response.headers.get('content-type') ?? '')) throw new Error('The server did not return an administration snapshot.');
				return response.json();
			},
		});
		resource = owner;
		void owner.refresh();
		const interval = setInterval(() => { now = Date.now(); if (!document.hidden) void owner.refresh(); }, 30_000);
		const visible = () => { now = Date.now(); if (!document.hidden) void owner.refresh(); };
		document.addEventListener('visibilitychange', visible);
		return () => {
			owner.dispose(); off(); clearInterval(interval); document.removeEventListener('visibilitychange', visible);
			if (resource === owner) resource = null;
		};
	});

	function navigate(destination: AdminSection): void {
		adminSection.set(destination);
	}

	async function back(): Promise<void> {
		layoutStore.setCenterPanelView('chat');
		await tick();
		document.querySelector<HTMLButtonElement>('.workspace-trigger')?.focus();
	}

	onMount(() => { document.querySelector<HTMLButtonElement>('.admin-back-btn')?.focus(); });
</script>

<div class="admin-center-stage admin-workbench">
	<aside class="admin-sidebar" aria-label="Administration">
		<div class="admin-sidebar-header">
			<button class="admin-back-btn" onclick={back}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7" /></svg>
				Back to workspace
			</button>
		</div>
		<div class="admin-identity"><strong>Administration</strong><span>{canManageServer(role) ? 'Manage this server' : 'Staff workspace'}</span></div>
		<nav class="admin-sidebar-nav" aria-label="Admin sections">
			{#each sections as item (item.id)}
				<button class="admin-nav-item" class:admin-nav-active={section === item.id} aria-current={section === item.id ? 'page' : undefined} onclick={() => navigate(item.id)}>
					<span class="admin-nav-icon" aria-hidden="true"><WorkspacePanelIcon icon={icons[item.id] ?? 'settings'} /></span>
					<span class="admin-nav-label">{item.label}</span>
				</button>
			{/each}
		</nav>
	</aside>
	<div class="admin-main">
		<header class="admin-topbar">
			<div class="admin-heading"><h1>{selected?.label ?? 'Administration'}</h1><p>{selected?.description ?? 'Your server role does not grant access to this workspace.'}</p></div>
			{#if canManageServer(role)}
				<div class="admin-snapshot-controls">
					<span class:stale>{snapshot.receivedAt ? (stale ? 'Last snapshot ' : 'Updated ') + new Date(snapshot.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'No snapshot yet'}</span>
					<button class="admin-refresh" onclick={() => resource?.refresh()} disabled={snapshot.loading}>{snapshot.loading ? 'Refreshing…' : 'Refresh'}</button>
				</div>
			{/if}
		</header>
		<main class="admin-content" aria-label={selected?.label ?? 'Administration'}>
			{#if snapshot.error && (section === 'overview' || section === 'runtime')}
				<div class="admin-read-error" role="alert"><strong>Server status unavailable</strong><p>{snapshot.error} {snapshot.stats ? 'The last snapshot is shown below; it is not a current health check.' : ''}</p></div>
			{/if}
			<div class="admin-content-inner">
				{#if section === 'overview'}
					<OverviewSection stats={snapshot.stats} loading={snapshot.loading} {stale} onNavigate={navigate} />
				{:else if section === 'runtime'}
					<ServerHealthSection health={snapshot.stats?.extra?.health} loading={snapshot.loading && !snapshot.stats} {stale} expanded />
				{:else if section}
					{#key JSON.stringify([$activeServerUrl, accountId, role, section])}<AdminWorkspace {section} />{/key}
				{:else}
					<p class="admin-access-message" role="status">Administration is available to server staff. Your workspace and conversations are unchanged.</p>
				{/if}
			</div>
		</main>
	</div>
</div>
