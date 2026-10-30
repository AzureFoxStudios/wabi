<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { Message, User } from '$lib/socket';
	import SteamStatusBadge from '$lib/components/SteamStatusBadge.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	export let author: User | undefined;
	export let displayUsername: string;
	export let message: Message;
	export let deletionLabel: string | null;
	export let isPersonalPinned: boolean;
	export let groupedWithPrevious: boolean;
	export let displayEnhancementSettingsStore: any;
	export let themeStore: any;
	export let onUsernameClick: (event: MouseEvent, message: Message, author?: User) => void;
	export let onUsernameContextMenu: (event: MouseEvent, message: Message, author?: User) => void = () => {};
	export let getUserColor: (user: User | undefined, username: string) => string;
	export let getUsernameStyle: (user: User | undefined, username: string, themeState: any) => string;
	export let getTopRoleBadgeLabel: (user: User | undefined) => string | null;
	export let getTopRoleBadgeTone: (user: User | undefined) => string;
	export let shouldShowStaffTag: (user: User | undefined) => boolean;
	export let formatTime: (timestamp: number) => string;
	export let formatTimeTooltip: (timestamp: number) => string;

	/** The role word after a name (D5): a word, never a glyph, never accent or seal. */
	function roleWord(user: User | undefined, bot: boolean): { word: string; title: string } | null {
		if (bot) return { word: 'Bot', title: 'Bot account' };
		if (!user) return null;
		const tone = getTopRoleBadgeTone(user);
		const shown = shouldShowStaffTag(user) || (tone === 'owner' && Boolean(getTopRoleBadgeLabel(user)));
		if (!shown) return null;
		if (tone === 'owner') return { word: 'Admin', title: 'Community owner' };
		if (tone === 'admin') return { word: 'Admin', title: 'Community admin' };
		if (tone === 'mod') return { word: 'Mod', title: 'Moderator' };
		return null;
	}

	$: role = roleWord(author, Boolean(author?.isBot || message.isBot));
	$: pinnedWord = message.isPinned ? $_('messages.pinned_kicker') : isPersonalPinned ? $_('messages.pinned_on_device') : '';
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
					style={themeStore.uniformFontEnabled ? getUsernameStyle(author, displayUsername, themeStore) : ''}
					on:click={(event) => onUsernameClick(event, message, author)}
					on:contextmenu={(event) => onUsernameContextMenu(event, message, author)}
				>
					<ProfileName username={displayUsername} font={themeStore.uniformFontEnabled ? null : author.usernameFont} color={getUserColor(author, displayUsername)} />
				</span>
			{:else}
				<span class="username">{displayUsername}</span>
			{/if}
			{#if role}
				<span class="w-role" title={role.title}>{role.word}</span>
			{/if}
			<RoleBadge user={author} size="sm" mode="custom" />
			<SteamStatusBadge user={author} />
			{#if pinnedWord}
				<span class="message-kicker">{pinnedWord}</span>
			{/if}
			<span class="timestamp" title={formatTimeTooltip(message.timestamp)}>
				{formatTime(message.timestamp)}
			</span>
			{#if deletionLabel}
				<span class="deletion-timer" title={$_('messages.deletion.scheduled_title')}>
					<Icon name="clock" size={12} />
					{deletionLabel}
				</span>
			{/if}
		</div>
	</div>
{/if}
{#if groupedWithPrevious && deletionLabel}
	<div class="grouped-deletion-meta">
		<span class="deletion-timer" title={$_('messages.deletion.scheduled_title')}>
			<Icon name="clock" size={12} />
			{deletionLabel}
		</span>
	</div>
{/if}
