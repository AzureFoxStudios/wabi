<script lang="ts">
	import { _ } from '$lib/i18n';

	export type RoleDefinition = {
		roleName: string;
		displayName: string;
		priority: number;
		color: string | null;
		isHoisted: boolean;
	};

	export let roleDefinitions: RoleDefinition[];
	export let roleLabelDrafts: Record<string, string>;
	export let canManageRoles: boolean;
	export let onDraftChange: (roleName: string, value: string) => void;
	export let onSave: (roleName: string) => void;
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.role_names')}</h4>
	<div class="role-list">
		{#each roleDefinitions as role (role.roleName)}
			<div class="role-item">
				<span class="role-key">{role.roleName}</span>
				<input class="role-input" value={roleLabelDrafts[role.roleName] || ''} on:input={(e) => onDraftChange(role.roleName, (e.currentTarget as HTMLInputElement).value)} />
				<button class="admin-btn" on:click={() => onSave(role.roleName)}>{$_('common.save')}</button>
			</div>
		{/each}
	</div>
</div>
