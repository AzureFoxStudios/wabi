<script lang="ts">
	import type { VideoCompressionEstimate, VideoCompressionPresetId } from '$lib/video/videoCompressor';
	import type { VideoCompressionPresetOption } from '$lib/video/videoCompressionSettings';

	export let file: File;
	export let runtimeLabel = 'Desktop';
	export let preset: VideoCompressionPresetId = 'balanced_720p';
	export let presetOptions: VideoCompressionPresetOption[] = [];
	export let selectedPresetOption: VideoCompressionPresetOption | null = null;
	export let estimate: VideoCompressionEstimate | null = null;
	export let suggestionCopy = '';
	export let error = '';
	export let progress = 0;
	export let busy = false;
	export let formatFileMb: (bytes: number) => string;
	export let formatSignedMb: (bytes: number) => string;
	export let onCancelCompression: () => void;
	export let onCompress: () => void | Promise<void>;
	export let onKeepOriginal: () => void;
	export let onRemoveFile: () => void;
</script>

<div class="compression-modal-backdrop overlay" role="presentation">
	<div class="compression-modal card" role="dialog" aria-modal="true" aria-labelledby="video-compress-title">
		<h3 id="video-compress-title">Compress Video Before Upload</h3>
		<p class="compression-copy">
			"{file.name}" is {formatFileMb(file.size)} MB. Compress now or keep the original file.
		</p>
		<p class="compression-runtime-note">Runtime profile: {runtimeLabel}</p>
		<div class="compression-preset-row">
			<label for="compression-preset-select">Preset</label>
			<select id="compression-preset-select" bind:value={preset} disabled={busy}>
				{#each presetOptions as presetOption (presetOption.id)}
					<option value={presetOption.id}>{presetOption.label}</option>
				{/each}
			</select>
		</div>
		{#if selectedPresetOption}
			<div class="compression-preset-note">{selectedPresetOption.description}</div>
		{/if}
		{#if estimate}
			<div class="compression-estimate">
				<span>
					Estimated output: {formatFileMb(estimate.estimatedBytes)} MB
					({estimate.targetWidth}x{estimate.targetHeight})
				</span>
				<span class:estimate-saving={estimate.estimatedReductionRatio > 0}>
					{formatSignedMb(estimate.estimatedBytes - file.size)}
				</span>
			</div>
		{/if}
		{#if suggestionCopy}
			<div class="compression-suggestion">{suggestionCopy}</div>
		{/if}
		{#if busy}
			<div class="compression-progress">
				<div class="compression-progress-info">
					<span>Compressing...</span>
					<span>{progress}%</span>
				</div>
				<div class="progress-bar">
					<div class="progress-fill" style="width: {progress}%"></div>
				</div>
			</div>
		{:else if error}
			<div class="compression-error">{error}</div>
		{/if}
		<div class="compression-actions">
			{#if busy}
				<button type="button" class="compression-btn secondary" on:click={onCancelCompression}>Cancel Compression</button>
			{:else if error}
				<button type="button" class="compression-btn" on:click={() => void onCompress()}>Retry</button>
				<button type="button" class="compression-btn secondary" on:click={onKeepOriginal}>Keep Original</button>
				<button type="button" class="compression-btn danger" on:click={onRemoveFile}>Remove File</button>
			{:else}
				<button type="button" class="compression-btn" on:click={() => void onCompress()}>Compress</button>
				<button type="button" class="compression-btn secondary" on:click={onKeepOriginal}>Keep Original</button>
				<button type="button" class="compression-btn danger" on:click={onRemoveFile}>Remove File</button>
			{/if}
		</div>
	</div>
</div>
