<script lang="ts">
	import { _ } from '$lib/i18n';

	export let currentUserHighestRole: string | undefined;
	export let canManageRoles: boolean;
	export let canModerate: boolean;
	export let usersLength: number;
	export let ownerCount: number;
	export let adminCount: number;
	export let modCount: number;
	export let guestCount: number;

	function getRoleLabel(roleName: string): string {
		const labels: Record<string, string> = {
			owner: 'Owner',
			admin: 'Admin',
			mod: 'Moderator',
			member: 'Member',
			guest: 'Guest'
		};
		return labels[roleName] || roleName;
	}
</script>

<div class="admin-header">
	<div class="admin-title-row">
		<h3>{$_('admin.title')}</h3>
		<span class="admin-role-indicator">{$_('admin.you')}: {getRoleLabel(currentUserHighestRole || 'member')}</span>
	</div>
	<p class="admin-subtitle">
		{#if canManageRoles}
			{$_('admin.subtitle.manage')}
		{:else if canModerate}
			{$_('admin.subtitle.moderate')}
		{:else}
			{$_('admin.subtitle.none')}
		{/if}
	</p>
</div>

<div class="admin-stats">
	<div class="admin-stat"><span class="k">{$_('admin.stats.users')}</span><span class="v">{usersLength}</span></div>
	<div class="admin-stat"><span class="k">{$_('admin.stats.owners')}</span><span class="v">{ownerCount}</span></div>
	<div class="admin-stat"><span class="k">{$_('admin.stats.admins')}</span><span class="v">{adminCount}</span></div>
	<div class="admin-stat"><span class="k">{$_('admin.stats.mods')}</span><span class="v">{modCount}</span></div>
	<div class="admin-stat"><span class="k">{$_('admin.stats.guests')}</span><span class="v">{guestCount}</span></div>
</div>


