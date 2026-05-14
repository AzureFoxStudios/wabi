<script lang="ts">
	import { incomingCall, answerCall, rejectCall } from '$lib/calling';
	import { getSocket } from '$lib/socket';
	import { slide } from 'svelte/transition';

	let socket = getSocket();

	function handleAnswer() {
		if (!$incomingCall) return;
		// We need to re-acquire the socket instance if the page was reloaded
		if (!socket) {
			socket = getSocket();
		}
		if (socket) {
			answerCall(socket, $incomingCall.userId, $incomingCall.isVideoCall);
		} else {
			console.error('Socket not available to answer call');
		}
	}

	function handleReject() {
		if (!$incomingCall) return;
		// We need to re-acquire the socket instance if the page was reloaded
		if (!socket) {
			socket = getSocket();
		}
		if (socket) {
			rejectCall(socket, $incomingCall.userId);
		} else {
			console.error('Socket not available to reject call');
		}
	}
</script>

{#if $incomingCall}
	<div class="modal-backdrop" transition:slide>
		<div class="modal-content">
			<p>Incoming {$incomingCall.isVideoCall ? 'video' : 'voice'} call from <strong>{$incomingCall.username}</strong></p>
			<div class="button-group">
				<button class="accept" on:click={handleAnswer}>Accept</button>
				<button class="reject" on:click={handleReject}>Reject</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		top: 20px;
		right: 20px;
		background-color: var(--surface-modal, rgba(40, 40, 40, 0.9));
		border-radius: 8px;
		padding: 20px;
		z-index: var(--z-call-overlay);
		box-shadow: 0 4px 10px var(--shadow-md, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.5))));
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.1);
	}

	.modal-content {
		color: var(--text-heading, white);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 15px;
	}

	p {
		margin: 0;
		font-size: 1rem;
	}

	strong {
		font-weight: 600;
		color: var(--accent, #a29bfe);
	}

	.button-group {
		display: flex;
		gap: 10px;
	}

	button {
		padding: 8px 16px;
		border-radius: 5px;
		border: none;
		cursor: pointer;
		font-weight: 500;
		transition: background-color 0.2s ease;
	}

	.accept {
		background-color: var(--color-success, #2ecc71);
		color: white;
	}

	.accept:hover {
		background-color: var(--color-success-hover, #27ae60);
	}

	.reject {
		background-color: var(--color-danger, #e74c3c);
		color: white;
	}

	.reject:hover {
		background-color: var(--color-danger-hover, #c0392b);
	}
</style>
