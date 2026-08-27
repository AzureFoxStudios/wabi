<script lang="ts">
	import { formatRecordingElapsedForUi, stopCallRecording, type CallRecordingState } from '$lib/callRecording';

	export let recordingState: CallRecordingState;
	export let recordingLabel: string = '';
	export let recordingPresenceCopy: string = '';
	// 2026-08-27: these were `export const` — NOT props. Parents passing
	// recordingPillText/onToggleRecording were silently ignored, and the panel
	// had no stop control of its own ("no ability to stop recording").
	export let recordingPillText: string = '';
	export let onToggleRecording: (() => void) | null = null;

	let stopping = false;
	async function handleStop(): Promise<void> {
		if (stopping) return;
		stopping = true;
		try {
			if (onToggleRecording) onToggleRecording();
			else await stopCallRecording();
		} catch (err) {
			console.error('[CallRecordingPanel] stop failed:', err);
		} finally {
			stopping = false;
		}
	}
</script>

{#if recordingState.status === 'recording' || recordingState.status === 'saving'}
	<div class="recording-banner" role="status" aria-live="polite">
		<span class="recording-pill" class:is-saving={recordingState.status === 'saving'}>
			<span class="recording-dot"></span>
			{#if recordingState.status === 'recording'}
				REC {formatRecordingElapsedForUi(recordingState.elapsedMs)}
			{:else}
				Saving
			{/if}
		</span>
		<span class="recording-copy">{recordingPresenceCopy}</span>
		{#if recordingState.status === 'recording'}
			<button type="button" class="recording-stop-btn" onclick={handleStop} disabled={stopping}>
				{stopping ? 'Stopping…' : 'Stop'}
			</button>
		{/if}
	</div>
{/if}

{#if recordingLabel}
	<div class="recording-status" class:is-error={recordingState.status === 'error'}>
		{recordingLabel}
	</div>
{/if}

{#if recordingState.loreUploadStatus !== 'none' && recordingState.status !== 'recording' && recordingState.status !== 'saving'}
	<div
		class="lore-upload"
		class:is-error={recordingState.loreUploadStatus === 'error'}
		class:is-warn={recordingState.loreUploadStatus === 'no-channel'}
		role="status"
		aria-live="polite"
	>
		{#if recordingState.loreUploadStatus === 'uploading'}
			Saving recording to Lore…
		{:else if recordingState.loreUploadStatus === 'done'}
			Saved to Lore Recordings
		{:else if recordingState.loreUploadStatus === 'no-channel'}
			Lore Recordings channel not found
		{:else if recordingState.loreUploadStatus === 'error'}
			Lore upload failed: {recordingState.loreUploadError}
		{/if}
	</div>
{/if}

<style>
	.recording-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.85rem;
		padding: 0.65rem 0.9rem;
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.22);
		border-bottom: 1px solid rgba(var(--color-danger-rgb, 248, 113, 113), 0.18);
	}

	.recording-stop-btn {
		flex-shrink: 0;
		padding: 0.3rem 0.7rem;
		border-radius: 999px;
		border: 1px solid rgba(var(--color-danger-rgb, 248, 113, 113), 0.45);
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.5);
		color: var(--accent-danger-soft, #fef2f2);
		font-size: 0.74rem;
		font-weight: 700;
		cursor: pointer;
	}

	.recording-stop-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.recording-copy {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-inverse, rgba(254, 226, 226, 0.88));
		text-align: right;
	}

	.recording-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.38rem 0.62rem;
		border-radius: 999px;
		background: rgba(var(--surface-app-rgb, 17, 24, 39), 0.76);
		border: 1px solid rgba(var(--color-danger-rgb, 248, 113, 113), 0.28);
		color: var(--accent-danger-soft, #fef2f2);
		font-size: 0.78rem;
		font-weight: 700;
	}

	.recording-pill.is-saving {
		border-color: var(--color-warning, rgba(253, 224, 71, 0.3));
		color: var(--accent-warning-soft, #fef9c3);
	}

	.recording-dot {
		width: 0.56rem;
		height: 0.56rem;
		border-radius: 50%;
		background: var(--color-danger, var(--color-danger, #ef4444));
		box-shadow: 0 0 0 0 rgba(var(--color-danger-rgb, 239, 68, 68), 0.5);
		animation: recording-pulse 1.4s infinite;
	}

	.recording-pill.is-saving .recording-dot {
		background: var(--color-warning, #facc15);
		box-shadow: none;
		animation: none;
	}

	.recording-status {
		position: absolute;
		top: 3.9rem;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(92vw, 900px);
		background: var(--shadow-lg, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.56))));
		padding: 0.25rem 0.52rem;
		border-radius: 8px;
		font-size: 0.66rem;
		font-weight: 600;
		color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.88);
		z-index: 3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.recording-status.is-error {
		color: var(--accent-danger-soft, var(--accent-danger-soft, #fecaca));
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.62);
	}

	.lore-upload {
		position: absolute;
		top: 3.9rem;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(92vw, 900px);
		background: var(--shadow-lg, rgba(0, 0, 0, 0.56));
		padding: 0.25rem 0.52rem;
		border-radius: 8px;
		font-size: 0.66rem;
		font-weight: 600;
		color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.88);
		z-index: 3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.lore-upload.is-error {
		color: var(--accent-danger-soft, #fecaca);
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.62);
	}

	.lore-upload.is-warn {
		color: var(--accent-warning-soft, #fef9c3);
		background: rgba(var(--color-warning-rgb, 161, 98, 7), 0.62);
	}

	@keyframes recording-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(var(--color-danger-rgb, 239, 68, 68), 0.5);
		}
		70% {
			box-shadow: 0 0 0 8px rgba(var(--color-danger-rgb, 239, 68, 68), 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(var(--color-danger-rgb, 239, 68, 68), 0);
		}
	}
</style>
