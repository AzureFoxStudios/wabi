<script lang="ts">
	import { _ } from '$lib/i18n';
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
	import ModerationCenter from './admin/ModerationCenter.svelte';
	import CommunityRulesPanel from './admin/CommunityRulesPanel.svelte';
	import RaidModePanel from './admin/RaidModePanel.svelte';
	import ChannelAccessPanel from './admin/ChannelAccessPanel.svelte';
	import SafetyRulesPanel from './admin/SafetyRulesPanel.svelte';
	import PrivacyCenter from './admin/PrivacyCenter.svelte';
	import StorageCenter from './admin/StorageCenter.svelte';
	import InfrastructureCenter from './admin/InfrastructureCenter.svelte';
	import AdminWorkspace from './AdminWorkspace.svelte';

	const icons: Partial<Record<AdminSection, IconName>> = {
		overview: 'activity', moderation: 'admin', safety: 'admin', privacy: 'settings', runtime: 'activity', users: 'users', roles: 'admin',
		channels: 'messages', storage: 'box', infrastructure: 'activity', branding: 'media', settings: 'settings', payments: 'box',
	};
	let snapshot = $state.raw(emptyAdminSnapshot());
	let now = $state(Date.now());
	let resource: ReturnType<typeof createAdminDashboardResource> | null = null;
	const role = $derived($currentUser?.highestRole?.toLowerCase() ?? 'member');
	const accountId = $derived($currentUser?.dbUserId ?? $currentUser?.id ?? null);
	const sections = $derived(adminSectionsFor(role));
	const section = $derived(resolveAdminSection($adminSection, role));
	const selected = $derived(sections.find(item => item.id === section));
	const knownAdminSections = new Set(['all', 'users', 'roles', 'channels', 'gates', 'payments', 'runtime', 'branding', 'settings']);
	const workspaceSection = $derived<'all' | 'users' | 'roles' | 'channels' | 'gates' | 'payments' | 'runtime' | 'branding' | 'settings'>(knownAdminSections.has(section as string) ? (section as any) : 'all');
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
					if (!isCurrent()) throw new AdminDashboardAccessError($_('admin_stage.session_changed'));
					const token = getAuthToken(server);
					if (!token) throw new AdminDashboardAccessError($_('admin_stage.sign_in_status'));
					return fetch(server + '/api/admin/stats', { headers: { Authorization: 'Bearer ' + token }, credentials: 'include', signal });
				};
				let response = await request();
				if (response.status === 401 && isCurrent() && !signal.aborted && await tryRefresh(server)) response = await request();
				signal.throwIfAborted();
				if (!isCurrent()) throw new AdminDashboardAccessError($_('admin_stage.session_changed'));
				if (response.status === 401 || response.status === 403) throw new AdminDashboardAccessError($_('admin_stage.access_lost'));
				if (!response.ok) throw new Error($_('admin_stage.read_failed', { values: { status: response.status } }));
				if (!/\bjson\b/i.test(response.headers.get('content-type') ?? '')) throw new Error($_('admin_stage.no_snapshot_returned'));
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
	<aside class="admin-sidebar" aria-label={$_('admin_stage.title')}>
		<div class="admin-sidebar-header">
			<button class="admin-back-btn" onclick={back}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7" /></svg>
				{$_('admin_stage.back')}
			</button>
		</div>
		<div class="admin-identity"><strong>{$_('admin_stage.title')}</strong><span>{canManageServer(role) ? $_('admin_stage.community_ops') : $_('admin_stage.moderation_workspace')}</span></div>
		<nav class="admin-sidebar-nav" aria-label={$_('admin_stage.sections_label')}>
			{#each sections as item (item.id)}
				<button class="admin-nav-item" class:admin-nav-active={section === item.id} aria-current={section === item.id ? 'page' : undefined} onclick={() => navigate(item.id)}>
					<span class="admin-nav-icon" aria-hidden="true"><WorkspacePanelIcon icon={icons[item.id] ?? 'settings'} /></span>
					<span class="admin-nav-label">{$_(item.labelKey)}</span>
				</button>
			{/each}
		</nav>
	</aside>
	<div class="admin-main">
		<header class="admin-topbar">
			<div class="admin-heading"><h1>{selected ? $_(selected.labelKey) : $_('admin_stage.title')}</h1><p>{selected ? $_(selected.descriptionKey) : $_('admin_stage.no_access')}</p></div>
			{#if canManageServer(role) && (section === 'overview' || section === 'runtime')}
				<div class="admin-snapshot-controls">
					<span class:stale>{snapshot.receivedAt ? (stale ? $_('admin_stage.last_snapshot') + ' ' : $_('wiki.updated') + ' ') + new Date(snapshot.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : $_('admin_stage.no_snapshot_yet')}</span>
					<button class="admin-refresh" onclick={() => resource?.refresh()} disabled={snapshot.loading}>{snapshot.loading ? $_('admin_stage.refreshing') : $_('yt.refresh')}</button>
				</div>
			{/if}
		</header>
		<main class="admin-content" aria-label={selected ? $_(selected.labelKey) : $_('admin_stage.title')}>
			{#if snapshot.error && (section === 'overview' || section === 'runtime')}
				<div class="admin-read-error" role="alert"><strong>{$_('admin_stage.status_unavailable')}</strong><p>{snapshot.error} {snapshot.stats ? $_('admin_stage.last_shown_below') : ''}</p></div>
			{/if}
			<div class="admin-content-inner">
				{#if section === 'overview'}
					<OverviewSection stats={snapshot.stats} loading={snapshot.loading} {stale} onNavigate={navigate} />
				{:else if section === 'moderation'}
					{#key JSON.stringify([$activeServerUrl, accountId, role])}
						{#if canManageServer(role)}<CommunityRulesPanel />{/if}
						{#if canManageServer(role)}<RaidModePanel />{/if}
						{#if canManageServer(role)}<ChannelAccessPanel />{/if}
						<ModerationCenter />
					{/key}
				{:else if section === 'safety'}
					<SafetyRulesPanel />
				{:else if section === 'privacy'}
					{#key JSON.stringify([$activeServerUrl, accountId, role])}<PrivacyCenter />{/key}
				{:else if section === 'storage'}
					<StorageCenter />
					{:else if section === 'infrastructure'}
						{#key JSON.stringify([$activeServerUrl, accountId, role])}<InfrastructureCenter owner={role === 'owner'} />{/key}
				{:else if section === 'runtime'}
					<ServerHealthSection health={snapshot.stats?.extra?.health} loading={snapshot.loading && !snapshot.stats} {stale} expanded />
				{:else if section}
				  {#key JSON.stringify([$activeServerUrl, accountId, role, section])}<AdminWorkspace section={workspaceSection} />{/key}
				{:else}
					<p class="admin-access-message" role="status">{$_('admin_stage.unavailable_note')}</p>
				{/if}
			</div>
		</main>
	</div>
</div>
