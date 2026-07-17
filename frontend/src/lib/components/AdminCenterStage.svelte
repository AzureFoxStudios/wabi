<script lang="ts">
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { currentUser } from '$lib/socket'
  import { layoutStore } from '$lib/layoutStore'
  import { getAuthToken } from '$lib/authSession'
  import OverviewSection from './admin/OverviewSection.svelte'
  import type { DashboardStats } from './admin/OverviewSection.svelte'
  import AdminWorkspace from './AdminWorkspace.svelte'
  import { getAdminPaymentAccessPolicy, type PaymentAccessPolicy } from '$lib/api'

  type Section =
    | 'overview' | 'users' | 'roles' | 'channels' | 'gates'
    | 'runtime' | 'branding' | 'settings'

  const sectionMeta: Record<Section, { label: string; icon: string; badge?: string }> = {
    overview: { label: 'Overview', icon: 'overview' },
    users: { label: 'Users', icon: 'users' },
    roles: { label: 'Roles', icon: 'roles' },
    channels: { label: 'Channels', icon: 'channels' },
    gates: { label: 'Role Gates', icon: 'gates' },
    runtime: { label: 'Runtime', icon: 'runtime' },
    branding: { label: 'Branding', icon: 'branding' },
    settings: { label: 'Server Policy', icon: 'settings' },
  }

  const sectionAccess: Record<Section, string[]> = {
    overview: ['owner', 'admin', 'mod'],
    users: ['owner', 'admin', 'mod'],
    roles: ['owner', 'admin'],
    channels: ['owner', 'admin'],
    gates: ['owner', 'admin'],
    runtime: ['owner', 'admin'],
    branding: ['owner', 'admin'],
    settings: ['owner', 'admin'],
  }

  let section: Section = 'overview'
  let stats: DashboardStats | null = null
  let statsLoading = true
  let timeStr = ''
  let paymentPolicy: PaymentAccessPolicy | null = null
  let paymentLoading = true

  $: role = $currentUser?.highestRole || 'member'
  $: canAccess = (s: Section) => sectionAccess[s].includes(role)

  function visibleSections(): Array<{ id: Section; meta: typeof sectionMeta[Section] }> {
    const result: Array<{ id: Section; meta: typeof sectionMeta[Section] }> = []
    for (const [id, meta] of Object.entries(sectionMeta)) {
      if (canAccess(id as Section)) {
        result.push({ id: id as Section, meta })
      }
    }
    return result
  }

  async function fetchStats() {
    const token = getAuthToken()
    if (!token) { statsLoading = false; return }
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        stats = await res.json()
      }
    } catch {
      // stats stay null
    } finally {
      statsLoading = false
    }
  }

  async function fetchPaymentPolicy() {
    const token = getAuthToken()
    paymentLoading = true
    if (!token) { paymentLoading = false; return }
    try {
      const policy = await getAdminPaymentAccessPolicy(token)
      paymentPolicy = {
        ...policy,
        allowedRoleNames: Array.isArray(policy.allowedRoleNames)
          ? policy.allowedRoleNames.map((r) => r.toLowerCase())
          : []
      }
    } catch {
      paymentPolicy = null
    } finally {
      paymentLoading = false
    }
  }

  function goBackToChat() {
    layoutStore.setCenterPanelView('chat')
  }

  onMount(() => {
    fetchStats()
    fetchPaymentPolicy()
    const interval = setInterval(fetchStats, 30000)
    const clock = setInterval(() => {
      const now = new Date()
      timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }, 1000)
    return () => { clearInterval(interval); clearInterval(clock) }
  })
</script>

<div class="admin-center-stage">
  <!-- Sidebar -->
  <aside class="admin-sidebar">
    <div class="admin-sidebar-header">
      <button class="admin-back-btn" on:click={goBackToChat} title="Back to Chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        <span>Back</span>
      </button>
    </div>

    <div class="admin-sidebar-role">
      <span class="admin-role-tag" class:admin-role-owner={role === 'owner'} class:admin-role-admin={role === 'admin'} class:admin-role-mod={role === 'mod'}>
        {role}
      </span>
      <span class="admin-role-label">viewing as</span>
    </div>

    <nav class="admin-sidebar-nav">
      {#each visibleSections() as item}
        {@const isActive = section === item.id}
        <button
          class="admin-nav-item"
          class:admin-nav-active={isActive}
          on:click={() => section = item.id}
        >
          <span class="admin-nav-icon">
            {#if item.meta.icon === 'overview'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            {:else if item.meta.icon === 'users'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>
            {:else if item.meta.icon === 'channels'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
            {:else if item.meta.icon === 'roles'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            {:else if item.meta.icon === 'gates'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            {:else if item.meta.icon === 'runtime'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            {:else if item.meta.icon === 'branding'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            {:else if item.meta.icon === 'settings'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
            {/if}
          </span>
          <span class="admin-nav-label">{item.meta.label}</span>
        </button>
      {/each}
    </nav>

    <div class="admin-sidebar-footer">
      <span class="admin-footer-dot" />
      <span class="admin-footer-text">System Online</span>
    </div>
  </aside>

  <!-- Main -->
  <div class="admin-main">
    <header class="admin-topbar">
      <div class="admin-topbar-left">
        <h2 class="admin-topbar-title">{sectionMeta[section].label}</h2>
        {#if role === 'mod'}
          <span class="admin-topbar-badge">View Only</span>
        {/if}
      </div>
      <div class="admin-topbar-right">
        {#if stats}
          <div class="admin-topbar-stats">
            <span class="admin-topbar-dot" />
            <span class="admin-topbar-stat">{stats.overview.onlineUsers} online</span>
            <span class="admin-topbar-sep" />
            <span class="admin-topbar-stat">{stats.overview.totalUsers} total</span>
          </div>
        {/if}
        <span class="admin-topbar-clock">{timeStr}</span>
      </div>
    </header>

    <main class="admin-content">
      {#key section}
        <div class="admin-content-inner" in:fade={{ duration: 200 }}>
          {#if section === 'overview'}
            <OverviewSection {stats} loading={statsLoading} paymentPolicy={paymentPolicy} paymentLoading={paymentLoading} />
          {:else}
            <AdminWorkspace section={section} />
          {/if}
        </div>
      {/key}
    </main>
  </div>
</div>
