<script lang="ts">
	import { _ } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import {
		getStoredAccessibilitySettings,
		updateAccessibilitySettings,
		type RoleColorMode
	} from '$lib/accessibility';
	import {
		animationPassStore,
		updateAnimationPassSettings,
		type AnimationPassPreset,
		type AnimationPassLevel
	} from '$lib/animationPass';

	const stored = getStoredAccessibilitySettings();
	let interfaceScale = stored.interfaceScale;
	let colorAssistEnabled = stored.colorAssistEnabled;
	let saturation = stored.saturation;
	let contrast = stored.contrast;
	let reducedMotion = stored.reducedMotion;
	let animationPassEnabled = $animationPassStore.enabled;
	let animationPassPreset: AnimationPassPreset = $animationPassStore.preset;
	let animationPassLevel: AnimationPassLevel = $animationPassStore.level;
	let animationPassDurationMultiplier = $animationPassStore.durationMultiplier;
	let roleColorMode: RoleColorMode = stored.roleColorMode;

	function updateInterfaceScale(value: number) {
		const next = updateAccessibilitySettings({ interfaceScale: value });
		interfaceScale = next.interfaceScale;
	}

	function toggleColorAssistEnabled() {
		const next = updateAccessibilitySettings({ colorAssistEnabled: !colorAssistEnabled });
		colorAssistEnabled = next.colorAssistEnabled;
	}

	function updateSaturation(value: number) {
		const next = updateAccessibilitySettings({ saturation: value });
		saturation = next.saturation;
	}

	function updateContrast(value: number) {
		const next = updateAccessibilitySettings({ contrast: value });
		contrast = next.contrast;
	}

	function toggleReducedMotion() {
		const next = updateAccessibilitySettings({ reducedMotion: !reducedMotion });
		reducedMotion = next.reducedMotion;
	}

	function toggleAnimationPass() {
		const next = updateAnimationPassSettings({ enabled: !animationPassEnabled });
		animationPassEnabled = next.enabled;
	}

	function updateAnimationPreset(value: AnimationPassPreset) {
		const next = updateAnimationPassSettings({ preset: value });
		animationPassPreset = next.preset;
	}

	function updateAnimationLevel(value: AnimationPassLevel) {
		const next = updateAnimationPassSettings({ level: value });
		animationPassLevel = next.level;
	}

	function updateAnimationDurationMultiplier(value: number) {
		const next = updateAnimationPassSettings({ durationMultiplier: value });
		animationPassDurationMultiplier = next.durationMultiplier;
	}

	function updateRoleColorMode(mode: RoleColorMode) {
		const next = updateAccessibilitySettings({ roleColorMode: mode });
		roleColorMode = next.roleColorMode;
	}

	function resetAccessibilityVisuals() {
		const next = updateAccessibilitySettings({
			colorAssistEnabled: false,
			saturation: 1,
			contrast: 1,
			reducedMotion: false,
			roleColorMode: 'full'
		});
		colorAssistEnabled = next.colorAssistEnabled;
		saturation = next.saturation;
		contrast = next.contrast;
		reducedMotion = next.reducedMotion;
		roleColorMode = next.roleColorMode;

		const animationReset = updateAnimationPassSettings({
			enabled: true,
			preset: 'slip',
			level: 'balanced',
			durationMultiplier: 1
		});
		animationPassEnabled = animationReset.enabled;
		animationPassPreset = animationReset.preset;
		animationPassLevel = animationReset.level;
		animationPassDurationMultiplier = animationReset.durationMultiplier;
	}
</script>

