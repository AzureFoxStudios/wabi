<script lang="ts">
	import {
		displayEnhancementSettingsStore, setRevealAllSpoilersEnabled, setRevealAllSpoilersMinRole,
		setSpoilerAllMessagesEnabled, type RevealAllSpoilersMinRole
	} from '$lib/displayEnhancements';
	import {
		activeServerSpoilAll, activeServerUnspoilAll, serverHasSettings,
		setServerSpoilAll, setServerUnspoilAll
	} from '$lib/serverSettings';
	import { getServerUrl } from '$lib/serverUrl';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.spoilers;

	// Reactive so switching servers updates the labels live.
	$: activeServerUrl = getServerUrl();
	$: activeServerHasSettings = serverHasSettings(activeServerUrl);
	$: serverScopeMeta = `${activeServerUrl} · ${activeServerHasSettings ? 'Customized' : 'Default'} · your view only`;

	$: spoilerAllMessagesEnabled = $displayEnhancementSettingsStore.spoilerAllMessagesEnabled;
	$: revealAllSpoilersEnabled = $displayEnhancementSettingsStore.revealAllSpoilersEnabled;
	$: revealAllSpoilersMinRole = $displayEnhancementSettingsStore.revealAllSpoilersMinRole;
	$: serverSpoilAll = $activeServerSpoilAll;
	$: serverUnspoilAll = $activeServerUnspoilAll;

	function toggleSpoilerAllMessages(): void {
		setSpoilerAllMessagesEnabled(!spoilerAllMessagesEnabled);
	}

	function toggleRevealAllSpoilersAddon(): void {
		setRevealAllSpoilersEnabled(!revealAllSpoilersEnabled);
	}

	function updateRevealAllSpoilersRole(role: string): void {
		if (role === 'guest' || role === 'member' || role === 'mod' || role === 'admin' || role === 'owner') {
			setRevealAllSpoilersMinRole(role as RevealAllSpoilersMinRole);
		}
	}

	function toggleServerSpoilAll(): void {
		setServerSpoilAll(!serverSpoilAll);
	}

	function toggleServerUnspoilAll(): void {
		setServerUnspoilAll(!serverUnspoilAll);
	}
</script>

{#if localAddonControlMatches('reveal_all_spoilers')}
	<AddonRow
		id="spoiler_all_messages"
		label="🔒 Spoiler All Messages"
		description="Hide every message in every channel behind a spoiler veil — locally only, so it calms your own view without affecting anyone else. Great for very spicy servers. This is a global setting for all servers on this device."
		enabled={spoilerAllMessagesEnabled}
		badge={SECTION}
		onToggle={toggleSpoilerAllMessages}
	/>
{/if}

{#if localAddonControlMatches('reveal_all_spoilers')}
	<AddonRow
		id="reveal_all_spoilers"
		label="RevealAllSpoilers"
		description="Hold Ctrl/Cmd and click a spoiler to reveal all spoilers in that message."
		enabled={revealAllSpoilersEnabled}
		badge={SECTION}
		onToggle={toggleRevealAllSpoilersAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-field">
				<span>Minimum role</span>
				<select
					class="theme-select"
					value={revealAllSpoilersMinRole}
					on:change={(event) => updateRevealAllSpoilersRole(event.currentTarget.value)}
					disabled={!revealAllSpoilersEnabled}
				>
					<option value="guest">Guest</option>
					<option value="member">Member</option>
					<option value="mod">Moderator</option>
					<option value="admin">Admin</option>
					<option value="owner">Owner</option>
				</select>
			</label>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('server_spoiler_all')}
	<AddonRow
		id="server_spoiler_all"
		label="🔒 Spoiler All (this server)"
		description="Hide every message on this server behind a spoiler veil — your view only. Layered above individual channel/message spoilers, below the global “Spoiler All Messages” above."
		enabled={serverSpoilAll}
		badge={`${SECTION} · server`}
		meta={serverScopeMeta}
		onToggle={toggleServerSpoilAll}
	/>
{/if}

{#if localAddonControlMatches('server_unspoil_all')}
	<AddonRow
		id="server_unspoil_all"
		label="👁 Unspoil All (this server)"
		description="Force-reveal every message on this server, even on spoiler channels or individually marked spoilers (“server is king”). Overrides everything else here. Your view only."
		enabled={serverUnspoilAll}
		badge={`${SECTION} · server`}
		meta={serverScopeMeta}
		onToggle={toggleServerUnspoilAll}
	/>
{/if}
