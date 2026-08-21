<script lang="ts">
	/**
	 * Planner avatar primitive — real profile picture when available,
	 * colored-initial fallback otherwise. Used on kanban cards, calendar task
	 * pills, day-modal rows, TaskPanel assignee tags, and signature chips.
	 *
	 * Svelte 4 (`export let` / on:click) — matches the business tree.
	 */
	export let name = '';
	export let color = '#6366f1';
	export let src: string | undefined = undefined;
	export let size: 'xs' | 'sm' | 'md' = 'sm';
	/** Stacked-group rendering (overlapping avatars). */
	export let stacked = false;
	/** Accessible label; defaults to `${name}'s avatar`. */
	export let label = '';

	const sizePx: Record<'xs' | 'sm' | 'md', number> = { xs: 16, sm: 20, md: 28 };

	$: px = sizePx[size];
	$: initial = (name || '?').trim().charAt(0).toUpperCase();
	$: title = label || (name ? `${name}` : '');
</script>

<span
	class="planner-avatar"
	class:stacked
	style="--avatar-size: {px}px; --avatar-color: {color};"
	title={title}
	aria-hidden={label ? 'false' : 'true'}
>
	{#if src}
		<img class="planner-avatar-img" src={src} alt="" loading="lazy" />
	{:else}
		<span class="planner-avatar-initial">{initial}</span>
	{/if}
</span>

<style>
	.planner-avatar {
		width: var(--avatar-size);
		height: var(--avatar-size);
		border-radius: 50%;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		background: var(--avatar-color);
		box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--surface-app, #1a1a2e) 80%, transparent);
		user-select: none;
	}
	.planner-avatar.stacked {
		box-shadow:
			0 0 0 1.5px color-mix(in srgb, var(--surface-app, #1a1a2e) 80%, transparent),
			0 1px 2px rgba(0, 0, 0, 0.3);
	}
	.planner-avatar + .planner-avatar {
		margin-left: -4px;
	}
	.planner-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.planner-avatar-initial {
		font-size: calc(var(--avatar-size) * 0.52);
		line-height: 1;
		font-weight: 600;
		color: #ffffff;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.25);
	}
</style>