<div class="settings-section">
	<h3>Accessibility</h3>
	<div class="settings-group-card">
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Interface scale</span>
				<span class="setting-description">{Math.round(interfaceScale * 100)}%</span>
			</div>
			<input type="range" min="0.85" max="1.5" step="0.05" bind:value={interfaceScale} on:input={(e) => updateInterfaceScale(parseFloat(e.currentTarget.value))} class="volume-slider" />
			<div class="font-scale-presets">
				<button type="button" class="sound-option" class:active={Math.abs(interfaceScale - 0.9) < 0.01} on:click={() => updateInterfaceScale(0.9)}>S</button>
				<button type="button" class="sound-option" class:active={Math.abs(interfaceScale - 1) < 0.01} on:click={() => updateInterfaceScale(1)}>M</button>
				<button type="button" class="sound-option" class:active={Math.abs(interfaceScale - 1.2) < 0.01} on:click={() => updateInterfaceScale(1.2)}>L</button>
				<button type="button" class="sound-option" class:active={Math.abs(interfaceScale - 1.5) < 0.01} on:click={() => updateInterfaceScale(1.5)}>XL</button>
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Color assist</span>
				<span class="setting-description">Saturation / contrast filters.</span>
			</div>
			<button class="toggle-btn" class:active={colorAssistEnabled} on:click={toggleColorAssistEnabled} aria-label="Color assist"></button>
		</div>
		<div class="setting-nested" class:is-disabled={!colorAssistEnabled}>
			<div class="setting-item-full" style="padding:0;border:0;background:transparent;box-shadow:none">
				<div class="setting-info"><span class="setting-label">Saturation</span><span class="setting-description">{Math.round(saturation * 100)}%</span></div>
				<input type="range" min="0.6" max="1.8" step="0.05" bind:value={saturation} on:input={(e) => updateSaturation(parseFloat(e.currentTarget.value))} class="volume-slider" disabled={!colorAssistEnabled} />
			</div>
			<div class="setting-item-full" style="padding:0;border:0;background:transparent;box-shadow:none">
				<div class="setting-info"><span class="setting-label">Contrast</span><span class="setting-description">{Math.round(contrast * 100)}%</span></div>
				<input type="range" min="0.8" max="1.4" step="0.05" bind:value={contrast} on:input={(e) => updateContrast(parseFloat(e.currentTarget.value))} class="volume-slider" disabled={!colorAssistEnabled} />
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Reduce motion</span>
				<span class="setting-description">Minimize animations.</span>
			</div>
			<button class="toggle-btn" class:active={reducedMotion} on:click={toggleReducedMotion} aria-label="Reduce motion"></button>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Motion polish</span>
				<span class="setting-description">Channel / message / popout motion.</span>
			</div>
			<button class="toggle-btn" class:active={animationPassEnabled} on:click={toggleAnimationPass} aria-label="Motion polish"></button>
		</div>
		<div class="setting-nested" class:is-disabled={!animationPassEnabled || reducedMotion}>
			<div class="setting-item" style="padding:0;border:0;background:transparent;box-shadow:none;min-height:0">
				<div class="setting-info"><span class="setting-label">Preset</span></div>
				<select class="theme-select" value={animationPassPreset} on:change={(e) => updateAnimationPreset(e.currentTarget.value as AnimationPassPreset)} disabled={!animationPassEnabled || reducedMotion}>
					<option value="slip">Slip</option>
					<option value="fade">Fade</option>
					<option value="scale">Scale</option>
					<option value="flip">Flip</option>
				</select>
			</div>
			<div class="setting-item" style="padding:0;border:0;background:transparent;box-shadow:none;min-height:0">
				<div class="setting-info"><span class="setting-label">Detail</span></div>
				<select class="theme-select" value={animationPassLevel} on:change={(e) => updateAnimationLevel(e.currentTarget.value as AnimationPassLevel)} disabled={!animationPassEnabled || reducedMotion}>
					<option value="balanced">Balanced</option>
					<option value="full">Full</option>
				</select>
			</div>
			<div class="setting-item-full" style="padding:0;border:0;background:transparent;box-shadow:none">
				<div class="setting-info"><span class="setting-label">Speed</span><span class="setting-description">{Math.round(animationPassDurationMultiplier * 100)}%</span></div>
				<input type="range" min="0.7" max="1.6" step="0.05" bind:value={animationPassDurationMultiplier} on:input={(e) => updateAnimationDurationMultiplier(parseFloat(e.currentTarget.value))} class="volume-slider" disabled={!animationPassEnabled || reducedMotion} />
			</div>
		</div>

		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Role colors</span>
				<span class="setting-description">On usernames.</span>
			</div>
			<select class="theme-select" value={roleColorMode} on:change={(e) => updateRoleColorMode(e.currentTarget.value as RoleColorMode)}>
				<option value="full">Full name color</option>
				<option value="dot">Dot only</option>
				<option value="off">Off</option>
			</select>
		</div>
		<div class="setting-item-full">
			<button type="button" class="action-btn secondary" on:click={resetAccessibilityVisuals}>Reset accessibility</button>
		</div>
	</div>
</div>

