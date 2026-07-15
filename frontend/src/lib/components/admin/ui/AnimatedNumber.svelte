<script lang="ts">
  import { tweened } from 'svelte/motion'
  import { cubicOut } from 'svelte/easing'

  export let value: number
  export let duration = 800

  const animated = tweened(0, { duration, easing: cubicOut })

  $: animated.set(value)
</script>

<span class="admin-animated-number">{$animated.toLocaleString()}</span>
