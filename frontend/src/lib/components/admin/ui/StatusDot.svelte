<script lang="ts">
  export let status: string
  export let size: 'sm' | 'md' = 'sm'

  const statusColors: Record<string, string> = {
    online: 'var(--w-online)',
    idle: 'var(--w-warn)',
    dnd: 'var(--w-danger)',
    offline: 'var(--w-faint)',
  }

  $: color = statusColors[status] ?? statusColors.offline
  $: sizeClass = size === 'sm' ? 'admin-dot-sm' : 'admin-dot-md'
  $: pulse = status === 'online'
</script>

<span class="admin-status-dot {sizeClass}" class:admin-dot-pulse={pulse} style="background: {color}" />
