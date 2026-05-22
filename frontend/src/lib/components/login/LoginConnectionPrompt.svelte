<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { setConfiguredServerUrl } from '$lib/serverUrl';

	export let serverDomain = '';
	export let rememberServer = true;
	export let loading = false;

	const dispatch = createEventDispatcher<{ applied: { serverDomain: string } }>();
	let connectionError = '';

	function focusOnMount(node: HTMLInputElement) { node.focus(); return {}; }

	function apply() {
		connectionError = '';
		try {
			const normalized = setConfiguredServerUrl(serverDomain, rememberServer);
			serverDomain = normalized;
			dispatch('applied', { serverDomain: normalized });
		} catch (err) {
			connectionError = err instanceof Error ? err.message : 'Invalid domain';
		}
	}
</script>

<div class="connection-box">
	<h3>Connect to Wabi Domain</h3>
	<input
		type="text"
		bind:value={serverDomain}
		placeholder="wabi.chat or https://staging.wabi.chat"
		use:focusOnMount
		disabled={loading}
	/>
	<label class="remember-row">
		<input type="checkbox" bind:checked={rememberServer} />
		<span>Remember this domain on this device</span>
	</label>
	{#if connectionError}
		<div class="error-message">{connectionError}</div>
	{/if}
	<button type="button" class="join-btn" on:click={apply} disabled={loading}>Continue</button>
</div>

<style>
	.connection-box {
		text-align: left;
	}

	.connection-box h3 {
		margin: 0 0 0.75rem 0;
		color: var(--text-heading);
		font-size: 1rem;
	}

	.remember-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0.1rem 0 1rem 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.remember-row input[type='checkbox'] {
		width: 16px;
		height: 16px;
		margin: 0;
		padding: 0;
	}

	input[type='text'] {
		width: 100%;
		padding: 1rem;
		font-size: 1.1rem;
		border-radius: 12px;
		border: none;
		background: var(--surface-raised);
		color: var(--text-heading);
		margin-bottom: 1rem;
	}

	input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.join-btn {
		width: 100%;
		padding: 1rem;
		font-size: 1.2rem;
		font-weight: 700;
		background: var(--launch-accent, var(--accent-primary));
		color: white;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		margin-bottom: 1.5rem;
		transition: all 0.3s;
	}

	.join-btn:hover:not(:disabled) {
		background: var(--accent-hover, #4752c4);
		transform: translateY(-2px);
		box-shadow: 0 8px 20px rgba(88, 101, 242, 0.3);
	}

	.join-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.error-message {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgb(239, 68, 68);
		color: #fca5a5;
		padding: 0.75rem 1rem;
		border-radius: 8px;
		margin-bottom: 1rem;
		font-size: 0.9rem;
	}
</style>
