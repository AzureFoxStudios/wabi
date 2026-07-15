<script lang="ts">
	import { onMount } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';

	onMount(() => {
		layoutStore.showAdminCenterStage();
	});
</script>

<div class="admin-stub">
	<div class="admin-stub-spinner" aria-hidden="true"></div>
	<span>Opening admin dashboard…</span>
</div>

<style>
	.admin-stub {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		height: 100%;
		min-height: 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.admin-stub-spinner {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid color-mix(in srgb, var(--accent-primary-color) 30%, transparent);
		border-top-color: var(--accent-primary-color);
		animation: admin-stub-spin 0.8s linear infinite;
	}

	@keyframes admin-stub-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
