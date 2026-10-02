<script lang="ts">
  /** QR code as crisp SVG (uqr, MIT, no runtime dependencies). */
  import { encode } from 'uqr';

  let { text, size = 132, label = '' }: { text: string; size?: number; label?: string } = $props();
  const qr = $derived(encode(text, { ecc: 'M', border: 2 }));
  const path = $derived.by(() => {
    let d = '';
    qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return d;
  });
</script>

<svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`} shape-rendering="crispEdges" role="img" aria-label={label || 'QR code'}>
  <rect width={qr.size} height={qr.size} fill="#fff" />
  <path d={path} fill="#000" />
</svg>
