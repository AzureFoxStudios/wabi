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
	<p class="connection-kicker">Server connection</p>
	<h3>Connect to a Wabi domain</h3>
	<p class="connection-copy">Point this client at your self-hosted server. You can change it later from the login screen.</p>
	<label class="connection-field">
		<span>Domain or URL</span>
		<input
			type="text"
			bind:value={serverDomain}
			placeholder="wabi.chat or https://staging.wabi.chat"
			use:focusOnMount
			disabled={loading}
		/>
	</label>
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

	.connection-kicker {
		margin: 0 0 0.35rem;
		color: var(--launch-accent, var(--accent-primary));
		font-size: 0.72rem;
		font-weight: 750;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.connection-box h3 {
		margin: 0 0 0.4rem 0;
		color: var(--text-heading);
		font-size: 1.35rem;
		letter-spacing: -0.025em;
	}

	.connection-copy {
		margin: 0 0 1.25rem;
		color: var(--text-secondary);
		font-size: 0.92rem;
		line-height: 1.55;
	}

	.connection-field {
		display: block;
		margin-bottom: 1rem;
	}

	.connection-field span {
		display: block;
		margin: 0 0 0.38rem;
		color: var(--text-secondary);
		font-size: 0.76rem;
		font-weight: 720;
		letter-spacing: 0.055em;
		text-transform: uppercase;
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
		min-height: 0;
		margin: 0;
		padding: 0;
		flex-shrink: 0;
		border-radius: 5px;
		border: 1px solid rgba(125, 211, 252, 0.3);
		background: rgba(125, 211, 252, 0.08);
		accent-color: var(--launch-accent, var(--accent-primary));
	}

	input[type='text'] {
		width: 100%;
		padding: 0.875rem 1rem;
		font-size: 1rem;
		border-radius: 12px;
		border: 1px solid rgba(125, 211, 252, 0.18);
		background: color-mix(in srgb, var(--surface-raised) 88%, rgba(8, 14, 28, 0.72));
		color: var(--text-heading);
		caret-color: var(--launch-accent, var(--accent-primary));
		margin-bottom: 0;
		appearance: none;
		-webkit-appearance: none;
		transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
	}

	input[type='text']::placeholder {
		color: var(--text-muted, #9fb1c9);
		opacity: 0.86;
	}

	input[type='text']:focus,
	input[type='text']:focus-visible {
		outline: none;
		border-color: rgba(125, 211, 252, 0.56);
		box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.16), 0 10px 26px rgba(0, 0, 0, 0.18);
	}

	input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.join-btn {
		width: 100%;
		padding: 0.875rem 1rem;
		font-size: 1rem;
		font-weight: 740;
		background: linear-gradient(135deg, var(--accent-primary, #5865f2), var(--launch-accent, #7dd3fc));
		color: white;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		margin-bottom: 0.75rem;
		transition: all 0.18s ease;
		appearance: none;
		-webkit-appearance: none;
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
