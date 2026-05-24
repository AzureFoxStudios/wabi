<script lang="ts">
	import { _ } from '$lib/i18n';

	export let isOwnProfile = false;
	export let profileExpanded = false;
	export let localNicknamesEnabled = false;
	export let localNickname = '';
	export let onOpenDM: () => void = () => {};
	export let onOpenFullProfile: () => void = () => {};
	export let onVoiceCall: () => void = () => {};
	export let onVideoCall: () => void = () => {};
	export let onScreenShare: () => void = () => {};
	export let onSetLocalNickname: () => void = () => {};
	export let onClearLocalNickname: () => void = () => {};
	export let onCopyUserId: () => void = () => {};
</script>

<div class="actions">
	{#if !isOwnProfile}
		<button class="action-btn primary" on:click={onOpenDM}>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
				<path d="M4.79805 3C3.80445 3 2.99805 3.8055 2.99805 4.8V15.6C2.99805 16.5936 3.80445 17.4 4.79805 17.4H7.49805V21L11.098 17.4H19.198C20.1925 17.4 20.998 16.5936 20.998 15.6V4.8C20.998 3.8055 20.1925 3 19.198 3H4.79805Z"/>
			</svg>
			{$_('user.popout.message')}
		</button>
	{/if}
	<button class="action-btn secondary" on:click={onOpenFullProfile}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z"/>
		</svg>
		{isOwnProfile ? $_('user.popout.edit_profile') : profileExpanded ? 'Hide details' : $_('user.popout.view_full_profile')}
	</button>
</div>

{#if !isOwnProfile}
	<div class="call-actions">
		<button class="call-btn voice-call" on:click={onVoiceCall} title={$_('user.voice_call')}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
				<path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
			</svg>
			{$_('user.voice_call')}
		</button>
		<button class="call-btn video-call" on:click={onVideoCall} title={$_('user.video_call')}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
				<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
			</svg>
			{$_('user.video_call')}
		</button>
		<button class="call-btn screen-share" on:click={onScreenShare} title={$_('user.screen_share')}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
				<path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
			</svg>
			{$_('user.screen_share')}
		</button>
	</div>
{/if}

<div class="context-actions">
	{#if !isOwnProfile && localNicknamesEnabled}
		<button class="context-btn" on:click={onSetLocalNickname}>
			Set Local Nickname
		</button>
		{#if localNickname}
			<button class="context-btn danger" on:click={onClearLocalNickname}>
				Clear Local Nickname
			</button>
		{/if}
	{/if}
	<button class="context-btn" on:click={onCopyUserId}>
		{$_('user.popout.copy_user_id')}
	</button>
</div>
