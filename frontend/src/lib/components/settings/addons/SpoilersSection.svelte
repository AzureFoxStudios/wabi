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
	import Select from '../../ui/Select.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.spoilers;

	// Reactive so switching servers updates the labels live.
	$: activeServerUrl = getServerUrl();
	$: activeServerHasSettings = serverHasSettings(activeServerUrl);
	$: serverScopeMeta = `${activeServerUrl}${activeServerHasSettings ? ' · changed from the default' : ''}`;

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
		label="Hide every message behind a spoiler"
		description="Every message on every server waits behind a spoiler until you reveal it. Only your view changes."
		enabled={spoilerAllMessagesEnabled}
		badge={SECTION}
		onToggle={toggleSpoilerAllMessages}
	/>
{/if}

{#if localAddonControlMatches('reveal_all_spoilers')}
	<AddonRow
		id="reveal_all_spoilers"
		label="Reveal all spoilers at once"
		description="Hold Ctrl (⌘ on Mac) and click a spoiler to reveal every spoiler in that message."
		enabled={revealAllSpoilersEnabled}
		badge={SECTION}
		onToggle={toggleRevealAllSpoilersAddon}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">Minimum role</span>
				<Select ariaLabel="Minimum role" options={[{ value: 'guest', label: 'Guest' }, { value: 'member', label: 'Member' }, { value: 'mod', label: 'Moderator' }, { value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' }]} value={revealAllSpoilersMinRole} onchange={(value) => updateRevealAllSpoilersRole(value)} disabled={!revealAllSpoilersEnabled} />
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('server_spoiler_all')}
	<AddonRow
		id="server_spoiler_all"
		label="Hide this server behind spoilers"
		description="Every message on this server waits behind a spoiler. Only your view changes."
		enabled={serverSpoilAll}
		badge={`${SECTION} · server`}
		meta={serverScopeMeta}
		onToggle={toggleServerSpoilAll}
	/>
{/if}

{#if localAddonControlMatches('server_unspoil_all')}
	<AddonRow
		id="server_unspoil_all"
		label="Reveal everything on this server"
		description="Shows every spoiler on this server, whatever the channel or message says. Overrides the choices above. Only your view changes."
		enabled={serverUnspoilAll}
		badge={`${SECTION} · server`}
		meta={serverScopeMeta}
		onToggle={toggleServerUnspoilAll}
	/>
{/if}
