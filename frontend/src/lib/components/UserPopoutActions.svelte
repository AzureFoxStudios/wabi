<script lang="ts">
	import { _ } from '$lib/i18n';
	import { showToast } from '$lib/toast';
	import { isDeafened, isInCall, isMuted } from '$lib/callingStateStores';
	import { toggleDeafen, toggleMute } from '$lib/calling';
	import type { User } from '$lib/socket';

	export let isOwnProfile = false;
	export let profileExpanded = false;
	export let localNicknamesEnabled = false;
	export let localNickname = '';
	export let user: User | null = null;
	export let onOpenDM: () => void = () => {};
	export let onOpenFullProfile: () => void = () => {};
	export let onOpenSettings: () => void = () => {};
	export let onVoiceCall: () => void = () => {};
	export let onVideoCall: () => void = () => {};
	export let onScreenShare: () => void = () => {};
	export let onSetLocalNickname: () => void = () => {};
	export let onClearLocalNickname: () => void = () => {};

	async function handleShareProfile() {
		if (!user) return;
		const handle = (user.handle || '').trim();
		const shareText = handle && handle.toLowerCase() !== 'unknown' ? `@${handle}` : `@${user.username}`;
		try {
			await navigator.clipboard.writeText(shareText);
		} catch {
			// no-op
		}
		showToast('Copied!', 'info', 1200);
	}
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

{#if isOwnProfile}
	<div class="voice-actions">
		<button
			class="voice-btn"
			class:active={$isMuted}
			on:click={() => toggleMute()}
			disabled={!$isInCall}
			title={$isMuted ? 'Unmute' : $_('user.popout.mute')}
		>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
				<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
				<line x1="12" y1="19" x2="12" y2="23"/>
				<line x1="8" y1="23" x2="16" y2="23"/>
			</svg>
		</button>
		<button
			class="voice-btn"
			class:active={$isDeafened}
			on:click={() => toggleDeafen()}
			disabled={!$isInCall}
			title={$isDeafened ? 'Undeafen' : $_('user.popout.deafen')}
		>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
				<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
				<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
			</svg>
		</button>
		<button class="voice-btn" on:click={onOpenSettings} title={$_('user.popout.settings')}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3"/>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
			</svg>
		</button>
	</div>
{/if}

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

{#if (isOwnProfile || profileExpanded) && user}
	<button class="share-btn" on:click={handleShareProfile} title={$_('user.popout.share_profile')}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="18" cy="5" r="3"/>
			<circle cx="6" cy="12" r="3"/>
			<circle cx="18" cy="19" r="3"/>
			<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
			<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
		</svg>
		{$_('user.popout.share_profile')}
	</button>
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
</div>
