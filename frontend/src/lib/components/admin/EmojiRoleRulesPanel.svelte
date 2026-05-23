<script lang="ts">
	import { _ } from '$lib/i18n';
	import { emojis } from '$lib/emoji-store';

	type EmojiRoleRule = {
		id: number;
		channelId: string;
		messageId: string;
		emojiId: string;
		roleName: string;
		removeOnUnreact: boolean;
		enabled: boolean;
	};

	export let canManageRoles: boolean;
	export let emojiRoleRules: EmojiRoleRule[];
	export let selectedRuleChannelId: string;
	export let selectedRuleMessageId: string;
	export let selectedRuleEmojiId: string;
	export let selectedRuleRoleName: string;
	export let selectedRuleRemoveOnUnreact: boolean;
	export let gateChannels: Array<{ id: string; name: string; type: string }>;
	export let availableRoleGatePosts: Array<{ id: string; text: string }>;
	export let assignableRoleOptions: Array<{ roleName: string; displayName: string }>;
	export let getRoleLabel: (roleName?: string) => string;
	export let getChannelName: (channelId: string) => string;
	export let onRuleChannelChange: (id: string) => void;
	export let onRuleMessageChange: (id: string) => void;
	export let onRuleEmojiChange: (id: string) => void;
	export let onRuleRoleChange: (name: string) => void;
	export let onRuleRemoveOnUnreactChange: (val: boolean) => void;
	export let onAddRule: () => void;
	export let onDeleteRule: (ruleId: number) => void;
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.emoji_role_automation')}</h4>
	<div class="emoji-rule-create">
		<select value={selectedRuleChannelId} on:change={(e) => onRuleChannelChange((e.currentTarget as HTMLSelectElement).value)} class="admin-select">
			<option value="" disabled selected>{$_('admin.select.gate_channel')}</option>
			{#each gateChannels as channel (channel.id)}
				<option value={channel.id}>#{channel.name}</option>
			{/each}
		</select>
		<select value={selectedRuleMessageId} on:change={(e) => onRuleMessageChange((e.currentTarget as HTMLSelectElement).value)} class="admin-select">
			<option value="" disabled selected>{$_('admin.select.role_gate_message')}</option>
			{#each availableRoleGatePosts as post (post.id)}
				<option value={post.id}>{post.id.slice(0, 18)}... | {post.text.slice(0, 42)}</option>
			{/each}
		</select>
		<select value={selectedRuleEmojiId} on:change={(e) => onRuleEmojiChange((e.currentTarget as HTMLSelectElement).value)} class="admin-select">
			<option value="" disabled selected>{$_('admin.select.emoji')}</option>
			{#each $emojis as emoji (emoji.id)}
				<option value={emoji.id}>{emoji.name}</option>
			{/each}
		</select>
		<select value={selectedRuleRoleName} on:change={(e) => onRuleRoleChange((e.currentTarget as HTMLSelectElement).value)} class="admin-select">
			<option value="" disabled selected>{$_('admin.select.role')}</option>
			{#each assignableRoleOptions as role (role.roleName)}
				<option value={role.roleName}>{getRoleLabel(role.roleName)}</option>
			{/each}
		</select>
		<label class="rule-checkbox">
			<input type="checkbox" checked={selectedRuleRemoveOnUnreact} on:change={(e) => onRuleRemoveOnUnreactChange((e.currentTarget as HTMLInputElement).checked)} />
			{$_('admin.emoji_rules.remove_on_unreact')}
		</label>
		<button class="admin-btn" on:click={onAddRule}>{$_('admin.emoji_rules.add_rule')}</button>
	</div>
	<div class="emoji-rule-list">
		{#each emojiRoleRules as rule (rule.id)}
			<div class="emoji-rule-item">
				<span>#{getChannelName(rule.channelId)} | {rule.messageId.slice(0, 18)}... | {rule.emojiId} -> {getRoleLabel(rule.roleName)}{rule.removeOnUnreact ? ` (${$_('admin.emoji_rules.reversible')})` : ''}</span>
				<button class="admin-btn danger" on:click={() => onDeleteRule(rule.id)}>{$_('admin.actions.delete')}</button>
			</div>
		{:else}
			<div class="admin-empty">{$_('admin.emoji_rules.empty')}</div>
		{/each}
	</div>
</div>
