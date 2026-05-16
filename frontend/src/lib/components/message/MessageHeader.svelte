<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { Message, User } from '$lib/socket';

	export let author: User | undefined;
	export let displayUsername: string;
	export let message: Message;
	export let deletionLabel: string | null;
	export let isPersonalPinned: boolean;
	export let groupedWithPrevious: boolean;
	export let displayEnhancementSettingsStore: any;
	export let themeStore: any;
	export let onUsernameClick: (event: MouseEvent, message: Message, author?: User) => void;
	export let getUserColor: (user: User | undefined, username: string) => string;
	export let getUsernameStyle: (user: User | undefined, username: string, themeState: any) => string;
	export let getTopRoleBadgeLabel: (user: User | undefined) => string | null;
	export let getTopRoleBadgeTone: (user: User | undefined) => string;
	export let shouldShowStaffTag: (user: User | undefined) => boolean;
	export let formatTime: (timestamp: number) => string;
	export let formatTimeTooltip: (timestamp: number) => string;
</script>

{#if !groupedWithPrevious}
	<div class="message-header">
		<div class="header-left">
			{#if author}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<span
					class="username"
					class:clickable-username={displayEnhancementSettingsStore.clickableMentionsEnabled}
					style="color: {getUserColor(author, displayUsername)}; {getUsernameStyle(author, displayUsername, themeStore)}"
					on:click={(event) => onUsernameClick(event, message, author)}
				>
					{displayUsername}
				</span>
			{:else}
				<span class="username">{displayUsername}</span>
			{/if}
			{#if getTopRoleBadgeLabel(author)}
				<span class={`role-inline-badge tone-${getTopRoleBadgeTone(author)}`}>{getTopRoleBadgeLabel(author)}</span>
			{/if}
			{#if shouldShowStaffTag(author)}
				<span class="staff-inline-tag">Staff</span>
			{/if}
			<span class="timestamp" title={formatTimeTooltip(message.timestamp)}>
				{formatTime(message.timestamp)}
			</span>
			{#if deletionLabel}
				<span class="deletion-timer" title={$_('messages.deletion.scheduled_title')}>
					{deletionLabel}
				</span>
			{/if}
			{#if message.isPinned}
				<span class="pin-badge" title={$_('messages.pinned_title')}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg></span>
			{/if}
			{#if displayEnhancementSettingsStore.personalPinsEnabled && isPersonalPinned}
				<span class="local-pin-badge" title={$_('context_menu.pin_local_message')}>Local Pin</span>
			{/if}
			{#if message.isEdited}
				<span class="edited-badge" title={$_('messages.edited_title')}>({$_('messages.edited')})</span>
			{/if}
		</div>
	</div>
{:else}
	<!-- Compact-mode inline header for continuation messages (hidden in cozy) -->
	<div class="message-header compact-only-header">
		<div class="header-left">
			<span class="timestamp" title={formatTimeTooltip(message.timestamp)}>
				{formatTime(message.timestamp)}
			</span>
			{#if author}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<span
					class="username"
					class:clickable-username={displayEnhancementSettingsStore.clickableMentionsEnabled}
					style="color: {getUserColor(author, displayUsername)}; {getUsernameStyle(author, displayUsername, themeStore)}"
					on:click={(event) => onUsernameClick(event, message, author)}
				>
					{displayUsername}
				</span>
			{:else}
				<span class="username">{displayUsername}</span>
			{/if}
			{#if getTopRoleBadgeLabel(author)}
				<span class={`role-inline-badge tone-${getTopRoleBadgeTone(author)}`}>{getTopRoleBadgeLabel(author)}</span>
			{/if}
			{#if shouldShowStaffTag(author)}
				<span class="staff-inline-tag">Staff</span>
			{/if}
		</div>
	</div>
{/if}
{#if groupedWithPrevious && deletionLabel}
	<div class="grouped-deletion-meta">
		<span class="deletion-timer" title={$_('messages.deletion.scheduled_title')}>
			{deletionLabel}
		</span>
	</div>
{/if}
