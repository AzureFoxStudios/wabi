<script lang="ts">
  let { text = '', always = false }: { text?: string; always?: boolean } = $props()
</script>

<span class="tag" class:always>{text}</span>

<style>
  .tag {
    position: absolute;
    top: 21px;
    right: 18px;
    font: 700 9px/1 'Space Mono', monospace;
    letter-spacing: 0.12em;
    color: #666;
    opacity: 0;
    transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .tag.always {
    opacity: 1;
    animation: tag-swap 0.32s cubic-bezier(0.4, 0, 0.2, 1);
  }
  @keyframes tag-swap {
    0% { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
