<script lang="ts">
	/** Attaches a MediaStream to a <video> element (srcObject needs a
	 *  property assignment — Svelte attributes don't cover it). */
	let { stream, muted = true, mirror = false }: { stream: MediaStream; muted?: boolean; mirror?: boolean } = $props();

	let el: HTMLVideoElement | undefined = $state();

	$effect(() => {
		if (!el) return;
		el.srcObject = stream;
		el.muted = muted;
		void el.play().catch(() => undefined);
	});
</script>

<video bind:this={el} playsinline autoplay class:mirror></video>
