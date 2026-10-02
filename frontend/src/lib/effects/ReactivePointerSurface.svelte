<script lang="ts">
    import { onMount } from 'svelte';
    import { PointerWorldRenderer } from './pointerWorldRenderer';
    import type { PointerWorldOptions } from './pointerWorlds';
    import type { PointerTrail } from './pointerTrail';

    let { options, trail, onerror = () => {} }: {
        options: PointerWorldOptions;
        trail: PointerTrail;
        onerror?: (message: string) => void;
    } = $props();
    let host: HTMLDivElement;
    let renderer = $state.raw<PointerWorldRenderer | null>(null);

    export function draw(now: number): boolean { return renderer?.draw(trail, now) ?? false; }
    export function clear(): void { renderer?.clear(); }
    export function refreshColors(): void { renderer?.refreshColors(); }
    export function diagnostics() { return renderer?.diagnostics; }

    $effect(() => { renderer?.configure(options); });
    onMount(() => {
        try { renderer = new PointerWorldRenderer(host, options, (message) => onerror(message)); }
        catch (error) { onerror(error instanceof Error ? error.message : 'Pointer effect could not start'); }
        return () => { renderer?.destroy(); renderer = null; };
    });
</script>

<div class="reactive-pointer-surface" bind:this={host} aria-hidden="true"></div>

<style>
    .reactive-pointer-surface {
        position: fixed;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
        contain: strict;
    }
</style>
