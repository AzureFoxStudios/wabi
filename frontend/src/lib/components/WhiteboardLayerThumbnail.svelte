<script lang="ts">
 import { onMount } from 'svelte';
 import { elements } from '$lib/whiteboard/boardStore';
 import { renderElements } from '$lib/whiteboard/boardRenderer';
 import { getSelectionBBox } from '$lib/whiteboard/coords';
 import { renderRasterLayer, hydrateRasterLayer } from '$lib/whiteboard/rasterLayers';
 import type { WhiteboardLayer } from '$lib/whiteboard/boardTypes';
 export let layer: WhiteboardLayer;
 let canvas: HTMLCanvasElement;
 let ready = false;
 function draw() {
  if (!ready || !canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 96, 72);
  const content = $elements.filter(element => element.layerId === layer.id);
  const bounds = layer.mode === 'raster' ? { x: 0, y: 0, width: 2048, height: 2048 } : getSelectionBBox(content);
  if (!bounds) return;
  const zoom = Math.min(84 / Math.max(bounds.width, 1), 60 / Math.max(bounds.height, 1), 2);
  const view = { x: bounds.x - (96 / zoom - bounds.width) / 2, y: bounds.y - (72 / zoom - bounds.height) / 2, zoom };
  if (layer.mode === 'raster') renderRasterLayer(ctx, layer.id, view);
  else renderElements(ctx, content, view, [{ ...layer, visible: true, opacity: 1 }]);
 }
 $: $elements, layer, ready, draw();
 $: if (ready && layer.mode === 'raster' && layer.assetUrl) void hydrateRasterLayer(layer.id, layer.assetUrl).then(draw).catch(() => {});
 onMount(() => {
  ready = true;
  // Repaint hydrated image/math assets and live paint without changing board state.
  const timer = setInterval(draw, 500);
  return () => { ready = false; clearInterval(timer); };
 });
</script>
<canvas bind:this={canvas} width="96" height="72" aria-hidden="true"></canvas>
<style>
 canvas { display: block; width: 48px; height: 36px; border: 1px solid var(--border-subtle); border-radius: 5px; background-color: #fff; background-image: linear-gradient(45deg,#e5e7eb 25%,transparent 25%),linear-gradient(-45deg,#e5e7eb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e7eb 75%),linear-gradient(-45deg,transparent 75%,#e5e7eb 75%); background-size: 8px 8px; background-position: 0 0,0 4px,4px -4px,-4px 0; }
</style>
