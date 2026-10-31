<script lang="ts">
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
	import { profileOsReducedMotion } from '$lib/profileAppearance';
	import Segmented from '../ui/Segmented.svelte';
	import Select from '../ui/Select.svelte';
	import Switch from '../ui/Switch.svelte';
	import { ACCESSIBILITY_TEXT_SIZES, textSizeOptions, textSizeValue } from './settingsFrame';

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

	const presetOptions: Array<{ value: AnimationPassPreset; label: string }> = [
		{ value: 'slip', label: 'Slip' },
		{ value: 'fade', label: 'Fade' },
		{ value: 'scale', label: 'Scale' },
		{ value: 'flip', label: 'Flip' }
	];

	$: textSizes = textSizeOptions(interfaceScale, ACCESSIBILITY_TEXT_SIZES);
	$: textSize = textSizeValue(interfaceScale, textSizes);
	// The device setting reduces motion everywhere (motion.css), whatever the switch says.
	$: motionReduced = reducedMotion || $profileOsReducedMotion;
	$: motionPolishAvailable = animationPassEnabled && !motionReduced;

	const percent = (value: number) => `${Math.round(value * 100)}%`;
	const fill = (value: number, min: number, max: number) => `--w-range-fill: ${((value - min) / (max - min)) * 100}%`;

	function updateTextSize(value: number) {
		interfaceScale = updateAccessibilitySettings({ interfaceScale: value }).interfaceScale;
	}

	function setColorAssist(value: boolean) {
		colorAssistEnabled = updateAccessibilitySettings({ colorAssistEnabled: value }).colorAssistEnabled;
	}

	function updateSaturation(value: number) {
		saturation = updateAccessibilitySettings({ saturation: value }).saturation;
	}

	function updateContrast(value: number) {
		contrast = updateAccessibilitySettings({ contrast: value }).contrast;
	}

	/** Also marks <html data-motion="reduce">, which the newer surfaces read (§4.7). */
	function setReducedMotion(value: boolean) {
		reducedMotion = updateAccessibilitySettings({ reducedMotion: value }).reducedMotion;
		if (typeof document !== 'undefined') {
			if (reducedMotion) document.documentElement.setAttribute('data-motion', 'reduce');
			else document.documentElement.removeAttribute('data-motion');
		}
	}

	function setAnimationPass(value: boolean) {
		animationPassEnabled = updateAnimationPassSettings({ enabled: value }).enabled;
	}

	function updateAnimationPreset(value: string) {
		animationPassPreset = updateAnimationPassSettings({ preset: value as AnimationPassPreset }).preset;
	}

	function updateAnimationLevel(value: AnimationPassLevel) {
		animationPassLevel = updateAnimationPassSettings({ level: value }).level;
	}

	function updateAnimationDurationMultiplier(value: number) {
		animationPassDurationMultiplier = updateAnimationPassSettings({ durationMultiplier: value }).durationMultiplier;
	}

	function updateRoleColorMode(mode: RoleColorMode) {
		roleColorMode = updateAccessibilitySettings({ roleColorMode: mode }).roleColorMode;
	}

	function resetAccessibilityVisuals() {
		const next = updateAccessibilitySettings({
			interfaceScale: 1,
			colorAssistEnabled: false,
			saturation: 1,
			contrast: 1,
			reducedMotion: false,
			roleColorMode: 'full'
		});
		interfaceScale = next.interfaceScale;
		colorAssistEnabled = next.colorAssistEnabled;
		saturation = next.saturation;
		contrast = next.contrast;
		setReducedMotion(next.reducedMotion);
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

<!-- Reading and color -->
<section class="settings-block" aria-labelledby="a11y-seeing-title">
	<h3 class="settings-block__title" id="a11y-seeing-title">Seeing</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="a11y-text-size">Text size</p>
				<p class="w-srow__hint">Scales every word and control in Wabi. The same setting as on Appearance, with a larger step.</p>
			</div>
			<div class="w-srow__control">
				<Segmented labelledby="a11y-text-size" options={textSizes} value={textSize} onchange={updateTextSize} />
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="a11y-color-assist">Color assist</p>
				<p class="w-srow__hint">Adjusts saturation and contrast across the whole app on this device.</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="a11y-color-assist" checked={colorAssistEnabled} onchange={setColorAssist} />
			</div>
		</div>
		{#if colorAssistEnabled}
			<div class="w-srow settings-srow--sub">
				<div class="w-srow__text">
					<p class="w-srow__label" id="a11y-saturation">Saturation</p>
					<p class="w-srow__hint">{percent(saturation)}</p>
				</div>
				<div class="w-srow__control">
					<input
						class="w-range settings-range"
						type="range"
						min="0.6"
						max="1.8"
						step="0.05"
						value={saturation}
						style={fill(saturation, 0.6, 1.8)}
						aria-labelledby="a11y-saturation"
						aria-valuetext={percent(saturation)}
						on:input={(event) => updateSaturation(parseFloat(event.currentTarget.value))}
					/>
				</div>
			</div>
			<div class="w-srow settings-srow--sub">
				<div class="w-srow__text">
					<p class="w-srow__label" id="a11y-contrast">Contrast</p>
					<p class="w-srow__hint">{percent(contrast)}</p>
				</div>
				<div class="w-srow__control">
					<input
						class="w-range settings-range"
						type="range"
						min="0.8"
						max="1.4"
						step="0.05"
						value={contrast}
						style={fill(contrast, 0.8, 1.4)}
						aria-labelledby="a11y-contrast"
						aria-valuetext={percent(contrast)}
						on:input={(event) => updateContrast(parseFloat(event.currentTarget.value))}
					/>
				</div>
			</div>
		{/if}
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="a11y-name-colors">Name colors</p>
				<p class="w-srow__hint">How role colors show on people's names.</p>
			</div>
			<div class="w-srow__control">
				<Segmented
					labelledby="a11y-name-colors"
					options={[{ value: 'full', label: 'Colored name' }, { value: 'dot', label: 'Dot only' }, { value: 'off', label: 'Off' }]}
					value={roleColorMode}
					onchange={(value) => updateRoleColorMode(value as RoleColorMode)}
				/>
			</div>
		</div>
	</div>
</section>

<!-- Motion -->
<section class="settings-block" aria-labelledby="a11y-motion-title">
	<h3 class="settings-block__title" id="a11y-motion-title">Motion</h3>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="a11y-reduce-motion">Reduce motion</p>
				<p class="w-srow__hint">
					Panels and menus appear without sliding, and animated scenes hold still.{$profileOsReducedMotion ? ' Your device asks for less motion, so this stays on.' : ''}
				</p>
			</div>
			<div class="w-srow__control">
				<Switch
					labelledby="a11y-reduce-motion"
					checked={reducedMotion || $profileOsReducedMotion}
					disabled={$profileOsReducedMotion}
					onchange={setReducedMotion}
				/>
			</div>
		</div>
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="a11y-motion-polish">Motion polish</p>
				<p class="w-srow__hint">
					{#if motionReduced}Off while motion is reduced.{:else}Short movements when channels, messages and pop-outs appear.{/if}
				</p>
			</div>
			<div class="w-srow__control">
				<Switch labelledby="a11y-motion-polish" disabled={motionReduced} checked={animationPassEnabled && !motionReduced} onchange={setAnimationPass} />
			</div>
		</div>
		{#if motionPolishAvailable}
			<div class="w-srow settings-srow--sub">
				<div class="w-srow__text">
					<p class="w-srow__label">Style</p>
					<p class="w-srow__hint">How things enter.</p>
				</div>
				<div class="w-srow__control">
					<Select ariaLabel="Motion style" align="end" options={presetOptions} value={animationPassPreset} onchange={updateAnimationPreset} />
				</div>
			</div>
			<div class="w-srow settings-srow--sub">
				<div class="w-srow__text">
					<p class="w-srow__label" id="a11y-motion-detail">Detail</p>
					<p class="w-srow__hint">Full moves a little further.</p>
				</div>
				<div class="w-srow__control">
					<Segmented
						labelledby="a11y-motion-detail"
						options={[{ value: 'balanced', label: 'Balanced' }, { value: 'full', label: 'Full' }]}
						value={animationPassLevel}
						onchange={(value) => updateAnimationLevel(value as AnimationPassLevel)}
					/>
				</div>
			</div>
			<div class="w-srow settings-srow--sub">
				<div class="w-srow__text">
					<p class="w-srow__label" id="a11y-motion-speed">Duration</p>
					<p class="w-srow__hint">{percent(animationPassDurationMultiplier)} of the usual time</p>
				</div>
				<div class="w-srow__control">
					<input
						class="w-range settings-range"
						type="range"
						min="0.7"
						max="1.6"
						step="0.05"
						value={animationPassDurationMultiplier}
						style={fill(animationPassDurationMultiplier, 0.7, 1.6)}
						aria-labelledby="a11y-motion-speed"
						aria-valuetext="{percent(animationPassDurationMultiplier)} of the usual time"
						on:input={(event) => updateAnimationDurationMultiplier(parseFloat(event.currentTarget.value))}
					/>
				</div>
			</div>
		{/if}
	</div>
</section>

<!-- The page's foot: one quiet row under the last section, not a section of its own. -->
<section class="settings-block settings-block--foot" aria-labelledby="a11y-reset-title">
	<div class="w-srow">
		<div class="w-srow__text">
			<p class="w-srow__label" id="a11y-reset-title">Reset accessibility</p>
			<p class="w-srow__hint">Text size, color assist, name colors and motion go back to their defaults.</p>
		</div>
		<div class="w-srow__control">
			<button type="button" class="w-btn" on:click={resetAccessibilityVisuals}>Reset</button>
		</div>
	</div>
</section>
