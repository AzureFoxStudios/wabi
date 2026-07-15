<script context="module" lang="ts">
  export interface DashboardStats {
    overview: {
      totalUsers: number; onlineUsers: number; bannedUsers: number; mutedUsers: number
      totalChannels: number; totalRoles: number; totalEmojis: number; totalMessages: number
      totalAuditEntries: number; openReports: number
    }
    roleDistribution: Array<{ role: string; count: number }>
    statusDistribution: Array<{ status: string; count: number }>
    recentAudit: Array<AuditEntry>
    topUsers: Array<TopUser>
  }

  interface AuditEntry {
    id: number; action: string; performedBy: string
    targetUser: string | null; targetChannel: string | null
    details: string | null; createdAt: string
  }

  interface TopUser {
    username: string; displayName: string | null; role: string
    messageCount: number; xp: number; status: string
  }
</script>

<script lang="ts">
  import Card from './ui/Card.svelte'
  import RingGauge from './ui/RingGauge.svelte'
  import RoleBadge from './ui/RoleBadge.svelte'
  import StatusDot from './ui/StatusDot.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import AnimatedNumber from './ui/AnimatedNumber.svelte'

  export let stats: DashboardStats | null = null
  export let loading = false

  const statCards = [
    { key: 'totalUsers' as const, label: 'Users', icon: 'users', color: 'var(--accent-blue, #3498DB)' },
    { key: 'onlineUsers' as const, label: 'Online', icon: 'online', color: 'var(--accent-green, #4a9e5c)' },
    { key: 'totalMessages' as const, label: 'Messages', icon: 'messages', color: 'var(--accent, var(--accent-primary-color))' },
    { key: 'totalChannels' as const, label: 'Channels', icon: 'channels', color: 'var(--accent-purple, #9B59B6)' },
    { key: 'totalRoles' as const, label: 'Roles', icon: 'roles', color: 'var(--accent-yellow, #F39C12)' },
    { key: 'totalEmojis' as const, label: 'Emojis', icon: 'emojis', color: 'var(--accent, var(--accent-primary-color))' },
    { key: 'bannedUsers' as const, label: 'Banned', icon: 'ban', color: 'var(--accent-red, #d71921)' },
    { key: 'openReports' as const, label: 'Open Reports', icon: 'reports', color: 'var(--accent-red, #d71921)' },
  ]

  const actionLabels: Record<string, { label: string; color: string }> = {
    user_ban: { label: 'BAN', color: 'var(--accent-red, #d71921)' },
    user_kick: { label: 'KICK', color: 'var(--accent-red, #d71921)' },
    user_mute: { label: 'MUTE', color: 'var(--accent-yellow, #F39C12)' },
    user_warn: { label: 'WARN', color: 'var(--accent-yellow, #F39C12)' },
    user_role_change: { label: 'ROLE', color: 'var(--accent-blue, #3498DB)' },
    channel_create: { label: 'CH+', color: 'var(--accent-green, #4a9e5c)' },
    channel_delete: { label: 'CH-', color: 'var(--accent-red, #d71921)' },
    channel_update: { label: 'CH~', color: 'var(--accent-blue, #3498DB)' },
    message_delete: { label: 'MSG-', color: 'var(--accent-red, #d71921)' },
    message_pin: { label: 'PIN', color: 'var(--accent-yellow, #F39C12)' },
    server_update: { label: 'SRV', color: 'var(--accent-purple, #9B59B6)' },
    invite_create: { label: 'INV+', color: 'var(--accent-green, #4a9e5c)' },
    invite_delete: { label: 'INV-', color: 'var(--accent-red, #d71921)' },
    emoji_create: { label: 'EMJ+', color: 'var(--accent-green, #4a9e5c)' },
    emoji_delete: { label: 'EMJ-', color: 'var(--accent-red, #d71921)' },
  }

  $: roleOrder = ['owner', 'admin', 'mod', 'member', 'guest']
  $: sortedRoles = stats
    ? [...stats.roleDistribution].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))
    : []

  const ringColors: Record<string, string> = {
    online: 'var(--accent-green, #4a9e5c)',
    idle: 'var(--accent-yellow, #F39C12)',
    dnd: 'var(--accent-red, #d71921)',
    offline: 'var(--text-disabled, #666)',
  }

  function roleBarColor(role: string): string {
    const colors: Record<string, string> = {
      owner: 'var(--accent-red, #d71921)',
      admin: 'var(--accent-yellow, #F39C12)',
      mod: 'var(--accent-blue, #3498DB)',
      moderator: 'var(--accent-blue, #3498DB)',
      member: 'var(--accent-green, #4a9e5c)',
    }
    return colors[role] ?? '#666'
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }
</script>

