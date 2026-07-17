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
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

	// Reactive so switching servers updates the labels live.
	$: activeServerUrl = getServerUrl();
	$: activeServerHasSettings = serverHasSettings(activeServerUrl);

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

{#if localAddonControlMatches('reveal_all_spoilers') || localAddonControlMatches('server_spoiler_all') || localAddonControlMatches('server_unspoil_all')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('spoilers')}
		aria-controls="addon-section-spoilers"
		on:click={() => toggleAddonSection('spoilers')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">Spoilers</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('spoilers')}</span>
	</button>
		{#if isAddonSectionOpen('spoilers')}
	<div class="addon-accordion-body" id="addon-section-spoilers">
		{#if localAddonControlMatches('reveal_all_spoilers')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">🔒 Spoiler All Messages</span>
					<span class="setting-description">
						Hide every message in every channel behind a spoiler veil — locally only, so it
						calms your own view without affecting anyone else. Great for very spicy servers.
						<b>This is a global setting for all servers on this device.</b>
					</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={spoilerAllMessagesEnabled} on:click={toggleSpoilerAllMessages}>
						{spoilerAllMessagesEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('reveal_all_spoilers')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">RevealAllSpoilers</span>
					<span class="setting-description">Hold Ctrl/Cmd and click a spoiler to reveal all spoilers in that message.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={revealAllSpoilersEnabled} on:click={toggleRevealAllSpoilersAddon}>
						{revealAllSpoilersEnabled ? 'ON' : 'OFF'}
					</button>
					<label class="upload-limit-row split-chunk-size-row">
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
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('server_spoiler_all') || localAddonControlMatches('server_unspoil_all')}
			<div class="server-scope-panel" class:has-settings={activeServerHasSettings}>
				<div class="server-scope-header">
					<span class="server-scope-icon" aria-hidden="true">🖥️</span>
					<div class="server-scope-meta">
						<span class="server-scope-title">Applies to this server only</span>
						<code class="server-scope-url">{activeServerUrl}</code>
					</div>
					{#if activeServerHasSettings}
						<span class="server-scope-badge">Customized</span>
					{:else}
						<span class="server-scope-badge server-scope-badge-default">Default</span>
					{/if}
				</div>
				<p class="server-scope-hint">
					These only change <b>your</b> view on this community. Switch servers and these
					reset to that server's own settings — they never affect anyone else.
				</p>

				{#if localAddonControlMatches('server_spoiler_all')}
					<div class="setting-item-full setting-item-nested">
						<div class="setting-info">
							<span class="setting-label">🔒 Spoiler All (this server)</span>
							<span class="setting-description">
								Hide every message on this server behind a spoiler veil — your view only.
								Layered above individual channel/message spoilers, below the global
								"Spoiler All Messages" above.
							</span>
						</div>
						<div class="settings-row-actions">
							<button class="toggle-btn" class:active={serverSpoilAll} on:click={toggleServerSpoilAll}>
								{serverSpoilAll ? 'ON' : 'OFF'}
							</button>
						</div>
					</div>
				{/if}

				{#if localAddonControlMatches('server_unspoil_all')}
					<div class="setting-item-full setting-item-nested">
						<div class="setting-info">
							<span class="setting-label">👁 Unspoil All (this server)</span>
							<span class="setting-description">
								Force-reveal every message on this server, even on spoiler channels or
								individually marked spoilers ("server is king"). Overrides everything else
								here. Your view only.
							</span>
						</div>
						<div class="settings-row-actions">
							<button class="toggle-btn" class:active={serverUnspoilAll} on:click={toggleServerUnspoilAll}>
								{serverUnspoilAll ? 'ON' : 'OFF'}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
