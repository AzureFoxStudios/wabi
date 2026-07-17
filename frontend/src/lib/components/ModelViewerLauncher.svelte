<script lang="ts">
	import { onMount, type ComponentType } from 'svelte';
	import { isDesktopTauri } from '$lib/tauri-platform';
	import { openNativeModelViewer } from '$lib/tauri-model-viewer';
	import { hasAddonCapability } from '$lib/addonInventory';
	import { loadAddon } from '$lib/addons/loader';

	export let src: string;
	export let fileName = '3D model';
	export let height = 320;
	export let fullBleed = false;
	export let lazyLoad = true;
	export let hideUi = false;

	// Compile-time constant: true for the desktop Tauri build, false for web.
	const isTauriBuild = __WABI_IS_TAURI__;
	const desktop = isDesktopTauri();

	let ThreeViewer: ComponentType | null = null;
	let resolvingThree = true;
	let launching = false;
	let nativeError: string | null = null;

	async function resolveThreeViewer() {
		if (isTauriBuild) {
			// Desktop: three.js is NOT bundled. Only load it if a server-provided
			// `model-viewer` addon is available; otherwise the native wgpu viewer
			// (opened via the button below) is the only renderer.
			try {
				if (await hasAddonCapability('model-viewer')) {
					const instance = await loadAddon('model-viewer');
					const mod = instance?.frontendModule;
					if (mod?.default) ThreeViewer = mod.default as ComponentType;
				}
			} catch (e) {
				console.warn('[ModelViewerLauncher] model-viewer addon unavailable:', e);
			}
		} else {
			// Web: three.js is the primary in-page viewer. This dynamic import is
			// excluded from the Tauri build via the __WABI_IS_TAURI__ dead branch.
			const mod = await import('$lib/components/plugins/ModelViewer3D.svelte');
			ThreeViewer = mod.default as ComponentType;
		}
		resolvingThree = false;
	}

	onMount(resolveThreeViewer);

	async function launchNative() {
		launching = true;
		nativeError = null;
		const ok = await openNativeModelViewer(src, fileName);
		if (!ok) nativeError = 'Could not open the native 3D viewer.';
		launching = false;
	}

	function onLaunch(e: Event) {
		e.preventDefault();
		void launchNative();
	}
</script>

{#if desktop}
	<div class="native-launch-row">
		<button class="native-launch-btn" type="button" on:click={onLaunch} disabled={launching}>
			{launching ? 'Opening…' : 'Open in native 3D viewer'}
		</button>
		{#if nativeError}
			<span class="native-error">{nativeError}</span>
		{/if}
	</div>
{/if}

{#if !resolvingThree && ThreeViewer}
	<svelte:component
		this={ThreeViewer}
		{src}
		{fileName}
		{height}
		{fullBleed}
		{lazyLoad}
		bind:hideUi
	/>
{:else if desktop && !resolvingThree && !ThreeViewer}
	<p class="native-only-hint">Use the native 3D viewer to inspect this model.</p>
{/if}

<style>
	.native-launch-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.25rem 0;
	}
	.native-launch-btn {
		background: var(--accent-color, #4f8cff);
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 0.4rem 0.75rem;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.native-launch-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.native-error {
		font-size: 0.8rem;
		color: var(--danger-color, #e5484d);
	}
	.native-only-hint {
		font-size: 0.8rem;
		opacity: 0.7;
		margin: 0.25rem 0;
	}
</style>
