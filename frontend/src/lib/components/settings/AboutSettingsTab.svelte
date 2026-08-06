<script lang="ts">
	import { _ } from '$lib/i18n';
	import { brandConfig, brandName, selectBrandConfig } from '$lib/branding';
	import { isNeutralBrandingEnabled } from '$lib/components/loginHelpers';
	import { onMount } from 'svelte';

	const isDevBuild = import.meta.env.DEV;
	const MEMORY_TELEMETRY_KEY = 'wabi_debug_memory_telemetry';

	let memoryTelemetryEnabled = false;
	let memoryTelemetrySupported = false;
	let memoryTelemetryInterval: number | null = null;
	let memoryUsedMb = 0;
	let memoryTotalMb = 0;
	let memoryLimitMb = 0;
	let memoryUsedPct = 0;

	let activeBrand = brandConfig;
	let aboutTitle = brandName;
	let aboutBlurb = '';
	let aboutFooter = '';
	let aboutVersion = '1.0.0';

	function sampleMemoryTelemetry() {
		if (!isDevBuild || !memoryTelemetrySupported) return;
		const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
		if (!perf.memory) return;
		memoryUsedMb = perf.memory.usedJSHeapSize / (1024 * 1024);
		memoryTotalMb = perf.memory.totalJSHeapSize / (1024 * 1024);
		memoryLimitMb = perf.memory.jsHeapSizeLimit / (1024 * 1024);
		memoryUsedPct = (memoryUsedMb / memoryLimitMb) * 100;
	}

	function startMemoryTelemetry() {
		if (!isDevBuild || !memoryTelemetrySupported) return;
		sampleMemoryTelemetry();
		memoryTelemetryInterval = window.setInterval(sampleMemoryTelemetry, 2000);
	}

	function stopMemoryTelemetry() {
		if (memoryTelemetryInterval !== null) {
			clearInterval(memoryTelemetryInterval);
			memoryTelemetryInterval = null;
		}
	}

	function toggleMemoryTelemetry() {
		memoryTelemetryEnabled = !memoryTelemetryEnabled;
		localStorage.setItem(MEMORY_TELEMETRY_KEY, memoryTelemetryEnabled ? 'true' : 'false');
		if (memoryTelemetryEnabled) startMemoryTelemetry();
		else stopMemoryTelemetry();
	}

	onMount(() => {
		const brand = selectBrandConfig(isNeutralBrandingEnabled());
		activeBrand = brand;
		aboutTitle = brand.name || brand.shortName || brandName || 'Community';
		// Prefer branded copy when hosts set it; fall back to a short neutral line.
		aboutBlurb =
			(brand.description && brand.description.trim()) ||
			(brand.tagline && brand.tagline.trim()) ||
			(brand.subheadline && brand.subheadline.trim()) ||
			'Self-hosted community chat.';
		aboutFooter = (brand.footerText && brand.footerText.trim()) || '';
		try {
			const v = (document.querySelector('meta[name="wabi-version"]') as HTMLMetaElement | null)?.content;
			if (v) aboutVersion = v;
		} catch { /* ignore */ }

		memoryTelemetrySupported =
			typeof performance !== 'undefined' &&
			Boolean((performance as Performance & { memory?: unknown }).memory);
		if (isDevBuild) {
			memoryTelemetryEnabled = localStorage.getItem(MEMORY_TELEMETRY_KEY) === 'true';
			if (memoryTelemetryEnabled) startMemoryTelemetry();
		}
	});
</script>

<div class="settings-section">
	<h3>{$_('settings.sections.about')}</h3>
	<div class="about-card">
		{#if activeBrand.logoSmallUrl || activeBrand.logoUrl}
			<img class="about-logo" src={activeBrand.logoSmallUrl || activeBrand.logoUrl} alt="" />
		{/if}
		<div class="about-copy">
			<p class="about-title"><strong>{aboutTitle}</strong></p>
			<p class="about-blurb">{aboutBlurb}</p>
			{#if aboutFooter}
				<p class="about-footer">{aboutFooter}</p>
			{/if}
			<p class="version">v{aboutVersion}</p>
		</div>
	</div>
	{#if isDevBuild}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Debug memory telemetry</span>
				<span class="setting-description">DEV: sample JS heap every 2s.</span>
			</div>
			<button
				class="toggle-btn"
				class:active={memoryTelemetryEnabled}
				on:click={toggleMemoryTelemetry}
				disabled={!memoryTelemetrySupported}
				aria-label="Memory telemetry"
			></button>
		</div>
		{#if memoryTelemetryEnabled && memoryTelemetrySupported}
			<div class="runtime-note">
				Heap Used: <strong>{memoryUsedMb.toFixed(1)} MB</strong> /
				Total: <strong>{memoryTotalMb.toFixed(1)} MB</strong> /
				Limit: <strong>{memoryLimitMb.toFixed(0)} MB</strong>
				({memoryUsedPct.toFixed(1)}%)
			</div>
		{:else if !memoryTelemetrySupported}
			<div class="runtime-note">Telemetry unavailable on this runtime.</div>
		{/if}
	{/if}
</div>
