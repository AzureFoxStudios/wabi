<script lang="ts">
	import { _ } from '$lib/i18n';

	const isDevBuild = import.meta.env.DEV;
	const MEMORY_TELEMETRY_KEY = 'wabi_debug_memory_telemetry';

	let memoryTelemetryEnabled = false;
	let memoryTelemetrySupported = false;
	let memoryTelemetryInterval: number | null = null;
	let memoryUsedMb = 0;
	let memoryTotalMb = 0;
	let memoryLimitMb = 0;
	let memoryUsedPct = 0;

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
		if (memoryTelemetryEnabled) {
			startMemoryTelemetry();
		} else {
			stopMemoryTelemetry();
		}
	}

	// Init
	memoryTelemetrySupported = typeof performance !== 'undefined' && Boolean((performance as Performance & { memory?: unknown }).memory);
	if (isDevBuild) {
		memoryTelemetryEnabled = localStorage.getItem(MEMORY_TELEMETRY_KEY) === 'true';
		if (memoryTelemetryEnabled) {
			startMemoryTelemetry();
		}
	}
</script>

<div class="settings-section">
	<h3>{$_('settings.sections.about')}</h3>
	<div class="about-info">
		<p><strong>Wabi Chat</strong></p>
		<p>Privacy-first ephemeral chat. No tracking. No data collection.</p>
		<p>Server stores nothing permanently. You control your data.</p>
		<p class="version">Version 1.0.0</p>
	</div>
	{#if isDevBuild}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Debug Memory Telemetry</span>
				<span class="setting-description">DEV only: samples browser JS heap every 2s.</span>
			</div>
			<button class="toggle-btn" class:active={memoryTelemetryEnabled} on:click={toggleMemoryTelemetry} disabled={!memoryTelemetrySupported}>
				{memoryTelemetryEnabled ? 'ON' : 'OFF'}
			</button>
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
