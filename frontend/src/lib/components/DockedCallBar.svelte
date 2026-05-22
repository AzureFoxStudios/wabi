<script lang="ts">
	export let participantCount: number;
	export let recordingPillText: string;
	export let isRecordingSaving: boolean;
	export let isRecording: boolean;
	export let isMuted: boolean;
	export let callRecordingStatus: string;
	export let onOpenEmbedded: () => void;
	export let onOpenFocus: () => void;
	export let onToggleMute: () => void;
	export let onToggleRecording: () => void;
	export let onEndCall: () => void;
</script>

<div class="docked-bar" role="region" aria-label="Docked call controls">
	<div class="docked-title">
		Call in progress ({participantCount})
		{#if recordingPillText}
			<span class="recording-pill compact" class:is-saving={isRecordingSaving}>
				<span class="recording-dot"></span>
				{recordingPillText}
			</span>
		{/if}
	</div>
	<div class="docked-actions">
		<button class="dock-btn" on:click={onOpenEmbedded} title="Open embedded call">Open</button>
		<button class="dock-btn" on:click={onOpenFocus} title="Focus call">Focus</button>
		<button class="dock-btn" class:active={isMuted} on:click={onToggleMute} title={isMuted ? 'Unmute' : 'Mute'}>Mute</button>
		<button
			class="dock-btn record"
			class:active={isRecording}
			on:click={onToggleRecording}
			title={isRecording ? 'Stop recording' : 'Start recording'}
		>
			{callRecordingStatus === 'saving' ? 'Saving' : isRecording ? 'Stop REC' : 'Record'}
		</button>
		<button class="dock-btn end" on:click={onEndCall} title="Leave call">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
		</button>
	</div>
</div>