<div class="admin-overview">
  {#if loading || !stats}
    <div class="admin-skel-grid">
      {#each Array(8) as _, i}
        <Skeleton className="admin-skel-card" />
      {/each}
    </div>
    <div class="admin-skel-row">
      <Skeleton className="admin-skel-large" />
      <Skeleton className="admin-skel-medium" />
    </div>
  {:else}
    <!-- Stat Cards -->
    <div class="admin-stat-grid">
      {#each statCards as card, i}
        <Card delay={i * 60}>
          <div class="admin-stat-card-inner">
            <div class="admin-stat-card-header">
              <span class="admin-stat-label">{card.label}</span>
              <span class="admin-stat-icon" style="color: {card.color}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  {#if card.icon === 'users' || card.icon === 'online'}
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                  {:else if card.icon === 'messages'}
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  {:else if card.icon === 'channels'}
                    <path d="M4 6h16M4 12h16M4 18h16"/>
                  {:else if card.icon === 'roles'}
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  {:else if card.icon === 'emojis'}
                    <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
                  {:else if card.icon === 'ban'}
                    <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                  {:else if card.icon === 'reports'}
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  {/if}
                </svg>
              </span>
            </div>
            <div class="admin-stat-value">
              <AnimatedNumber value={(stats.overview as any)[card.key]} />
            </div>
            <div class="admin-stat-segbar">
              {#each Array(12) as _, si}
                <div
                  class="admin-seg-segment"
                  class:admin-seg-active={si < Math.min(Math.ceil(((stats.overview as any)[card.key] / Math.max(stats.overview.totalUsers, 1)) * 12), 12)}
                  style="animation-delay: {si * 30}ms"
                />
              {/each}
            </div>
          </div>
        </Card>
      {/each}
    </div>

    <!-- Second row: Ring gauges + Activity -->
    <div class="admin-overview-row">
      <Card delay={500} className="admin-ring-card">
        <span class="admin-section-label">User Status</span>
        <div class="admin-ring-grid">
          {#each stats.statusDistribution as s}
            <RingGauge
              value={s.count}
              max={stats.overview.totalUsers}
              label={s.status}
              color={ringColors[s.status] ?? 'var(--accent)'}
            />
          {/each}
        </div>
      </Card>

      <Card delay={560} className="admin-activity-card">
        <div class="admin-activity-header">
          <span class="admin-section-label">Recent Activity</span>
          <div class="admin-live-indicator">
            <span class="admin-live-dot" />
            <span class="admin-live-text">LIVE</span>
          </div>
        </div>
        <div class="admin-activity-feed">
          {#each stats.recentAudit as entry, i}
            {@const meta = actionLabels[entry.action] ?? { label: entry.action, color: 'var(--text-secondary)' }}
            <div class="admin-activity-item" style="animation-delay: {i * 50}ms">
              <span class="admin-activity-action" style="color: {meta.color}">{meta.label}</span>
              <span class="admin-activity-desc">
                <strong>{entry.performedBy}</strong>
                {#if entry.targetUser}
                  <span class="admin-activity-arrow">&rarr;</span>
                  <span>{entry.targetUser}</span>
                {/if}
                {#if entry.targetChannel}
                  <span class="admin-activity-channel">#{entry.targetChannel}</span>
                {/if}
              </span>
              <span class="admin-activity-time">{formatTime(entry.createdAt)}</span>
            </div>
          {:else}
            <div class="admin-empty-state">No recent activity</div>
          {/each}
        </div>
      </Card>
    </div>

    <!-- Third row: Role Distribution + Top Users -->
    <div class="admin-overview-row">
      <Card delay={620}>
        <span class="admin-section-label">Role Distribution</span>
        <div class="admin-role-dist">
          {#each sortedRoles as r}
            {@const pct = Math.round((r.count / Math.max(stats.overview.totalUsers, 1)) * 100)}
            <div class="admin-role-dist-item">
              <RoleBadge role={r.role} />
              <div class="admin-role-bar-track">
                <div class="admin-role-bar-fill" style="width: {pct}%; background: {roleBarColor(r.role)}" />
              </div>
              <span class="admin-role-bar-count">
                {r.count}<span class="admin-role-bar-pct"> {pct}%</span>
              </span>
            </div>
          {/each}
        </div>
      </Card>

      <Card delay={680}>
        <span class="admin-section-label">Top Contributors</span>
        <div class="admin-top-users">
          {#each stats.topUsers as u, i}
            <div class="admin-top-user-item">
              <span class="admin-top-rank">{i + 1}</span>
              <div class="admin-top-avatar">{(u.displayName || u.username).charAt(0).toUpperCase()}</div>
              <div class="admin-top-info">
                <div class="admin-top-name-row">
                  <span class="admin-top-name">{u.displayName || u.username}</span>
                  <StatusDot status={u.status} />
                  <RoleBadge role={u.role} />
                </div>
                <div class="admin-top-metrics">
                  <span class="admin-top-msgs">{u.messageCount.toLocaleString()} msgs</span>
                  <span class="admin-top-xp">{u.xp.toLocaleString()} XP</span>
                </div>
              </div>
            </div>
          {:else}
            <div class="admin-empty-state">No contributor data yet</div>
          {/each}
        </div>
      </Card>
    </div>
  {/if}
</div>
