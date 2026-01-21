<script lang="ts">
	import ColorPicker from './ColorPicker.svelte';

	export let label: string;
	export let value: string = 'linear-gradient(to right, #ff00ff 0%, #ff69b4 100%)';
	export let onChange: (gradient: string) => void = () => {};

	let showEditor = false;
	let startColor = '#ff00ff';
	let endColor = '#ff69b4';
	let angle = 90;
	let direction = 'right';

	// Parse gradient on mount
	$: {
		const match = value.match(/linear-gradient\((\d+)deg,\s*([^%]+)\s*0%,\s*([^%]+)\s*100%\)/);
		if (match) {
			angle = parseInt(match[1]);
			startColor = match[2].trim();
			endColor = match[3].trim();
		}
	}

	function updateGradient() {
		const newGradient = `linear-gradient(${angle}deg, ${startColor} 0%, ${endColor} 100%)`;
		value = newGradient;
		onChange(newGradient);
	}

	function handleAngleChange(e: Event) {
		angle = parseInt((e.target as HTMLInputElement).value);
		updateGradient();
	}

	function handleStartColorChange(color: string) {
		startColor = color;
		updateGradient();
	}

	function handleEndColorChange(color: string) {
		endColor = color;
		updateGradient();
	}

	function setPreset(preset: string) {
		const presets: Record<string, string> = {
			'to-right': `linear-gradient(90deg, ${startColor} 0%, ${endColor} 100%)`,
			'to-bottom': `linear-gradient(180deg, ${startColor} 0%, ${endColor} 100%)`,
			'diagonal': `linear-gradient(135deg, ${startColor} 0%, ${endColor} 100%)`
		};

		if (presets[preset]) {
			value = presets[preset];
			onChange(value);

			const match = value.match(/(\d+)deg/);
			if (match) {
				angle = parseInt(match[1]);
			}
		}
	}
</script>

<div class="gradient-editor-wrapper">
	<div class="editor-header">
		<label class="editor-label">{label}</label>
		<button class="toggle-btn" on:click={() => (showEditor = !showEditor)}>
			{showEditor ? '▼' : '▶'}
		</button>
	</div>

	<div class="gradient-preview" style="background: {value}" />

	{#if showEditor}
		<div class="editor-content">
			<div class="color-row">
				<ColorPicker
					label="Start Color"
					value={startColor}
					onChange={handleStartColorChange}
				/>
				<ColorPicker
					label="End Color"
					value={endColor}
					onChange={handleEndColorChange}
				/>
			</div>

			<div class="angle-control">
				<label for="angle-{label}">Angle: {angle}°</label>
				<input
					type="range"
					id="angle-{label}"
					min="0"
					max="360"
					step="5"
					value={angle}
					on:change={handleAngleChange}
					class="angle-slider"
				/>
			</div>

			<div class="preset-buttons">
				<button class="preset-btn" on:click={() => setPreset('to-right')}>→ Right</button>
				<button class="preset-btn" on:click={() => setPreset('to-bottom')}>↓ Bottom</button>
				<button class="preset-btn" on:click={() => setPreset('diagonal')}>↘ Diagonal</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.gradient-editor-wrapper {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		background: var(--ui-bg-lighter);
		border-radius: 6px;
		border: 1px solid rgba(var(--accent-rgb), 0.2);
	}

	.editor-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.editor-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.toggle-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.25rem 0.5rem;
		transition: color 0.2s;
	}

	.toggle-btn:hover {
		color: var(--text-primary);
	}

	.gradient-preview {
		height: 60px;
		border-radius: 4px;
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		transition: all 0.2s;
	}

	.editor-content {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 0.5rem;
		border-top: 1px solid rgba(var(--accent-rgb), 0.1);
	}

	.color-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}

	.angle-control {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.angle-control label {
		font-size: 0.8rem;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.angle-slider {
		width: 100%;
		height: 6px;
		border-radius: 3px;
		background: var(--bg-secondary);
		outline: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.angle-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent-hex);
		cursor: pointer;
		transition: all 0.2s;
		border: 2px solid var(--bg-secondary);
	}

	.angle-slider::-webkit-slider-thumb:hover {
		transform: scale(1.2);
	}

	.angle-slider::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent-hex);
		cursor: pointer;
		border: 2px solid var(--bg-secondary);
		transition: all 0.2s;
	}

	.angle-slider::-moz-range-thumb:hover {
		transform: scale(1.2);
	}

	.preset-buttons {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
	}

	.preset-btn {
		padding: 0.4rem 0.6rem;
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		border-radius: 4px;
		font-size: 0.75rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.preset-btn:hover {
		border-color: var(--accent-hex);
		background: var(--bg-hover);
	}

	.preset-btn:active {
		transform: scale(0.98);
	}
</style>
