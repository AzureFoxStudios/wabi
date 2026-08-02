<script lang="ts">
  let { value = 0, max = 100, label = '', color = '#f26522', size = 110 }: {
    value?: number; max?: number; label?: string; color?: string; size?: number
  } = $props()

  let pct = $derived(Math.min(value / max, 1))
  let circumference = $derived(2 * Math.PI * 46)
  let offset = $derived(circumference * (1 - pct))
</script>

<div class="ring-wrap" style:width="{size}px" style:height="{size}px">
  <svg viewBox="0 0 110 110">
    <circle class="ring-bg" cx="55" cy="55" r="46" />
    <circle class="ring-fg" cx="55" cy="55" r="46"
      stroke={color}
      stroke-dasharray={circumference}
      stroke-dashoffset={offset} />
  </svg>
  <div class="ring-val">
    {value}
    <small>{label}</small>
  </div>
</div>

<style>
  .ring-wrap {
    position: relative;
    margin: 2px auto;
  }
  .ring-wrap svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .ring-bg {
    fill: none;
    stroke: #272727;
    stroke-width: 6.5px;
  }
  .ring-fg {
    fill: none;
    stroke-width: 6.5px;
    transition: stroke-dashoffset 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .ring-val {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    font: 600 30px/1 'Space Grotesk', sans-serif;
    color: #fff;
    letter-spacing: -0.01em;
  }
  .ring-val small {
    color: #999;
    margin-left: 5px;
    font: 400 11px/1 'Space Mono', monospace;
    transform: translateY(9px);
  }
</style>
