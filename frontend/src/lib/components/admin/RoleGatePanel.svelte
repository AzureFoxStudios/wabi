<script lang="ts">
	import { _ } from '$lib/i18n';

	export let canManageRoles: boolean;
	export let roleGateChannelId: string;
	export let roleGateTitle: string;
	export let roleGateDescription: string;
	export let roleGatePersist: boolean;
	export let gateChannels: Array<{ id: string; name: string; type: string }>;
	export let onChannelChange: (id: string) => void;
	export let onTitleInput: (value: string) => void;
	export let onDescriptionInput: (value: string) => void;
	export let onPersistChange: (val: boolean) => void;
	export let onCreatePost: () => void;
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.role_gate_posts')}</h4>
	<div class="emoji-rule-create">
		<select value={roleGateChannelId} on:change={(e) => onChannelChange((e.currentTarget as HTMLSelectElement).value)} class="admin-select">
			<option value="" disabled selected>{$_('admin.select.channel')}</option>
			{#each gateChannels as channel (channel.id)}
				<option value={channel.id}>#{channel.name}</option>
			{/each}
		</select>
		<input
			class="role-input"
			placeholder={$_('admin.placeholders.role_gate_title')}
			value={roleGateTitle}
			on:input={(e) => onTitleInput((e.currentTarget as HTMLInputElement).value)}
		/>
		<input
			class="role-input"
			placeholder={$_('admin.placeholders.role_gate_description')}
			value={roleGateDescription}
			on:input={(e) => onDescriptionInput((e.currentTarget as HTMLInputElement).value)}
		/>
		<label class="rule-checkbox">
			<input type="checkbox" checked={roleGatePersist} on:change={(e) => onPersistChange((e.currentTarget as HTMLInputElement).checked)} />
			{$_('admin.role_gate.persist')}
		</label>
		<button class="admin-btn" on:click={onCreatePost}>{$_('admin.role_gate.create')}</button>
	</div>
	<div class="admin_empty">{$_('admin.role_gate.note')}</div>
</div>
