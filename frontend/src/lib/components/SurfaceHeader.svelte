<script lang="ts">
	export let title: string;
	export let description: string | undefined = undefined;
	export let icon: string | undefined = undefined;
	export let primaryLabel: string | undefined = undefined;
	export let onPrimary: (() => void) | undefined = undefined;
</script>

<div class="surface-header">
	{#if icon}
		<span class="surface-header-icon">{icon}</span>
	{/if}
	<h2 class="surface-header-title">{title}</h2>
	{#if description}
		<p class="surface-header-desc">{description}</p>
	{:else}
		<div style="flex:1"></div>
	{/if}
	<slot name="actions" />
	{#if primaryLabel}
		<button class="btn btn-primary" on:click={onPrimary}>{primaryLabel}</button>
	{/if}
</div>
