<script lang="ts">
  export let role: string
  export let size: 'sm' | 'md' = 'sm'

  const roleColors: Record<string, { bg: string; text: string; border: string }> = {
    owner: { bg: 'var(--color-danger-soft, rgba(244,67,54,0.15))', text: 'var(--text-danger, #ff8a80)', border: 'var(--color-danger-border, rgba(244,67,54,0.3))' },
    admin: { bg: 'var(--color-warning-soft, rgba(255,193,7,0.15))', text: 'var(--text-warning, #ffd54f)', border: 'var(--color-warning-border, rgba(255,193,7,0.3))' },
    mod: { bg: 'var(--color-info-soft, rgba(52,152,219,0.15))', text: 'var(--text-info, #64b5f6)', border: 'var(--color-info-border, rgba(52,152,219,0.3))' },
    moderator: { bg: 'var(--color-info-soft, rgba(52,152,219,0.15))', text: 'var(--text-info, #64b5f6)', border: 'var(--color-info-border, rgba(52,152,219,0.3))' },
    member: { bg: 'rgba(74,158,92,0.15)', text: '#4a9e5c', border: 'rgba(74,158,92,0.3)' },
    guest: { bg: 'rgba(102,102,102,0.15)', text: '#999', border: 'rgba(102,102,102,0.3)' },
  }

  $: colors = roleColors[role] ?? roleColors.guest
  $: sizeClass = size === 'sm' ? 'admin-role-badge-sm' : 'admin-role-badge-md'
</script>

<span class="admin-role-badge {sizeClass}" style="background: {colors.bg}; color: {colors.text}; border-color: {colors.border}">
  {role}
</span>
