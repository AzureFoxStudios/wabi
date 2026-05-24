<script lang="ts">
	import type { AnimationLoopMode, ThreadMode } from './modelViewerHelpers';

	export let menuOpen = false;
	export let autoRotate = false;
	export let showGrid = true;
	export let showAxes = false;
	export let showRig = true;
	export let showDebugStats = false;
	export let animationClipOptions: Array<{ index: number; name: string; duration: number }> = [];
	export let selectedAnimationIndex = 0;
	export let animationPlaying = true;
	export let animationSpeed = 1;
	export let animationLoopMode: AnimationLoopMode = 'repeat';
	export let threadMode: ThreadMode = 'auto';

	export let onToggleAutoRotate: () => void = () => {};
	export let onResetView: () => void = () => {};
	export let onToggleGrid: () => void = () => {};
	export let onToggleAxes: () => void = () => {};
	export let onToggleRig: () => void = () => {};
	export let onToggleDebugStats: () => void = () => {};
	export let onAnimationClipChange: (event: Event) => void = () => {};
	export let onToggleAnimationPlayback: () => void = () => {};
	export let onAnimationLoopModeChange: (event: Event) => void = () => {};
	export let onAnimationSpeedChange: (event: Event) => void = () => {};
	export let onThreadModeChange: (event: Event) => void = () => {};
</script>

<button
	type="button"
	class="settings-fab"
	aria-expanded={menuOpen}
	aria-haspopup="menu"
	on:click={() => (menuOpen = !menuOpen)}
>
	View Settings
</button>
{#if menuOpen}
	<div class="settings-menu" role="menu">
		<button type="button" class="menu-item" class:active={autoRotate} on:click={onToggleAutoRotate}>Auto-rotate</button>
		<button type="button" class="menu-item" on:click={onResetView}>Reset View</button>
		<button type="button" class="menu-item" class:active={showGrid} on:click={onToggleGrid}>Grid</button>
		<button type="button" class="menu-item" class:active={showAxes} on:click={onToggleAxes}>Axes</button>
		<button type="button" class="menu-item" class:active={showRig} on:click={onToggleRig}>Bones / Controllers</button>
		<button type="button" class="menu-item" class:active={showDebugStats} on:click={onToggleDebugStats}>Debug Stats Overlay</button>
		{#if animationClipOptions.length > 0}
			<div class="menu-section">
				<div class="menu-section-title">Animation</div>
				<label class="menu-item clip-control">
					<span>Clip</span>
					<select bind:value={selectedAnimationIndex} on:change={onAnimationClipChange}>
						{#each animationClipOptions as clip}
							<option value={clip.index}>{clip.name}</option>
						{/each}
					</select>
				</label>
				<button type="button" class="menu-item" class:active={animationPlaying} on:click={onToggleAnimationPlayback}>
					{animationPlaying ? 'Pause' : 'Play'}
				</button>
				<label class="menu-item clip-control">
					<span>Loop</span>
					<select bind:value={animationLoopMode} on:change={onAnimationLoopModeChange}>
						<option value="repeat">Repeat</option>
						<option value="once">Once</option>
						<option value="pingpong">Ping Pong</option>
					</select>
				</label>
				<label class="menu-item speed-control">
					<span>Speed {animationSpeed.toFixed(1)}x</span>
					<input
						type="range"
						min="0.1"
						max="2.5"
						step="0.1"
						value={animationSpeed}
						on:input={onAnimationSpeedChange}
					/>
				</label>
			</div>
		{/if}
		<label class="menu-item thread-mode-control">
			<span>Threading</span>
			<select bind:value={threadMode} on:change={onThreadModeChange}>
				<option value="auto">Auto</option>
				<option value="always">Always Multi-thread</option>
				<option value="off">Off</option>
			</select>
		</label>
	</div>
{/if}
