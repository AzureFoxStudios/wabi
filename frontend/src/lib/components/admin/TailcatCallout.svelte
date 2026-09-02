<script lang="ts">
	/**
	 * Discoverability callout for private access (the "informed default"
	 * contract's first half): on the admin overview, when the pipe is off,
	 * suggest turning it on. Dismissible — never nags twice.
	 */
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { getTailcatStatus } from '$lib/api/tailcat';

	const DISMISS_KEY = 'wabi.tailcat.calloutDismissed';

	let show = $state(false);

	onMount(async () => {
		if (localStorage.getItem(DISMISS_KEY) === '1') return;
		try {
			const status = await getTailcatStatus(getAuthToken());
			// Only suggest when the binary is actually available — never
			// advertise a feature that can't run on this host.
			show = !status.enabled && status.binaryVersion !== null;
		} catch {
			/* not admin or addon unreachable — stay silent */
		}
	});

	function dismiss(): void {
		localStorage.setItem(DISMISS_KEY, '1');
		show = false;
	}
</script>

{#if show}
	<div class="callout">
		<div>
			<strong>Family &amp; friends server?</strong>
			Enable private access — members connect with one code, no port forwarding, nothing public.
			Find it in <em>Runtime → Private access</em>.
		</div>
		<button aria-label="Dismiss" onclick={dismiss}>×</button>
	</div>
{/if}

<style>
	.callout {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		border: 1px solid var(--wabi-border, #2a2a35);
		border-left: 3px solid #6bcb77;
		border-radius: 8px;
		font-size: 0.92em;
	}
	button {
		background: none;
		border: none;
		color: inherit;
		font-size: 1.2em;
		cursor: pointer;
		opacity: 0.6;
	}
	button:hover {
		opacity: 1;
	}
</style>
