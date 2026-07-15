<script lang="ts">
  let { segments = 8, active = 3, color = 'orange' }: { segments?: number; active?: number; color?: string } = $props()
</script>

<div class="segbar {color}">
  {#each Array(segments) as _, i}
    <i class:on={i < active} style="animation-delay: {i * 0.04}s"></i>
  {/each}
</div>

<style>
  .segbar {
    display: flex;
    gap: 3px;
    height: 12px;
    margin-top: auto;
  }
  .segbar i {
    flex: 1;
    background: #242424;
    border-radius: 2px;
    transform: scale(0.3);
    opacity: 0;
    animation: seg-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }
  .segbar i.on { background: #e8e8e8; }
  .segbar.green i.on { background: #4a9e5c; }
  .segbar.orange i.on { background: #f26522; }
  @keyframes seg-in {
    to { opacity: 1; transform: scale(1); }
  }
</style>
