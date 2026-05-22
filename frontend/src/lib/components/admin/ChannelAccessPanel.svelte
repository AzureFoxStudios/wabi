<script lang="ts">
	import { _ } from '$lib/i18n';

	export let customChannels: Array<{ id: string; name: string; type: string; minRole?: string }>;
	export let channelRoleOptions: Array<{ roleName: string; displayName: string }>;
	export let canManageRoles: boolean;
	export let getRoleLabel: (roleName?: string) => string;
	export let onChannelMinRoleChange: (channelId: string, roleName: string) => void;
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.channel_access')}</h4>
	<div class="channel-role-list">
		{#each customChannels as channel (channel.id)}
			<div class="channel-role-item">
				<div class="channel-role-meta">
					<span class="channel-name">#{channel.name}</span>
					<span class="channel-type">{channel.type}</span>
				</div>
				<select
					class="channel-role-select"
					value={channel.minRole || 'guest'}
					on:change={(e) => onChannelMinRoleChange(channel.id, (e.currentTarget as HTMLSelectElement).value)}
				>
					<option value="guest">{getRoleLabel('guest')}</option>
					{#each channelRoleOptions as role (role.roleName)}
						<option value={role.roleName}>{getRoleLabel(role.roleName)}</option>
					{/each}
				</select>
			</div>
		{/each}
	</div>
</div>
