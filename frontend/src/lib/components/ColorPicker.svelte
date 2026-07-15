<script lang="ts">
	export let label: string;
	export let value: string = '#ff00ff';
	export let onChange: (color: string) => void = () => {};

	let showPicker = false;
	let hexInput = value;

	$: hexInput = value;

	function handleColorChange(e: Event) {
		const target = e.target as HTMLInputElement;
		const color = target.value;
		value = color;
		onChange(color);
	}

	function handleHexInput(e: Event) {
		const target = e.target as HTMLInputElement;
		let hex = target.value;

		// Add # if missing
		if (!hex.startsWith('#')) {
			hex = '#' + hex;
		}

		// Validate hex color
		if (/^#[0-9A-F]{6}$/i.test(hex)) {
			value = hex;
			onChange(hex);
		}

		hexInput = hex;
	}

	function handleBlur() {
		// Reset invalid hex to current value
		if (!/^#[0-9A-F]{6}$/i.test(hexInput)) {
			hexInput = value;
		}
	}

	function togglePicker() {
		showPicker = !showPicker;
	}

	function handlePreviewKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			togglePicker();
		}
	}
</script>

<div class="color-picker-wrapper">
	<div class="picker-header">
		<label class="picker-label" for="color-{label}">{label}</label>
		<div class="picker-controls">
			<button
				type="button"
				class="color-preview"
				style="background-color: {value}"
				on:click={togglePicker}
				on:keydown={handlePreviewKeydown}
				aria-label="Toggle {label} color picker"
			></button>
			<input
				type="color"
				class="color-input hidden"
				{value}
				on:change={handleColorChange}
				id="color-{label}"
			/>
			<label for="color-{label}" class="color-button">Pick</label>
		</div>
	</div>

	{#if showPicker}
		<div class="picker-content">
			<input
				type="color"
				class="native-color-picker"
				{value}
				on:change={handleColorChange}
			/>
			<div class="hex-input-group">
				<label for="hex-{label}">Hex:</label>
				<input
					type="text"
					id="hex-{label}"
					class="hex-input"
					bind:value={hexInput}
					on:input={handleHexInput}
					on:blur={handleBlur}
					placeholder="#000000"
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.color-picker-wrapper {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		background: var(--ui-bg-lighter);
		border-radius: 6px;
		border: 1px solid rgba(var(--accent-rgb), 0.2);
	}

	.picker-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.picker-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.picker-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.color-preview {
		width: 36px;
		height: 36px;
		border-radius: 4px;
		border: 2px solid rgba(var(--accent-rgb), 0.3);
		cursor: pointer;
		transition: transform 0.2s;
	}

	.color-preview:hover {
		transform: scale(1.05);
		border-color: var(--accent-primary-color);
	}

	.color-button {
		padding: 0.4rem 0.8rem;
		background: var(--surface-base);
		color: var(--text-heading);
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		border-radius: 4px;
		font-size: 0.75rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.color-button:hover {
		border-color: var(--accent-primary-color);
		background: var(--surface-hover);
	}

	.picker-content {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 0.5rem;
		border-top: 1px solid rgba(var(--accent-rgb), 0.1);
	}

	.native-color-picker {
		width: 100%;
		height: 100px;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.hex-input-group {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.hex-input-group label {
		font-size: 0.8rem;
		color: var(--text-secondary);
		min-width: 35px;
	}

	.hex-input {
		flex: 1;
		padding: 0.4rem;
		background: var(--surface-base);
		color: var(--text-heading);
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		border-radius: 4px;
		font-size: 0.8rem;
		font-family: monospace;
		transition: all 0.2s;
	}

	.hex-input:focus {
		outline: none;
		border-color: var(--accent-primary-color);
		box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.1);
	}
</style>
