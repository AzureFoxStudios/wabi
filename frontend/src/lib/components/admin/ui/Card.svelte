<script lang="ts">
  export let delay = 0
  export let hover = true
  export let accent = false
  export let className = ''
</script>

<div
  class="admin-card {className}"
  class:admin-card-hover={hover}
  class:admin-card-accent={accent}
  style="animation-delay: {delay}ms"
>
  <slot />
</div>
