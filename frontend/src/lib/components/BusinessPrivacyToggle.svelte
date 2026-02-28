<script lang="ts">
	import { onMount } from 'svelte';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';

	let privateMode = false;
	let loading = false;
	let error = '';
	let isAuthenticated = false;

	async function togglePrivateMode() {
		const token = getAuthToken();
		if (!token) {
			error = 'Login required to use private mode';
			return;
		}

		loading = true;
		error = '';

		try {
			const serverUrl = getServerUrl();
			const response = await fetch(`${serverUrl}/api/user/business-private-mode`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`
				},
				credentials: 'include',
				body: JSON.stringify({ privateMode: !privateMode })
			});

			if (!response.ok) throw new Error('Failed to update setting');

			const result = await response.json();
			privateMode = result.privateMode;

			// Reload data after switching workspaces
			window.location.reload();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Update failed';
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		// Check if user is authenticated
		const token = getAuthToken();
		isAuthenticated = !!token;

		if (!token) return; // Guest users can't use private mode

		try {
			const serverUrl = getServerUrl();
			const response = await fetch(`${serverUrl}/api/user/settings`, {
				headers: { 'Authorization': `Bearer ${token}` },
				credentials: 'include'
			});
			if (response.ok) {
				const settings = await response.json();
				privateMode = settings.business_private_mode === 1;
			}
		} catch (err) {
			console.error('Failed to load privacy setting:', err);
		}
	});
</script>

<div class="privacy-toggle">
	<label>
		<input
			type="checkbox"
			checked={privateMode}
			on:change={togglePrivateMode}
			disabled={loading || !isAuthenticated}
		/>
		<span>Use Private Workspace</span>
	</label>
	<p class="hint">
		{#if !isAuthenticated}
			Login to enable private mode
		{:else if privateMode}
			Your data is private (not shared)
		{:else}
			Your data is shared with collaborators
		{/if}
	</p>
	{#if error}<p class="error">{error}</p>{/if}
</div>

<style>
	.privacy-toggle {
		padding: 1rem;
		border-top: 1px solid var(--border-color, #ddd);
	}

	label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		user-select: none;
	}

	input[type='checkbox'] {
		cursor: pointer;
		accent-color: var(--primary-color, #0066cc);
	}

	input[type='checkbox']:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	span {
		font-weight: 500;
	}

	.hint {
		font-size: 0.85rem;
		color: var(--text-secondary, #666);
		margin-top: 0.5rem;
		margin-bottom: 0;
	}

	.error {
		color: #ef4444;
		font-size: 0.85rem;
		margin-top: 0.5rem;
		margin-bottom: 0;
	}
</style>
