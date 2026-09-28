<script lang="ts">
	import { safeNameStyle } from '$lib/addons/nameStyles';
	import { profileNamesVisible, profilePlatesVisible, profileMotionAllowed } from '$lib/profileAppearance';
	import { normalizeNameDesign, nameDesignPlateStyle, isDesignColor, type EditableUsernameFont } from '$lib/profileDesign';
	let { username, font = null, color = '', preview = false }: {
		username: string; font?: EditableUsernameFont | null; color?: string; preview?: boolean;
	} = $props();
	const design = $derived(normalizeNameDesign(font?.design));
	const showName = $derived(preview || $profileNamesVisible);
	const showPlate = $derived((preview || $profilePlatesVisible) && design?.plate !== 'none');
	const textStyle = $derived((isDesignColor(color) ? `color:${color};` : '') + safeNameStyle(font, showName));
</script>

<span class="profile-nameplate" class:decorated={showPlate && !!design} style={showPlate ? nameDesignPlateStyle(design) : ''}>
	<span class="profile-name-text" class:shimmer={showName && design?.effect === 'shimmer' && $profileMotionAllowed} style={textStyle}>{username}</span>
</span>

<style>
	.profile-nameplate { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; vertical-align: middle; }
	.profile-nameplate.decorated { padding: 0.1em 0.45em; border-radius: var(--radius-sm); }
	.profile-name-text { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.shimmer { background-size: 200% 100%; animation: shimmer var(--profile-shimmer-seconds, 8s) linear infinite; }
	@keyframes shimmer { from { background-position: 0% 50%; } to { background-position: 200% 50%; } }
	@media (prefers-reduced-motion: reduce) { .shimmer { animation: none; } }
	:global(html[data-reduce-motion='true']) .shimmer { animation: none; }
	@media (forced-colors: active) { .profile-name-text { background: none !important; color: CanvasText !important; filter: none !important; } .profile-nameplate.decorated { border: 1px solid CanvasText !important; background: none !important; } }
</style>
