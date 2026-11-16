<script lang="ts">
	import { _ } from '$lib/i18n';
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
		<h3 id="video-compress-title">{$_('vcd.title')}</h3>
		<p class="compression-copy">
			{$_('vcd.copy', { values: { name: file.name, size: formatFileMb(file.size) } })}
		</p>
		<p class="compression-runtime-note">{$_('vcd.runtime', { values: { label: runtimeLabel } })}</p>
		<div class="compression-preset-row">
			<label for="compression-preset-select">{$_('vcd.preset')}</label>
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
					{$_('vcd.est_out', { values: { size: formatFileMb(estimate.estimatedBytes) } })}
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
					<span>{$_('vcd.compressing')}</span>
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
				<button type="button" class="compression-btn secondary" on:click={onCancelCompression}>{$_('vcd.cancel')}</button>
			{:else if error}
				<button type="button" class="compression-btn" on:click={() => void onCompress()}>{$_('common.retry')}</button>
				<button type="button" class="compression-btn secondary" on:click={onKeepOriginal}>{$_('vcd.keep')}</button>
				<button type="button" class="compression-btn danger" on:click={onRemoveFile}>{$_('vcd.remove')}</button>
			{:else}
				<button type="button" class="compression-btn" on:click={() => void onCompress()}>{$_('vcd.compress')}</button>
				<button type="button" class="compression-btn secondary" on:click={onKeepOriginal}>{$_('vcd.keep')}</button>
				<button type="button" class="compression-btn danger" on:click={onRemoveFile}>{$_('vcd.remove')}</button>
			{/if}
		</div>
	</div>
</div>
