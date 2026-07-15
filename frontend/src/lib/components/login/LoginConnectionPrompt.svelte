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
		color: var(--launch-accent, var(--accent-primary-color));
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
		border: 1px solid color-mix(in srgb, var(--accent-primary-color) 30%, transparent);
		background: color-mix(in srgb, var(--accent-primary-color) 8%, transparent);
		accent-color: var(--launch-accent, var(--accent-primary-color));
	}

	input[type='text'] {
		width: 100%;
		padding: 0.875rem 1rem;
		font-size: 1rem;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--accent-primary-color) 18%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 88%, color-mix(in srgb, var(--surface-sunken) 72%, transparent));
		color: var(--text-heading);
		caret-color: var(--launch-accent, var(--accent-primary-color));
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
		border-color: color-mix(in srgb, var(--accent-primary-color) 56%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary-color) 16%, transparent), 0 10px 26px color-mix(in srgb, var(--surface-app) 18%, transparent);
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
		background: linear-gradient(135deg, var(--accent-primary-color, var(--accent-primary)), var(--accent-secondary-color, var(--launch-accent, var(--accent-secondary))));
		color: var(--text-on-accent, #ffffff);
		border: none;
		border-radius: 12px;
		cursor: pointer;
		margin-bottom: 0.75rem;
		transition: all 0.18s ease;
		appearance: none;
		-webkit-appearance: none;
	}

	.join-btn:hover:not(:disabled) {
		background: var(--accent-hover, var(--accent-primary-color));
		transform: translateY(-2px);
		box-shadow: 0 8px 20px color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 30%, transparent);
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
