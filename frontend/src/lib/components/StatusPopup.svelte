<script lang="ts">
	import { currentUser, socket } from '$lib/socket';
	import { onMount } from 'svelte';

	let showPopup = false;
	let currentStatus: 'active' | 'away' | 'busy' = 'active';

	$: if ($currentUser) {
		currentStatus = $currentUser.status;
	}

	function setStatus(status: 'active' | 'away' | 'busy') {
		if ($socket && $currentUser) {
			$socket.emit('update-profile', {
				userId: $currentUser.id,
				status
			});
		}
		showPopup = false;
	}

	// Close popup when clicking outside
	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (showPopup && !target.closest('.status-popup-container')) {
			showPopup = false;
		}
	}

	onMount(() => {
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});
</script>

<div class="status-popup-container">
	<button
		class="status-button {currentStatus}"
		on:click={() => showPopup = !showPopup}
		title="Change status"
	>
		<div class="status-indicator"></div>
	</button>

	{#if showPopup}
		<div class="status-options">
			<button
				class="status-option active"
				on:click={() => setStatus('active')}
			>
				<div class="status-dot"></div>
				<span>Active</span>
			</button>
			<button
				class="status-option away"
				on:click={() => setStatus('away')}
			>
				<div class="status-dot"></div>
				<span>Away</span>
			</button>
			<button
				class="status-option busy"
				on:click={() => setStatus('busy')}
			>
				<div class="status-dot"></div>
				<span>Busy</span>
			</button>
		</div>
	{/if}
</div>

<style>
	.status-popup-container {
		position: fixed;
		bottom: 20px;
		left: 20px;
		z-index: 1000;
	}

	.status-button {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		border: 3px solid var(--bg-primary);
		background: var(--bg-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		transition: transform 0.2s, box-shadow 0.2s;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}

	.status-button:hover {
		transform: scale(1.1);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}

	.status-indicator {
		width: 24px;
		height: 24px;
		border-radius: 50%;
	}

	.status-button.active .status-indicator {
		background: var(--status-online);
	}

	.status-button.away .status-indicator {
		background: var(--status-away);
	}

	.status-button.busy .status-indicator {
		background: var(--status-busy);
	}

	.status-options {
		position: absolute;
		bottom: 100%;
		left: 0;
		margin-bottom: 8px;
		background: var(--bg-secondary);
		border-radius: 8px;
		padding: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		min-width: 140px;
	}

	.status-option {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 10px 12px;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--text-primary);
		cursor: pointer;
		transition: background 0.2s;
		text-align: left;
		font-size: 0.95rem;
	}

	.status-option:hover {
		background: var(--bg-hover);
	}

	.status-dot {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-option.active .status-dot {
		background: var(--status-online);
	}

	.status-option.away .status-dot {
		background: var(--status-away);
	}

	.status-option.busy .status-dot {
		background: var(--status-busy);
	}

	@media (max-width: 768px) {
		.status-popup-container {
			bottom: 70px; /* Above mobile nav */
			left: 16px;
		}

		.status-button {
			width: 40px;
			height: 40px;
		}

		.status-indicator {
			width: 20px;
			height: 20px;
		}
	}
</style>
