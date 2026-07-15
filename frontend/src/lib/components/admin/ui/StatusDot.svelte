<script lang="ts">
  export let status: string
  export let size: 'sm' | 'md' = 'sm'

  const statusColors: Record<string, string> = {
    online: 'var(--accent-green, #4a9e5c)',
    idle: 'var(--accent-yellow, #F39C12)',
    dnd: 'var(--accent-red, #d71921)',
    offline: 'var(--text-disabled, #666)',
  }

  $: color = statusColors[status] ?? statusColors.offline
  $: sizeClass = size === 'sm' ? 'admin-dot-sm' : 'admin-dot-md'
  $: pulse = status === 'online'
</script>

<span class="admin-status-dot {sizeClass}" class:admin-dot-pulse={pulse} style="background: {color}" />
