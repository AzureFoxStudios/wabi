<script lang="ts">
	/**
	 * Settings › About (§8.9, §9.4): what this app is and which server it talks to, as facts.
	 * Connection troubleshooting lives in Audio & video › Troubleshooting. The heap sampler is a
	 * developer instrument: it exists only in dev builds and never in the showcase.
	 */
	import { brandConfig, brandName, selectBrandConfig } from '$lib/branding';
	import { isNeutralBrandingEnabled } from '$lib/components/loginHelpers';
	import { onMount } from 'svelte';
	import { currentSavedServer } from '$lib/savedServers';
	import { activeServerUrl } from '$lib/serverUrl';
	import { parseServerBuildIdentity, type ServerBuildIdentity } from '$lib/buildIdentity';
	import { isShowcaseMode } from '$lib/showcase/mode';

	const isDevBuild = import.meta.env.DEV;
	/** Developer instruments stay out of member UI and out of the showcase (§9.4). */
	const showDevInstruments = isDevBuild && !isShowcaseMode();
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
	const clientBuild = __WABI_CLIENT_BUILD__;
	let serverBuild: ServerBuildIdentity | null = null;
	let serverBuildChecked = false;

	function sampleMemoryTelemetry() {
		if (!showDevInstruments || !memoryTelemetrySupported) return;
		const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
		if (!perf.memory) return;
		memoryUsedMb = perf.memory.usedJSHeapSize / (1024 * 1024);
		memoryTotalMb = perf.memory.totalJSHeapSize / (1024 * 1024);
		memoryLimitMb = perf.memory.jsHeapSizeLimit / (1024 * 1024);
		memoryUsedPct = (memoryUsedMb / memoryLimitMb) * 100;
	}

	function startMemoryTelemetry() {
		if (!showDevInstruments || !memoryTelemetrySupported) return;
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
		let request: AbortController | null = null;
		const unsubscribe = activeServerUrl.subscribe((url) => {
			request?.abort();
			serverBuild = null;
			serverBuildChecked = false;
			const current = new AbortController();
			request = current;
			void fetch(`${url.replace(/\/$/, '')}/api/public/build-info`, { signal: current.signal, credentials: 'omit' })
				.then((response) => (response.ok ? response.json() : null))
				.then((value) => {
					if (!current.signal.aborted) serverBuild = parseServerBuildIdentity(value);
				})
				.catch(() => {
					/* Older or unreachable servers have no build metadata. */
				})
				.finally(() => {
					if (!current.signal.aborted) serverBuildChecked = true;
				});
		});
		const brand = selectBrandConfig(isNeutralBrandingEnabled());
		activeBrand = brand;
		aboutTitle = brand.name || brand.shortName || brandName || 'Community';
		// Prefer branded copy when hosts set it; fall back to a short neutral line.
		aboutBlurb =
			(brand.description && brand.description.trim()) ||
			(brand.tagline && brand.tagline.trim()) ||
			(brand.subheadline && brand.subheadline.trim()) ||
			'Self-hosted communication and collaboration.';
		aboutFooter = (brand.footerText && brand.footerText.trim()) || '';

		memoryTelemetrySupported =
			typeof performance !== 'undefined' && Boolean((performance as Performance & { memory?: unknown }).memory);
		if (showDevInstruments) {
			memoryTelemetryEnabled = localStorage.getItem(MEMORY_TELEMETRY_KEY) === 'true';
			if (memoryTelemetryEnabled) startMemoryTelemetry();
		}
		return () => {
			unsubscribe();
			request?.abort();
			stopMemoryTelemetry();
		};
	});

	$: customLogo = activeBrand !== brandConfig ? activeBrand.logoSmallUrl || activeBrand.logoUrl || '' : '';
	$: serverName = $currentSavedServer?.effectiveName || aboutTitle;
	// The default brand's description is Wabi's own, already said above; a host's own words are not.
	$: serverBlurb = activeBrand !== brandConfig && aboutBlurb ? aboutBlurb : 'The server this app is signed in to, run by its own operators.';
	$: serverVersion = serverBuild
		? `${serverBuild.version}${serverBuild.sourceRevision ? ` · ${serverBuild.sourceRevision.slice(0, 12)}` : ''}`
		: serverBuildChecked
			? 'Not reported by this server'
			: 'Checking…';
</script>

<section class="settings-block about" aria-labelledby="about-app-title">
	<div class="about__mark">
		{#if customLogo}
			<img class="about__logo" src={customLogo} alt="" />
		{:else}
			<span class="about__enso" aria-hidden="true"></span>
		{/if}
		<div class="about__lede">
			<h3 class="settings-block__title about__name" id="about-app-title">Wabi</h3>
			<p class="settings-block__hint">Open-source, self-hosted communication and collaboration for small communities.</p>
		</div>
	</div>
	<dl class="about__facts">
		<dt>Version</dt>
		<dd>{clientBuild.version}</dd>
		<dt>Source</dt>
		{#if clientBuild.sourceRevision}
			<dd>{clientBuild.sourceRevision.slice(0, 12)}</dd>
		{:else}
			<dd class="about__missing">Not recorded in this build</dd>
		{/if}
	</dl>
	{#if aboutFooter}<p class="about__footer">{aboutFooter}</p>{/if}
</section>

<section class="settings-block about" aria-labelledby="about-server-title">
	<h3 class="settings-block__title" id="about-server-title">Connected server</h3>
	<p class="settings-block__hint">{serverBlurb}</p>
	<dl class="about__facts">
		<dt>Name</dt>
		<dd class="about__plain">{serverName}</dd>
		<dt>Address</dt>
		<dd>{$activeServerUrl}</dd>
		<dt>Server version</dt>
		<dd class:about__missing={!serverBuild}>{serverVersion}</dd>
	</dl>
</section>

{#if showDevInstruments}
	<section class="settings-block about" aria-labelledby="about-dev-title">
		<p class="w-kicker" id="about-dev-title">Developer build</p>
		<div class="w-srows">
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="about-heap-label">Sample memory use</p>
					<p class="w-srow__hint">
						{#if !memoryTelemetrySupported}
							This runtime doesn't report memory use.
						{:else if memoryTelemetryEnabled}
							{memoryUsedMb.toFixed(1)} MB used of {memoryTotalMb.toFixed(1)} MB · limit {memoryLimitMb.toFixed(0)} MB ({memoryUsedPct.toFixed(1)}%)
						{:else}
							Reads the JavaScript heap every 2 seconds. Dev builds only.
						{/if}
					</p>
				</div>
				<div class="w-srow__control">
					<button
						type="button"
						class="w-switch"
						role="switch"
						aria-labelledby="about-heap-label"
						aria-checked={memoryTelemetryEnabled}
						disabled={!memoryTelemetrySupported}
						on:click={toggleMemoryTelemetry}
					></button>
				</div>
			</div>
		</div>
	</section>
{/if}
