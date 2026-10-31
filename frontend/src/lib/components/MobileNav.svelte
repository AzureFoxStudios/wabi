<!--
	Root navigation of the phone shell (design contract §8.12, §8.13): five equal destinations,
	Chat · Channels · DMs · Activity · You. Under 600px it is the bottom nav (58px plus the home
	indicator's inset); from 600 to 768px the same buttons stand in a 72px left rail, icon over
	label (styles/surfaces/mobile.css owns both layouts). Toasts anchor above the bottom nav only.

	- Icons 22px, labels sans 500 11px in --w-mute. The current destination carries
	  aria-current="page": icon --w-sig, label --w-text and a 24×2 --w-sig mark on the edge that
	  meets the stage (the nav's top edge; the rail's inner edge).
	- Badges are the kit's ink `w-badge--sm` with a 2px ring in the nav's surface; the icon wrapper
	  never clips them. The counts are in each button's accessible name; the numerals are hidden.
	- You shows the person's avatar stamp with their presence dot.
	MainLayout decides which destination is current (mobileNavDestination) and what a tap does.
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import { currentUser } from '$lib/socket';
	import { inkFor } from '$lib/theme/identity';
	import { mediaUrl } from '$lib/mediaUrl';
	import { isNavRail } from '$lib/layoutStoreStates';
	import { _ } from '$lib/i18n';
	import {
		mobileNavItems,
		type MobileNavCounts,
		type MobileNavDestination
	} from '$lib/mobileShellModel';

	interface Props {
		/** The destination on screen, or null when the stage shows a place the nav does not name. */
		active: MobileNavDestination | null;
		counts: MobileNavCounts;
		onselect: (destination: MobileNavDestination) => void;
	}

	let { active, counts, onselect }: Props = $props();

	/** A label from the locale pack, or English when the key is missing. */
	function word(key: string, fallback: string, values?: Record<string, number>): string {
		const text = $_(key, values ? { values } : undefined);
		return text && text !== key ? text : fallback;
	}

	const PRESENCE_WORDS = { active: 'Online', away: 'Away', busy: 'Do not disturb', offline: 'Offline' } as const;
	type Presence = keyof typeof PRESENCE_WORDS;

	const me = $derived($currentUser);
	const presence = $derived<Presence>(
		me?.status && me.status in PRESENCE_WORDS ? (me.status as Presence) : 'active'
	);
	const initial = $derived(((me?.username || '').trim().charAt(0) || 'Y').toUpperCase());
	const ink = $derived($inkFor(me?.color));

	const items = $derived(
		mobileNavItems(active, counts, {
			chat: word('shell.mobile.chat', 'Chat'),
			channels: word('shell.mobile.channels', 'Channels'),
			dms: word('shell.mobile.dms', 'DMs'),
			activity: word('shell.mobile.activity', 'Activity'),
			you: word('shell.mobile.you', 'You'),
			activityNeedsYou: (count) =>
				count === 1
					? word('shell.mobile.activity_unread_one', `Activity, ${count} needs you`, { count })
					: word('shell.mobile.activity_unread_many', `Activity, ${count} need you`, { count }),
			youDetail: me ? PRESENCE_WORDS[presence] : undefined
		})
	);
</script>

<!-- Toasts rise above the bottom nav; the rail stands beside the stage, so it is no anchor. -->
<nav class="mobile-bottom-nav" aria-label={word('shell.mobile.nav_label', 'Main')} data-toast-anchor={$isNavRail ? undefined : ''}>
	{#each items as item (item.id)}
		<button
			type="button"
			class="mnav-tab"
			data-nav={item.id}
			aria-current={item.current ? 'page' : undefined}
			aria-label={item.ariaLabel}
			onclick={() => onselect(item.id)}
		>
			<span class="mnav-icon" aria-hidden="true">
				{#if item.icon}
					<Icon name={item.icon} size={22} />
				{:else}
					<span class="mnav-avatar" style={ink}>
						{#if me?.profilePicture}
							<ProfileMedia src={mediaUrl(me.profilePicture)} alt="" decorative class="mnav-avatar__picture" />
						{:else}
							<span class="mnav-avatar__initial">{initial}</span>
						{/if}
						<span class="mnav-presence mnav-presence--{presence}"></span>
					</span>
				{/if}
				{#if item.badge}
					<span class="w-badge w-badge--sm w-badge--ring mnav-badge">{item.badge}</span>
				{/if}
			</span>
			<span class="mnav-label" aria-hidden="true">{item.label}</span>
		</button>
	{/each}
</nav>
