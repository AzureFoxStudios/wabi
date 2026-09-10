<script lang="ts">
	import { onMount } from 'svelte';
	import {
		applyFeelerSettings,
		DEFAULT_FEELER_SETTINGS,
		readFeelerSettings,
		type FeelerPattern
	} from './mouseFeelerConfig';
	import {
		downloadPointerShaderTemplate,
		importLocalImageEffect,
		importLocalShaderEffect,
		listLocalVisualEffects,
		LOCAL_VISUAL_EFFECTS_EVENT,
		removeLocalVisualEffect,
		type LocalVisualEffectRecord
	} from './localVisualEffects';

	let enabled = DEFAULT_FEELER_SETTINGS.enabled;
	let pattern: FeelerPattern = DEFAULT_FEELER_SETTINGS.pattern;
	let customEffectId: string | null = null;
	let radius = DEFAULT_FEELER_SETTINGS.radius;
	let intensity = DEFAULT_FEELER_SETTINGS.intensity;
	let textureOpacity = DEFAULT_FEELER_SETTINGS.textureOpacity;
	let selection = DEFAULT_FEELER_SETTINGS.pattern as string;
	let localEffects: LocalVisualEffectRecord[] = [];
	let importBusy = false;
	let importMessage = '';
	let imageInput: HTMLInputElement;
	let shaderInput: HTMLInputElement;

	function syncFromStoredSettings(): void {
		const saved = readFeelerSettings();
		enabled = saved.enabled;
		pattern = saved.pattern;
		customEffectId = saved.customEffectId;
		radius = saved.radius;
		intensity = saved.intensity;
		textureOpacity = saved.textureOpacity;
		selection = pattern === 'local' && customEffectId ? `local:${customEffectId}` : pattern;
	}

	async function refreshLibrary(): Promise<void> {
		try {
			localEffects = await listLocalVisualEffects();
		} catch (error) {
			console.warn('[MouseFeelerSettings] Failed to load local effects:', error);
			localEffects = [];
		}
	}

	onMount(() => {
		syncFromStoredSettings();
		void refreshLibrary();
		const handleLibraryChanged = () => void refreshLibrary();
		window.addEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
		return () => window.removeEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
	});

	function apply(): void {
		applyFeelerSettings({ enabled, pattern, customEffectId, radius, intensity, textureOpacity });
		selection = pattern === 'local' && customEffectId ? `local:${customEffectId}` : pattern;
	}

	function toggleEnabled(): void {
		enabled = !enabled;
		apply();
	}

	function handlePatternChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value;
		selection = value;
		if (value.startsWith('local:')) {
			pattern = 'local';
			customEffectId = value.slice('local:'.length) || null;
		} else {
			pattern = value as FeelerPattern;
			customEffectId = null;
		}
		apply();
	}

	async function importImage(file: File | undefined): Promise<void> {
		if (!file) return;
		importBusy = true;
		importMessage = '';
		try {
			const effect = await importLocalImageEffect(file);
			await refreshLibrary();
			pattern = 'local';
			customEffectId = effect.id;
			apply();
			importMessage = `Imported ${effect.name}`;
		} catch (error) {
			importMessage = error instanceof Error ? error.message : 'Image import failed';
		} finally {
			importBusy = false;
			if (imageInput) imageInput.value = '';
		}
	}

	async function importShader(file: File | undefined): Promise<void> {
		if (!file) return;
		importBusy = true;
		importMessage = '';
		try {
			const effect = await importLocalShaderEffect(file);
			await refreshLibrary();
			pattern = 'local';
			customEffectId = effect.id;
			apply();
			importMessage = `Imported shader ${effect.name}`;
		} catch (error) {
			importMessage = error instanceof Error ? error.message : 'Shader import failed';
		} finally {
			importBusy = false;
			if (shaderInput) shaderInput.value = '';
		}
	}

	async function removeEffect(effect: LocalVisualEffectRecord): Promise<void> {
		try {
			await removeLocalVisualEffect(effect.id);
			if (customEffectId === effect.id) {
				pattern = 'triangles';
				customEffectId = null;
				apply();
			}
			await refreshLibrary();
			importMessage = `Removed ${effect.name}`;
		} catch (error) {
			importMessage = error instanceof Error ? error.message : 'Could not remove effect';
		}
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
			<span class="setting-description">Built-ins or anything you import from your own computer.</span>
		</div>
		<select class="theme-select" value={selection} on:change={handlePatternChange} disabled={!enabled}>
			<option value="triangles">Triangles</option>
			<option value="dots">Dots</option>
			<option value="grid">Grid</option>
			<option value="sparkles">Sparkles</option>
			<option value="suits">Suits</option>
			<option value="none">No texture</option>
			{#if localEffects.length}
				<optgroup label="Your local effects">
					{#each localEffects as effect (effect.id)}
						<option value={`local:${effect.id}`}>{effect.name} ({effect.kind})</option>
					{/each}
				</optgroup>
			{/if}
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
			<span class="setting-label">Effect strength</span>
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

	<div class="local-effects-card">
		<div class="local-effects-copy">
			<span class="setting-label">Your effects</span>
			<span class="setting-description">Local only. Images run as textures; shaders get pointer/time/resolution/theme uniforms and no Wabi data access.</span>
		</div>
		<div class="local-effects-actions">
			<button type="button" class="action-btn" disabled={importBusy} on:click={() => imageInput?.click()}>Import image</button>
			<button type="button" class="action-btn" disabled={importBusy} on:click={() => shaderInput?.click()}>Import shader</button>
			<button type="button" class="action-btn" on:click={downloadPointerShaderTemplate}>Shader template</button>
		</div>
		<input
			bind:this={imageInput}
			class="file-input"
			type="file"
			accept=".png,.webp,.jpg,.jpeg,.gif,.svg,image/png,image/webp,image/jpeg,image/gif,image/svg+xml"
			on:change={(event) => void importImage((event.currentTarget as HTMLInputElement).files?.[0])}
		/>
		<input
			bind:this={shaderInput}
			class="file-input"
			type="file"
			accept=".frag,.glsl,text/plain"
			on:change={(event) => void importShader((event.currentTarget as HTMLInputElement).files?.[0])}
		/>
		{#if importMessage}
			<div class="import-message" role="status">{importMessage}</div>
		{/if}

		{#if localEffects.length}
			<div class="local-effect-list">
				{#each localEffects as effect (effect.id)}
					<div class="local-effect-row">
						<div>
							<strong>{effect.name}</strong>
							<span>{effect.kind === 'image' ? 'Image texture' : 'Pointer shader'}</span>
						</div>
						<div class="local-effect-row-actions">
							<button type="button" class="action-btn" on:click={() => {
								pattern = 'local';
								customEffectId = effect.id;
								apply();
							}}>Use</button>
							<button type="button" class="action-btn danger" on:click={() => void removeEffect(effect)}>Remove</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.feeler-settings {
		margin-top: 1rem;
	}
	.local-effects-card {
		margin-top: 0.75rem;
		padding: 0.9rem;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
		border-radius: var(--radius-md, 8px);
		background: color-mix(in srgb, var(--surface-raised, #24243e) 72%, transparent);
	}
	.local-effects-copy {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.local-effects-actions,
	.local-effect-row-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.75rem;
	}
	.file-input {
		display: none;
	}
	.import-message {
		margin-top: 0.6rem;
		font-size: 0.8rem;
		color: var(--text-secondary, #a0a0a0);
	}
	.local-effect-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin-top: 0.8rem;
	}
	.local-effect-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding-top: 0.55rem;
		border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
	}
	.local-effect-row > div:first-child {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.local-effect-row strong {
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.local-effect-row span {
		font-size: 0.72rem;
		color: var(--text-secondary, #a0a0a0);
	}
	.local-effect-row-actions {
		margin-top: 0;
		flex-shrink: 0;
	}
	.action-btn.danger {
		color: var(--danger, #ef6a6a);
	}
</style>
