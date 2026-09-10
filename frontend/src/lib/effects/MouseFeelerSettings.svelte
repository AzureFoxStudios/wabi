<script lang="ts">
	import { onMount } from 'svelte';

	type FeelerPattern = 'triangles' | 'dots' | 'grid' | 'sparkles' | 'none';
	type FeelerSettings = {
		enabled: boolean;
		pattern: FeelerPattern;
		radius: number;
		intensity: number;
		textureOpacity: number;
		idleDelayMs: number;
		fadeMs: number;
	};

	const STORAGE_KEY = 'wabi.mouse-feeler.v1';
	const SETTINGS_EVENT = 'wabi:mouse-feeler-settings';
	const DEFAULTS: FeelerSettings = {
		enabled: true,
		pattern: 'triangles',
		radius: 190,
		intensity: 0.05,
		textureOpacity: 0.16,
		idleDelayMs: 90,
		fadeMs: 520
	};

	let enabled = DEFAULTS.enabled;
	let pattern: FeelerPattern = DEFAULTS.pattern;
	let radius = DEFAULTS.radius;
	let intensity = DEFAULTS.intensity;
	let textureOpacity = DEFAULTS.textureOpacity;

	function isPattern(value: unknown): value is FeelerPattern {
		return value === 'triangles' || value === 'dots' || value === 'grid' || value === 'sparkles' || value === 'none';
	}

	onMount(() => {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const saved = JSON.parse(raw) as Partial<FeelerSettings>;
			enabled = saved.enabled !== false;
			if (isPattern(saved.pattern)) pattern = saved.pattern;
			if (typeof saved.radius === 'number') radius = Math.min(360, Math.max(80, saved.radius));
			if (typeof saved.intensity === 'number') intensity = Math.min(0.15, Math.max(0, saved.intensity));
			if (typeof saved.textureOpacity === 'number') textureOpacity = Math.min(0.4, Math.max(0, saved.textureOpacity));
		} catch {
			// Keep defaults if the cosmetic settings entry is corrupt.
		}
	});

	function apply(): void {
		window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, {
			detail: { enabled, pattern, radius, intensity, textureOpacity }
		}));
	}

	function toggleEnabled(): void {
		enabled = !enabled;
		apply();
	}
</script>

<div class="settings-subsection feeler-settings">
	<h4 class="subsection-label">Pointer Feeler</h4>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Mouse feeler</span>
			<span class="setting-description">Softly reveal light and texture around a moving pointer.</span>
		</div>
		<button
			type="button"
			class="toggle-btn"
			class:active={enabled}
			on:click={toggleEnabled}
			role="switch"
			aria-checked={enabled}
		>
			{enabled ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Pattern</span>
			<span class="setting-description">Texture revealed inside the feeler. Image textures can be added later.</span>
		</div>
		<select class="theme-select" bind:value={pattern} on:change={apply} disabled={!enabled}>
			<option value="triangles">Triangles</option>
			<option value="dots">Dots</option>
			<option value="grid">Grid</option>
			<option value="sparkles">Sparkles</option>
			<option value="none">No texture</option>
		</select>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Glow strength</span>
			<span class="setting-description">{Math.round(intensity * 100)}%</span>
		</div>
		<input
			type="range"
			min="0"
			max="0.15"
			step="0.01"
			bind:value={intensity}
			on:input={apply}
			class="volume-slider"
			disabled={!enabled}
		/>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Texture strength</span>
			<span class="setting-description">{Math.round(textureOpacity * 100)}%</span>
		</div>
		<input
			type="range"
			min="0"
			max="0.4"
			step="0.02"
			bind:value={textureOpacity}
			on:input={apply}
			class="volume-slider"
			disabled={!enabled || pattern === 'none'}
		/>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Radius</span>
			<span class="setting-description">{Math.round(radius)} px</span>
		</div>
		<input
			type="range"
			min="80"
			max="360"
			step="10"
			bind:value={radius}
			on:input={apply}
			class="volume-slider"
			disabled={!enabled}
		/>
	</div>
</div>

<style>
	.feeler-settings {
		margin-top: 1rem;
	}
</style>
