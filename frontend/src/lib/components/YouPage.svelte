<!--
	You (design contract §8.12): a page in the phone stage, reached from the nav's You tab; the nav
	stays. One 52px bar (it is the first bar, so it takes the top safe area), the profile header
	(avatar 56 with presence, name in serif, @handle in mono, a presence menu), then 52px rows:
	Profile, Notifications, Appearance, Privacy & security, Language (the current language, a
	list sheet to change it), Servers (the switcher), All settings. Sign out is a quiet row after a
	hairline, with a confirm; never danger red.
	MainLayout owns what the rows open (Settings pages, the server switcher) and the sign-out.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { currentUser } from '$lib/socket';
	import { currentSavedServer } from '$lib/savedServers';
	import { inkFor } from '$lib/theme/identity';
	import { mediaUrl } from '$lib/mediaUrl';
	import { brandName } from '$lib/branding';
	import { confirmAction } from '$lib/confirm';
	import { getStoredPresence, maskedStatus, selectPresence, type PresenceState } from '$lib/presenceControl';
	import { clearActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import { _, currentLocale, getAvailableLocales, setAppLocale } from '$lib/i18n';
	import type { YouSettingsPage } from '$lib/mobileShellModel';

	interface Props {
		/** Open Settings on a page, or on its list of pages (null). */
		onopensettings: (page: YouSettingsPage | null) => void;
		onopenservers: () => void;
		/** Called after the person confirmed. */
		onsignout: () => void;
	}

	let { onopensettings, onopenservers, onsignout }: Props = $props();

	/** A label from the locale pack, or English when the key is missing. */
	function word(key: string, fallback: string, values?: Record<string, string>): string {
		const text = $_(key, values ? { values } : undefined);
		return text && text !== key ? text : fallback;
	}

	const PRESENCE_OPTIONS: Array<{ value: PresenceState; label: string }> = [
		{ value: 'active', label: 'Online' },
		{ value: 'away', label: 'Away' },
		{ value: 'busy', label: 'Do not disturb' },
		{ value: 'invisible', label: 'Invisible' }
	];

	let title = $state<HTMLElement | null>(null);
	let presence = $state<PresenceState>(getStoredPresence());

	const me = $derived($currentUser);
	const displayName = $derived.by(() => {
		const raw = (me?.username || '').trim();
		return raw && !/^unknown( user)?$/i.test(raw) ? raw : 'Guest';
	});
	const handle = $derived.by(() => {
		const raw = (me?.handle || '').trim();
		return raw && raw.toLowerCase() !== 'unknown' ? raw : displayName;
	});
	const initial = $derived((displayName.charAt(0) || 'G').toUpperCase());
	const ink = $derived($inkFor(me?.color));
	// The dot shows what everyone else sees (invisible reads as offline), like the sidebar foot.
	const dot = $derived(presence === 'active' && !me?.status ? 'active' : maskedStatus(presence));
	const presenceLabel = $derived(PRESENCE_OPTIONS.find((option) => option.value === presence)?.label ?? 'Online');
	const presenceItems = $derived<MenuEntry[]>(
		PRESENCE_OPTIONS.map((option) => ({
			id: `presence-${option.value}`,
			label: option.label,
			role: 'menuitemradio',
			checked: presence === option.value,
			onSelect: () => changePresence(option.value)
		}))
	);

	const languages = getAvailableLocales();
	const languageLabel = $derived(languages.find((entry) => entry.code === $currentLocale)?.label ?? 'English');
	const languageItems = $derived<MenuEntry[]>(
		languages.map((entry) => ({
			id: `language-${entry.code}`,
			label: entry.label,
			role: 'menuitemradio',
			checked: entry.code === ($currentLocale || 'en'),
			keepCase: true,
			onSelect: () => void setAppLocale(entry.code)
		}))
	);

	const communityName = $derived($currentSavedServer?.effectiveName || brandName);

	interface Row {
		id: string;
		icon: IconName;
		label: string;
		run: () => void;
	}
	const rows = $derived<Row[]>([
		{ id: 'profile', icon: 'user', label: word('settings.tabs.profile', 'Profile'), run: () => onopensettings('profile') },
		{ id: 'notifications', icon: 'bell', label: word('settings.tabs.notifications', 'Notifications'), run: () => onopensettings('notifications') },
		{ id: 'appearance', icon: 'palette', label: word('settings.tabs.appearance', 'Appearance'), run: () => onopensettings('appearance') },
		{ id: 'privacy', icon: 'shield', label: word('settings.tabs.privacy', 'Privacy & security'), run: () => onopensettings('privacy') }
	]);
	const languageWord = $derived(word('settings.language', 'Language'));
	const serversWord = $derived(word('shell.you.servers', 'Servers'));
	const allSettingsWord = $derived(word('shell.you.all_settings', 'All settings'));
	const signOutWord = $derived(word('settings.tabs.logout', 'Sign out'));
	const youWord = $derived(word('shell.mobile.you', 'You'));

	function changePresence(next: PresenceState): void {
		presence = next;
		clearActiveCustomStatusPreset();
		selectPresence(next);
	}

	async function signOut(): Promise<void> {
		const confirmed = await confirmAction({
			title: 'Sign out?',
			body: `This device will no longer be signed in to ${communityName}.`,
			confirm: signOutWord
		});
		if (confirmed) onsignout();
	}

	// The page replaces what the stage showed: move the reading position to its title.
	onMount(() => title?.focus({ preventScroll: true }));
</script>

<section class="you-page" aria-labelledby="you-page-title">
	<header class="you-bar">
		<h1 class="you-bar__title" id="you-page-title" tabindex="-1" bind:this={title}>{youWord}</h1>
	</header>

	<div class="you-scroll">
		<div class="you-profile">
			<span class="you-avatar" style={ink} aria-hidden="true">
				{#if me?.profilePicture}
					<ProfileMedia src={mediaUrl(me.profilePicture)} alt="" decorative class="you-avatar__picture" />
				{:else}
					<span class="you-avatar__initial">{initial}</span>
				{/if}
				<span class="you-dot you-avatar__dot you-dot--{dot}"></span>
			</span>
			<div class="you-id">
				<p class="you-name"><ProfileName username={displayName} font={me?.usernameFont} /></p>
				<p class="you-handle">@{handle}</p>
				<Menu
					class="you-presence"
					label="Presence"
					heading="Presence"
					triggerLabel={`Presence: ${presenceLabel}. Change presence`}
					items={presenceItems}
				>
					<span class="you-dot you-dot--{dot}" aria-hidden="true"></span>
					<span>{presenceLabel}</span>
					<Icon name="chevDown" size={14} />
				</Menu>
			</div>
		</div>

		<ul class="you-rows" role="list">
			{#each rows as row (row.id)}
				<li>
					<button type="button" class="you-row" onclick={row.run}>
						<Icon name={row.icon} size={18} />
						<span class="you-row__label">{row.label}</span>
						<Icon name="chevRight" size={16} class="you-row__chev" />
					</button>
				</li>
			{/each}
			<li>
				<Menu
					class="you-row"
					label={languageWord}
					heading={languageWord}
					triggerLabel={`${languageWord}: ${languageLabel}`}
					items={languageItems}
				>
					<Icon name="globe" size={18} />
					<span class="you-row__label">{languageWord}</span>
					<span class="you-row__value">{languageLabel}</span>
					<Icon name="chevRight" size={16} class="you-row__chev" />
				</Menu>
			</li>
			<li>
				<button type="button" class="you-row" aria-label={`${serversWord}: ${communityName}`} onclick={onopenservers}>
					<Icon name="server" size={18} />
					<span class="you-row__label">{serversWord}</span>
					<span class="you-row__value">{communityName}</span>
					<Icon name="chevRight" size={16} class="you-row__chev" />
				</button>
			</li>
			<li>
				<button type="button" class="you-row" onclick={() => onopensettings(null)}>
					<Icon name="gear" size={18} />
					<span class="you-row__label">{allSettingsWord}</span>
					<Icon name="chevRight" size={16} class="you-row__chev" />
				</button>
			</li>
		</ul>

		<div class="you-foot">
			<button type="button" class="you-row you-row--quiet" onclick={signOut}>
				<Icon name="logout" size={18} />
				<span class="you-row__label">{signOutWord}</span>
			</button>
		</div>
	</div>
</section>

<style>
	.you-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--w-bg);
		color: var(--w-text);
	}

	/* The first bar on screen takes the top safe area (§8.12). */
	.you-bar {
		flex: none;
		display: flex;
		align-items: center;
		box-sizing: border-box;
		height: calc(52px + env(safe-area-inset-top, 0px));
		padding: env(safe-area-inset-top, 0px) 16px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	/* By id: the stage's page-title rule (surfaces/headings.css) sizes every h1 at 28px; the phone
	   bar's title is 20/26 (§8.12). */
	#you-page-title {
		margin: 0;
		font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif);
		letter-spacing: 0;
		color: var(--w-text);
	}
	#you-page-title:focus {
		outline: none;
	}
	#you-page-title:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	.you-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 0 24px;
	}

	/* ---------- profile header ---------- */
	.you-profile {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 24px 16px 20px;
	}
	.you-avatar {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		border-radius: var(--w-avr, 50%);
		background: var(--disc, var(--w-raise));
		color: var(--on, var(--w-text));
		font: 600 calc(24px * var(--w-fs)) / 1 var(--w-serif);
	}
	.you-avatar :global(.you-avatar__picture) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border-radius: var(--w-avr, 50%);
		object-fit: cover;
	}
	/* Presence: a dot plus the word beside it (§5.3); offline is a hollow ring. */
	.you-dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: var(--w-avr, 50%);
		background: var(--w-online);
	}
	.you-dot--away {
		background: var(--w-warn);
	}
	.you-dot--busy {
		background: var(--w-danger);
	}
	.you-dot--offline {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--w-faint);
	}
	.you-avatar__dot {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 12px;
		height: 12px;
		box-shadow: 0 0 0 2px var(--w-bg);
	}
	.you-avatar__dot.you-dot--offline {
		background: var(--w-bg);
		box-shadow:
			inset 0 0 0 1.5px var(--w-faint),
			0 0 0 2px var(--w-bg);
	}
	.you-id {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
	}
	.you-name {
		max-width: 100%;
		margin: 0;
		overflow: hidden;
		font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif);
		color: var(--w-text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.you-handle {
		max-width: 100%;
		margin: 2px 0 0;
		overflow: hidden;
		font: var(--w-t-mono);
		color: var(--w-faint);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* A quiet key: the presence word with its dot; 44px to touch. */
	.you-id :global(.you-presence) {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		margin: 8px 0 0 -8px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-small);
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease);
	}
	.you-id :global(.you-presence)::before {
		content: '';
		position: absolute;
		inset: -8px 0;
	}
	.you-id :global(.you-presence:hover) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
		color: var(--w-text);
	}

	/* ---------- rows: 52px, icon 18, chevron 16 ---------- */
	.you-rows {
		margin: 0;
		padding: 4px 0;
		list-style: none;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.you-page :global(.you-row) {
		display: flex;
		align-items: center;
		gap: 14px;
		box-sizing: border-box;
		width: calc(100% - 16px);
		height: 52px;
		margin: 0 8px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-text);
		font: var(--w-t-label);
		font-weight: 400;
		text-align: start;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease);
	}
	.you-page :global(.you-row > svg) {
		flex: none;
		color: var(--w-mute);
	}
	.you-page :global(.you-row:hover) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	.you-page :global(.you-row:focus-visible),
	.you-id :global(.you-presence:focus-visible) {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.you-row__label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.you-row__value {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 50%;
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-small);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.you-page :global(.you-row > .you-row__chev) {
		color: var(--w-faint);
	}

	.you-foot {
		margin: 8px 16px 0;
		padding-top: 8px;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.you-foot .you-row--quiet {
		width: calc(100% + 16px);
		margin: 0 -8px;
		color: var(--w-mute);
	}
	.you-foot .you-row--quiet:hover {
		color: var(--w-text);
	}

	/* High Contrast: rings instead of fills (§5.2). */
	:global(:root[data-char='contrast']) .you-page :global(.you-row:hover),
	:global(:root[data-char='contrast']) .you-id :global(.you-presence:hover) {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}

	@media (prefers-reduced-motion: reduce) {
		.you-page :global(.you-row),
		.you-id :global(.you-presence) {
			transition: none;
		}
	}
	:global(:root[data-motion='reduce']) .you-page :global(.you-row),
	:global(:root[data-motion='reduce']) .you-id :global(.you-presence) {
		transition: none;
	}
</style>
