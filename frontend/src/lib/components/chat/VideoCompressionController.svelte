<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getTauriPlatform, isTauriRuntime } from '$lib/tauri-platform';
	import {
		classifyVideoCompressionFailure,
		compressVideoFileForUpload,
		estimateCompressedVideoOutput,
		inferVideoCodecHint,
		isVideoFile,
		sampleVideoCompressionInputMetadata,
		type VideoCompressionEstimate,
		type VideoCompressionInputMetadata,
		type VideoCompressionPresetId
	} from '$lib/video/videoCompressor';
	import {
		getDefaultVideoCompressionPreset,
		getVideoCompressionPresetOptions,
		getVideoCompressionRuntimeProfile,
		isVideoCompressionEnabled,
		type VideoCompressionPresetOption,
		type VideoCompressionRuntime
	} from '$lib/video/videoCompressionSettings';
	import { reportVideoCompressionTelemetry } from '$lib/video/videoCompressionTelemetry';
	import VideoCompressionDialog from './VideoCompressionDialog.svelte';
	import type { UploadVideoCompressionMetadata } from './uploadResumable';

	let compressionDialogOpen = false;
	let compressionDialogFile: File | null = null;
	let compressionDialogPreset: VideoCompressionPresetId = 'balanced_720p';
	let compressionDialogPresetOptions: VideoCompressionPresetOption[] =
		getVideoCompressionPresetOptions('desktop');
	let compressionDialogRuntime: VideoCompressionRuntime = 'desktop';
	let compressionDialogRuntimeLabel = 'Desktop';
	let selectedCompressionPresetOption: VideoCompressionPresetOption | null = null;
	let compressionDialogInputMetadata: VideoCompressionInputMetadata | null = null;
	let compressionDialogEstimate: VideoCompressionEstimate | null = null;
	let compressionDialogSuggestionCopy = '';
	let compressionDialogError = '';
	let compressionDialogProgress = 0;
	let compressionDialogBusy = false;
	let compressionDialogResolve: ((value: File | null) => void) | null = null;
	let compressionAbortController: AbortController | null = null;

	const compressionMetadataByFile = new WeakMap<File, UploadVideoCompressionMetadata>();

	$: selectedCompressionPresetOption =
		compressionDialogPresetOptions.find((option) => option.id === compressionDialogPreset) ||
		compressionDialogPresetOptions[0] ||
		null;
	$: if (compressionDialogFile && compressionDialogInputMetadata) {
		compressionDialogEstimate = estimateCompressedVideoOutput(
			compressionDialogFile.size,
			compressionDialogInputMetadata,
			compressionDialogPreset
		);
		compressionDialogSuggestionCopy = getCompressionSuggestionCopy(
			compressionDialogFile.size,
			compressionDialogRuntime,
			compressionDialogEstimate
		);
	} else {
		compressionDialogEstimate = null;
		compressionDialogSuggestionCopy = '';
	}

	export function getCompressionMetadata(file: File): UploadVideoCompressionMetadata | undefined {
		return compressionMetadataByFile.get(file);
	}

	export function deleteCompressionMetadata(file: File): void {
		compressionMetadataByFile.delete(file);
	}

	export function clearCompressionMetadata(files: File[]): void {
		for (const file of files) {
			compressionMetadataByFile.delete(file);
		}
	}

	export async function maybeCompressVideoFile(file: File): Promise<File | null> {
		const runtime = resolveVideoCompressionRuntime();
		const runtimeProfile = getVideoCompressionRuntimeProfile(runtime);
		if (!runtimeProfile.enabled) return file;
		if (!isVideoCompressionEnabled()) return file;
		if (!isVideoFile(file)) return file;
		if (runtimeProfile.maxInputBytes !== null && file.size > runtimeProfile.maxInputBytes) {
			void reportVideoCompressionTelemetry({
				outcome: 'skipped',
				runtime,
				preset: getDefaultVideoCompressionPreset(runtime),
				inputBytes: file.size,
				failureCode: 'input_above_runtime_limit'
			});
			alert(
				`"${file.name}" is ${formatFileMb(file.size)} MB. ${runtimeProfile.label} runtime keeps very large videos uncompressed to reduce device heat and instability.`
			);
			return file;
		}
		if (file.size < runtimeProfile.promptBytes) return file;
		return openCompressionDialog(file, runtime);
	}

	function formatFileMb(bytes: number): string {
		return (bytes / 1024 / 1024).toFixed(1);
	}

	function formatSignedMb(bytes: number): string {
		const sign = bytes >= 0 ? '+' : '-';
		return `${sign}${formatFileMb(Math.abs(bytes))} MB`;
	}

	function getCompressionSuggestionCopy(
		fileSize: number,
		runtime: VideoCompressionRuntime,
		estimate: VideoCompressionEstimate | null
	): string {
		if (!estimate) return '';
		const runtimeProfile = getVideoCompressionRuntimeProfile(runtime);
		const nearThresholdMargin = Math.max(runtimeProfile.promptBytes * 0.18, 5 * 1024 * 1024);
		const nearThreshold = fileSize <= runtimeProfile.promptBytes + nearThresholdMargin;
		if (nearThreshold && estimate.estimatedReductionRatio <= 0.2) {
			return 'This file is only slightly above the compression prompt threshold. Keeping the original may be fine on strong connections.';
		}
		if (estimate.estimatedReductionRatio >= 0.45) {
			return 'This preset is expected to significantly reduce upload size.';
		}
		if (estimate.estimatedReductionRatio <= 0.08) {
			return 'Only a small reduction is expected with this preset. Keeping the original may preserve better quality.';
		}
		return '';
	}

	function resolveVideoCompressionRuntime(): VideoCompressionRuntime {
		if (!isTauriRuntime()) return 'web';
		const runtime = getTauriPlatform();
		if (runtime === 'android' || runtime === 'ios' || runtime === 'desktop') {
			return runtime;
		}
		return 'desktop';
	}

	function applyCompressionRuntimeProfile(runtime: VideoCompressionRuntime): void {
		const profile = getVideoCompressionRuntimeProfile(runtime);
		compressionDialogRuntime = runtime;
		compressionDialogRuntimeLabel = profile.label;
		compressionDialogPresetOptions = getVideoCompressionPresetOptions(runtime);
		const preferredPreset = getDefaultVideoCompressionPreset(runtime);
		const presetAllowed = compressionDialogPresetOptions.some((option) => option.id === preferredPreset);
		compressionDialogPreset = presetAllowed ? preferredPreset : profile.recommendedPreset;
	}

	function resetCompressionDialogState(): void {
		if (compressionAbortController) {
			compressionAbortController.abort();
		}
		compressionDialogOpen = false;
		compressionDialogFile = null;
		compressionDialogInputMetadata = null;
		compressionDialogEstimate = null;
		compressionDialogSuggestionCopy = '';
		compressionDialogError = '';
		compressionDialogProgress = 0;
		compressionDialogBusy = false;
		compressionAbortController = null;
		compressionDialogResolve = null;
	}

	function resolveCompressionDialog(result: File | null): void {
		const resolve = compressionDialogResolve;
		resetCompressionDialogState();
		resolve?.(result);
	}

	function openCompressionDialog(file: File, runtime: VideoCompressionRuntime): Promise<File | null> {
		return new Promise((resolve) => {
			if (compressionDialogResolve) {
				resolveCompressionDialog(null);
			}
			applyCompressionRuntimeProfile(runtime);
			compressionDialogOpen = true;
			compressionDialogFile = file;
			compressionDialogInputMetadata = null;
			compressionDialogEstimate = null;
			compressionDialogSuggestionCopy = '';
			compressionDialogError = '';
			compressionDialogProgress = 0;
			compressionDialogBusy = false;
			compressionDialogResolve = resolve;

			const targetFile = file;
			void sampleVideoCompressionInputMetadata(targetFile)
				.then((metadata) => {
					if (!compressionDialogOpen || compressionDialogFile !== targetFile) return;
					compressionDialogInputMetadata = metadata;
				})
				.catch(() => {
					// Metadata sampling is best-effort.
				});
		});
	}

	function keepOriginalVideoFile(): void {
		if (compressionDialogFile) {
			compressionMetadataByFile.delete(compressionDialogFile);
			void reportVideoCompressionTelemetry({
				outcome: 'skipped',
				runtime: compressionDialogRuntime,
				preset: compressionDialogPreset,
				inputBytes: compressionDialogFile.size,
				failureCode: 'kept_original'
			});
		}
		resolveCompressionDialog(compressionDialogFile);
	}

	function removeVideoFileFromQueue(): void {
		if (compressionDialogFile) {
			compressionMetadataByFile.delete(compressionDialogFile);
			void reportVideoCompressionTelemetry({
				outcome: 'skipped',
				runtime: compressionDialogRuntime,
				preset: compressionDialogPreset,
				inputBytes: compressionDialogFile.size,
				failureCode: 'removed_from_queue'
			});
		}
		resolveCompressionDialog(null);
	}

	function cancelCompressionRun(): void {
		if (!compressionDialogBusy) return;
		compressionAbortController?.abort();
	}

	async function runVideoCompression(): Promise<void> {
		if (!compressionDialogFile || compressionDialogBusy) return;
		compressionDialogBusy = true;
		compressionDialogError = '';
		compressionDialogProgress = 0;
		const inputFile = compressionDialogFile;
		const runtimeProfile = getVideoCompressionRuntimeProfile(compressionDialogRuntime);
		const selectedPreset = compressionDialogPresetOptions.some(
			(option) => option.id === compressionDialogPreset
		)
			? compressionDialogPreset
			: runtimeProfile.recommendedPreset;
		if (selectedPreset !== compressionDialogPreset) {
			compressionDialogPreset = selectedPreset;
		}
		const startedAt = Date.now();
		const abortController = new AbortController();
		compressionAbortController = abortController;

		try {
			const compressed = await compressVideoFileForUpload(inputFile, {
				preset: selectedPreset,
				timeoutMs: runtimeProfile.timeoutMs,
				signal: abortController.signal,
				onProgress: (percent) => {
					compressionDialogProgress = Math.min(100, Math.max(0, Math.round(percent)));
				}
			});
			const inputMetadata = compressionDialogInputMetadata;
			const estimate = compressionDialogEstimate;
			compressionMetadataByFile.delete(inputFile);
			compressionMetadataByFile.set(compressed, {
				scheme: 'wabi-video-compression-v1',
				runtime: compressionDialogRuntime,
				preset: selectedPreset,
				originalSize: inputFile.size,
				compressedSize: compressed.size,
				codec: inferVideoCodecHint(compressed.type || '', compressed.name),
				mimeType: compressed.type || 'video/webm',
				durationMs: inputMetadata
					? Math.max(0, Math.round(inputMetadata.durationSeconds * 1000))
					: Date.now() - startedAt,
				estimatedOutputBytes: estimate?.estimatedBytes
			});
			void reportVideoCompressionTelemetry({
				outcome: 'success',
				runtime: compressionDialogRuntime,
				preset: selectedPreset,
				inputBytes: inputFile.size,
				outputBytes: compressed.size,
				durationMs: Date.now() - startedAt
			});
			resolveCompressionDialog(compressed);
			return;
		} catch (error) {
			const failureCode = abortController.signal.aborted
				? 'cancelled'
				: classifyVideoCompressionFailure(error);
			const cancelled = failureCode === 'cancelled';
			void reportVideoCompressionTelemetry({
				outcome: cancelled ? 'cancelled' : 'failure',
				runtime: compressionDialogRuntime,
				preset: selectedPreset,
				inputBytes: inputFile.size,
				durationMs: Date.now() - startedAt,
				failureCode
			});
			if (cancelled) {
				compressionDialogError = 'Compression was cancelled.';
			} else if (failureCode === 'timeout') {
				compressionDialogError = 'Compression timed out. Try a lower preset or keep the original file.';
			} else {
				compressionDialogError = error instanceof Error ? error.message : 'Compression failed.';
			}
		} finally {
			if (compressionAbortController === abortController) {
				compressionAbortController = null;
			}
			compressionDialogBusy = false;
		}
	}

	onDestroy(() => {
		if (compressionDialogResolve) {
			resolveCompressionDialog(null);
		}
	});
</script>

{#if compressionDialogOpen && compressionDialogFile}
	<VideoCompressionDialog
		file={compressionDialogFile}
		runtimeLabel={compressionDialogRuntimeLabel}
		bind:preset={compressionDialogPreset}
		presetOptions={compressionDialogPresetOptions}
		selectedPresetOption={selectedCompressionPresetOption}
		estimate={compressionDialogEstimate}
		suggestionCopy={compressionDialogSuggestionCopy}
		error={compressionDialogError}
		progress={compressionDialogProgress}
		busy={compressionDialogBusy}
		{formatFileMb}
		{formatSignedMb}
		onCancelCompression={cancelCompressionRun}
		onCompress={runVideoCompression}
		onKeepOriginal={keepOriginalVideoFile}
		onRemoveFile={removeVideoFileFromQueue}
	/>
{/if}
