<script lang="ts">
	import ProfileMedia from './ProfileMedia.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	let { user, class: className = '' }: {
		user: { overlayUrl?: string | null; overlayScale?: number; overlayOffsetX?: number; overlayOffsetY?: number };
		class?: string;
	} = $props();
	function bounded(value: number | undefined, min: number, max: number, fallback: number) {
		return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
	}
	const scale = $derived(bounded(user.overlayScale, 0.5, 3, 1));
	const x = $derived(bounded(user.overlayOffsetX, -200, 200, 0));
	const y = $derived(bounded(user.overlayOffsetY, -200, 200, 0));
</script>

<span class="profile-decoration {className}" aria-hidden="true">
	<ProfileMedia src={mediaUrl(user.overlayUrl)} decorative style={`display:block;width:100%;height:100%;object-fit:contain;transform:translate(${x}px,${y}px) scale(${scale});`} />
</span>

<style>
	.profile-decoration { display: block; overflow: hidden; pointer-events: none; }
</style>
