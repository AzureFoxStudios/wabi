<script lang="ts">
  let { color = 'orange', size = 10 }: { color?: string; size?: number } = $props()
</script>

<span class="led" style:width="{size}px" style:height="{size}px" class:red={color === 'red'} class:green={color === 'green'}></span>

<style>
  .led {
    display: inline-block;
    border-radius: 50%;
    background: #f26522;
    flex: none;
    animation: pulse 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  .led.red {
    background: #d71921;
    animation-duration: 1.6s;
  }
  .led.green {
    background: #4a9e5c;
    animation-duration: 2.4s;
  }
  @keyframes pulse {
    0%, to { opacity: 1; }
    50% { opacity: 0.18; }
  }
</style>
