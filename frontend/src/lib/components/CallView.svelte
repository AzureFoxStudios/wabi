<script lang="ts">
	import { screenShares, isSharing, stopScreenShare } from '$lib/webrtc';
	import { activeCalls, endCall, isInCall, connectionStats } from '$lib/calling';
	import { getSocket } from '$lib/socket';
	import { fade } from 'svelte/transition';

	// Reactive declaration to determine if any call or screen share is active
	$: hasActiveMedia = $activeCalls.length > 0 || $screenShares.length > 0;
    $: participantCount = $activeCalls.length + $screenShares.length;

	function handleStopScreenShare() {
		const socketInstance = getSocket();
		if (socketInstance) {
			stopScreenShare(socketInstance);
		} else {
			console.error('Socket not available to stop screen share');
		}
	}

	function handleEndCall() {
		const socketInstance = getSocket();
		if (socketInstance) {
			endCall(socketInstance);
		} else {
			console.error('Socket not available to end call');
		}
	}
</script>

{#if hasActiveMedia}
	<div 
        class="call-view-container"
        class:participants-1={participantCount === 1}
        class:participants-2={participantCount === 2}
        class:participants-3={participantCount === 3 || participantCount === 4}
        class:participants-many={participantCount > 4}
        transition:fade
    >
		{#each $activeCalls as call (call.userId)}
			{@const stats = $connectionStats.get(call.userId)}
			<div class="media-window">
				<video
					autoplay
					playsinline
					muted={call.userId === $activeCalls[0]?.userId}
					srcObject={call.stream}
					class:hidden={!call.isVideoEnabled}
				></video>
				<div class="user-label">
                    {#if stats}
                        <div 
                            class="quality-indicator {stats.quality}"
                            title="Packets Lost: {stats.packetsLost?.toFixed(0) ?? 'N/A'}, Jitter: {stats.jitter?.toFixed(4) ?? 'N/A'}, RTT: {stats.roundTripTime?.toFixed(4) ?? 'N/A'}"
                        ></div>
                    {/if}
                    {call.username || 'Unknown'} (Call)
                </div>
			</div>
		{/each}

		{#each $screenShares as share (share.userId)}
			<div class="media-window screen-share-window">
				<video
					autoplay
					playsinline
					srcObject={share.stream}
				></video>
				<div class="user-label">{share.username || 'Unknown'} (Screen Share)</div>
			</div>
		{/each}

		<div class="controls">
			{#if $isSharing}
				<button class="control-button stop-share" on:click={handleStopScreenShare} title="Stop Screen Share">
					⏹️ Stop Share
				</button>
			{/if}
			{#if $isInCall}
				<button class="control-button end-call" on:click={handleEndCall} title="End Call">
					📞 End Call
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.call-view-container {
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		background-color: rgba(0, 0, 0, 0.7);
		z-index: 999;
		display: grid;
		gap: 10px;
		padding: 20px;
		box-sizing: border-box;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        place-items: center;
	}

    /* 1 participant: centered, larger view */
    .participants-1 {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr;
    }
    .participants-1 .media-window {
        max-width: 80vw;
        max-height: 80vh;
    }
    
    /* 2 participants: side-by-side */
    .participants-2 {
        grid-template-columns: 1fr 1fr;
        align-content: center;
    }

    /* 3 or 4 participants: 2x2 grid */
    .participants-3, .participants-4 {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
        align-content: center;
    }

    /* 5+ participants: wrap to new rows */
    .participants-many {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }

	.media-window {
		position: relative;
		background-color: #1a1a1a;
		border: 1px solid #333;
		border-radius: 8px;
		overflow: hidden;
		width: 100%;
		height: 100%;
		aspect-ratio: 16 / 9;
		display: flex;
		justify-content: center;
		align-items: center;
	}

	.media-window video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background-color: black;
	}

	.media-window video.hidden {
		display: none;
	}

	.user-label {
		position: absolute;
		bottom: 10px;
		left: 10px;
		background-color: rgba(0, 0, 0, 0.6);
		color: white;
		padding: 5px 10px;
		border-radius: 5px;
		font-size: 0.9rem;
        display: flex;
        align-items: center;
	}

    .quality-indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-right: 8px;
    }

    .quality-indicator.good {
        background-color: #2ecc71; /* green */
    }

    .quality-indicator.average {
        background-color: #f1c40f; /* yellow */
    }

    .quality-indicator.poor {
        background-color: #e74c3c; /* red */
    }

	.controls {
		position: absolute;
		bottom: 20px;
		display: flex;
		gap: 10px;
		background-color: rgba(0, 0, 0, 0.6);
		padding: 10px 15px;
		border-radius: 8px;
	}

	.control-button {
		background-color: #5865f2;
		color: white;
		border: none;
		padding: 10px 15px;
		border-radius: 5px;
		cursor: pointer;
		font-size: 1rem;
		transition: background-color 0.2s ease;
	}

	.control-button:hover {
		background-color: #4752c4;
	}

	.stop-share {
		background-color: #e74c3c;
	}

	.stop-share:hover {
		background-color: #c0392b;
	}

	.end-call {
		background-color: #e74c3c;
	}

	.end-call:hover {
		background-color: #c0392b;
	}
</style>