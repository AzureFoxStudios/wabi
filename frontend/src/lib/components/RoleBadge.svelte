<script lang="ts">
	import { resolvedBadges } from '$lib/badges';
	import type { User } from '$lib/socket';

	// RoleBadge — renders role-derived + assignable badges inline next to a
	// name. Sizes: `sm` hugs message/roster rows; `md` stands alone in
	// popouts and admin lists. Tones reuse the `.role-inline-badge.tone-*`
	// palette (ml-badges.css); custom badges use the default tone plus icon.
	let {
		user,
		size = 'sm',
		maxBadges = 3,
		mode = 'all'
	}: {
		user?: User | null;
		size?: 'sm' | 'md';
		maxBadges?: number;
		/** `all`: role + custom; `custom`: assignable only (surfaces that
		 *  already render their own role badge); `role`: role-derived only. */
		mode?: 'all' | 'custom' | 'role';
	} = $props();

	const allBadges = $derived(resolvedBadges(user));
	const filtered = $derived(mode === 'all' ? allBadges : allBadges.filter((b) => (mode === 'custom' ? b.kind === 'custom' : b.kind === 'role')));
	const visible = $derived(filtered.slice(0, maxBadges));
	const overflow = $derived(filtered.length - visible.length);
</script>

{#if filtered.length > 0}
	<span class="role-badge-row" class:role-badge-md={size === 'md'}>
		{#each visible as badge (badge.id)}
			<span
				class={`role-inline-badge tone-${badge.tone}`}
				title={badge.label}
				class:badge-custom={badge.kind === 'custom'}
			>
				{#if badge.icon}<span class="badge-icon">{badge.icon}</span>{/if}
				{badge.label}
			</span>
		{/each}
		{#if overflow > 0}
			<span class={`role-inline-badge tone-default badge-more`} title={`${overflow} more`}>+{overflow}</span>
		{/if}
	</span>
{/if}

<style>
	.role-badge-row {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		vertical-align: middle;
	}

	.badge-icon {
		font-size: 0.85em;
		line-height: 1;
		margin-right: 0.15rem;
	}

	.badge-more {
		opacity: 0.75;
	}
</style>
