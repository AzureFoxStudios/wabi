<script lang="ts">
  export let value: number
  export let max: number
  export let label: string
  export let color = 'var(--accent, var(--accent-primary-color))'
  export let size = 90

  $: radius = 36
  $: circumference = 2 * Math.PI * radius
  $: percentage = max > 0 ? Math.min(value / max, 1) : 0
  $: offset = circumference * (1 - percentage)
</script>

<div class="admin-ring-gauge" style="width: {size}px; height: {size}px">
  <svg viewBox="0 0 100 100" class="admin-ring-svg">
    <circle cx="50" cy="50" r={radius} class="admin-ring-bg" />
    <circle
      cx="50"
      cy="50"
      r={radius}
      class="admin-ring-fg"
      style="stroke: {color}; stroke-dasharray: {circumference}; stroke-dashoffset: {offset}"
    />
  </svg>
  <div class="admin-ring-value">{value}</div>
  <div class="admin-ring-label">{label}</div>
</div>
