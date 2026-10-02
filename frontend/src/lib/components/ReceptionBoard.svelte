<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	let { mode = 'welcome' }: { mode?: 'welcome' | 'desk' } = $props();
	const dispatch = createEventDispatcher<{ openRoom: void }>();
	import { switchChannel, channels, currentUser } from '$lib/socket';
	import { serverSettings, toggleServerMutedChannelId, getActiveServerUrl } from '$lib/serverSettings';
	import { communityRulesAvailable, communityRulesOpen } from '$lib/communityRulesUi';
	import { currentSavedServer } from '$lib/savedServers';
	import { activeServerUrl, getServerUrl } from '$lib/serverUrl';
	import { authSessionGeneration, getAuthToken } from '$lib/authSession';
	import { desktopServerRailPinned } from '$lib/serverNavigationPreference';
	import { channelAccessPolicyVersion } from '$lib/channelAccessPolicyVersion';
	import { resolveServerAssetUrl } from '$lib/savedServerUtils';

	type CommunityRole = { id: string; name: string; description: string };
	type GuidedRoom = { id: string; name: string; description?: string | null; roleId: string };
	let roles: CommunityRole[] = $state([]);
	let myRoleIds: string[] = $state([]);
	let guidedRooms: GuidedRoom[] = $state([]);
	let canChooseRoles = $state(false);
	let loadingGuide = $state(true);
	let guideError = $state('');
	let changingRole = $state('');
	let editingChoices = $state(false);
	let rulesText = $state('');
	let motionAllowed = $state(false);
	let motionPaused = $state(false);
	let pageVisible = $state(true);
	let movingImageFailed = $state(false);
	let serverIconFailed = $state(false);
	const movingBackground = $derived(resolveServerAssetUrl($activeServerUrl, $currentSavedServer?.frontendMetadata?.deskBackgroundUrl));
	const stillBackground = $derived(resolveServerAssetUrl($activeServerUrl, $currentSavedServer?.frontendMetadata?.deskStillUrl) || $currentSavedServer?.effectiveBannerUrl || null);
	const displayBackground = $derived(movingBackground && motionAllowed && pageVisible && !motionPaused && !movingImageFailed ? movingBackground : stillBackground);
	const motionPreferenceKey = $derived(`wabi:desk-motion:${encodeURIComponent($activeServerUrl)}:${$currentUser?.dbUserId ?? $currentUser?.id ?? 'guest'}`);
	onMount(() => {
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		const update = () => { motionAllowed = !media.matches; };
		update();
		media.addEventListener('change', update);
		const visibility = () => { pageVisible = !document.hidden; };
		visibility(); document.addEventListener('visibilitychange', visibility);
		return () => { media.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); };
	});
	$effect(() => { void movingBackground; movingImageFailed = false; });
	$effect(() => { const key = motionPreferenceKey; try { motionPaused = localStorage.getItem(key) === 'paused'; } catch { motionPaused = false; } });
	function toggleMotion() {
		motionPaused = !motionPaused;
		try { localStorage.setItem(motionPreferenceKey, motionPaused ? 'paused' : 'playing'); } catch { /* local preference unavailable */ }
	}

	const generalChannel = $derived($channels.find((ch) => ch.type === 'text' && ch.name === 'general'));
	const firstRoom = $derived($channels.find(ch => ch.id === $currentSavedServer?.frontendMetadata?.deskStartingRoomId && ch.type === 'text') ?? generalChannel ?? $channels.find(ch => !['dm', 'group', 'category', 'reception', 'voice'].includes(ch.type)));
	const serverName = $derived($currentSavedServer?.effectiveName || (() => {
		try { return new URL(getServerUrl()).hostname; } catch { return 'this server'; }
	})());
	const serverDescription = $derived($currentSavedServer?.effectiveDescription || $currentSavedServer?.effectiveTagline || '');
	const welcomeText = $derived($currentSavedServer?.frontendMetadata?.deskWelcomeText?.trim() || '');
	const serverIcon = $derived($currentSavedServer?.effectiveIconUrl || null);
	$effect(() => { void serverIcon; serverIconFailed = false; });
	const posterBlocks = $derived($currentSavedServer?.frontendMetadata?.deskPosterBlocks || []);
	const helpText = $derived($currentSavedServer?.frontendMetadata?.deskHelpText?.trim() || '');
	const helpLabel = $derived($currentSavedServer?.frontendMetadata?.deskHelpLabel?.trim() || 'Community resource');
	const resourceUrl = $derived.by(() => {
		const raw = $currentSavedServer?.frontendMetadata?.deskHelpUrl?.trim();
		if (!raw) return null;
		try {
			const url = new URL(raw, $activeServerUrl);
			return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
		} catch { return null; }
	});

	function posterLink(raw: string | null | undefined): string | null {
		if (!raw) return null;
		try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null; }
		catch { return null; }
	}
	async function guideRequest(path: string, init: RequestInit = {}, server = $activeServerUrl) {
		const token = getAuthToken(server);
		if (!token) throw new Error('Sign in to read this server’s welcome guide.');
		const response = await fetch(`${server}/api/server-center${path}`, {
			...init, credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(body.error || `Welcome guide unavailable (${response.status}).`);
		return body;
	}
	async function refreshGuide(server = $activeServerUrl) {
		const token = getAuthToken(server), generation = authSessionGeneration(server);
		loadingGuide = true; guideError = '';
		try {
			const guide = await guideRequest('/reception', {}, server);
			if (server !== $activeServerUrl || token !== getAuthToken(server) || generation !== authSessionGeneration(server)) return;
			roles = guide.roles ?? [];
			myRoleIds = guide.myRoleIds ?? [];
			guidedRooms = guide.rooms ?? [];
			canChooseRoles = Boolean(guide.canChooseRoles);
		} catch (cause) {
			if (server === $activeServerUrl) guideError = cause instanceof Error ? cause.message : 'Could not load the welcome guide.';
		} finally { if (server === $activeServerUrl) loadingGuide = false; }
	}
	async function refreshRules(server = $activeServerUrl) {
		try {
			const result = await guideRequest('/rules', {}, server);
			if (server === $activeServerUrl) rulesText = result.rules?.text || '';
		} catch {
			if (server === $activeServerUrl) rulesText = '';
		}
	}
	async function toggleRole(roleId: string) {
		const server = $activeServerUrl;
		const token = getAuthToken(server), generation = authSessionGeneration(server);
		const next = myRoleIds.includes(roleId) ? myRoleIds.filter(id => id !== roleId) : [...myRoleIds, roleId];
		changingRole = roleId; guideError = '';
		try {
			const result = await guideRequest('/reception/roles', { method: 'PUT', body: JSON.stringify({ roleIds: next, expectedRoleIds: myRoleIds }) }, server);
			if (server !== $activeServerUrl || token !== getAuthToken(server) || generation !== authSessionGeneration(server)) return;
			myRoleIds = result.myRoleIds ?? next;
			void refreshGuide(server);
		} catch (cause) {
			if (server === $activeServerUrl && token === getAuthToken(server) && generation === authSessionGeneration(server)) {
				await refreshGuide(server);
				guideError = cause instanceof Error ? cause.message : 'Could not save your roles.';
			}
		} finally { if (server === $activeServerUrl) changingRole = ''; }
	}
	$effect(() => { const server = $activeServerUrl; void $currentUser?.id; void $channelAccessPolicyVersion; roles = []; myRoleIds = []; guidedRooms = []; rulesText = ''; void refreshGuide(server); void refreshRules(server); });

	function isHidden(channelId: string): boolean {
		const server = $serverSettings[getActiveServerUrl() || ''];
		return Array.isArray(server?.mutedChannelIds) && server.mutedChannelIds.includes(channelId);
	}

	function toggleRoom(channelId: string): void {
		toggleServerMutedChannelId(channelId);
	}

	function openGeneral() {
		if (firstRoom?.id) {
			openRoom(firstRoom.id);
		}
	}
	function openRoom(channelId: string) {
		switchChannel(channelId);
		dispatch('openRoom');
	}
</script>

<div class="reception-board" class:desk={mode === 'desk'}>
	<div class="reception-header" class:with-artwork={Boolean(displayBackground || posterBlocks.length)}>
		{#if displayBackground}<img class="server-banner" src={displayBackground} alt="" onerror={() => { if (displayBackground === movingBackground) movingImageFailed = true; }} />{/if}
		{#if movingBackground && motionAllowed}<button type="button" class="motion-button" onclick={toggleMotion} disabled={movingImageFailed}>{movingImageFailed ? 'Moving background unavailable' : motionPaused ? 'Play background' : 'Pause background'}</button>{/if}
		{#if serverIcon && !serverIconFailed}<img class="server-icon" src={serverIcon} alt="" onerror={() => serverIconFailed = true} />{:else}<span class="server-icon server-icon-fallback" aria-hidden="true">{serverName.charAt(0).toUpperCase()}</span>{/if}
		<h1>{mode === 'desk' ? `You’re on ${serverName}` : `Welcome to ${serverName}`}</h1>
		{#if serverDescription}<p class="server-description">{serverDescription}</p>{/if}
		{#if welcomeText}<p class="welcome-message">{welcomeText}</p>{/if}
		{#if mode === 'welcome'}<p class="reception-subtitle">Read the rules, find rooms that fit you, and shape your view.</p>{/if}
		{#if posterBlocks.length}
			<div class="poster-blocks" aria-label="Interactive welcome poster">
				{#each posterBlocks as block (block.id)}
					<div class="poster-block" style:left={`${block.x}%`} style:top={`${block.y}%`} style:width={`${block.width}%`}>
						{#if block.kind === 'text'}<p>{block.text}</p>
						{:else if block.kind === 'link'}{@const url = posterLink(block.url)}{#if url}<a href={url} target="_blank" rel="noopener noreferrer">{block.text}</a>{:else}<span>Resource unavailable</span>{/if}
						{:else if block.kind === 'role'}{@const role = roles.find(item => item.id === block.roleId)}{#if role}<button type="button" disabled={!canChooseRoles || Boolean(changingRole)} aria-pressed={myRoleIds.includes(role.id)} onclick={() => toggleRole(role.id)}>{block.text} · {myRoleIds.includes(role.id) ? 'Selected' : canChooseRoles ? 'Choose' : 'Member account needed'}</button>{:else}<span>Role unavailable</span>{/if}{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#if mode === 'desk' && !editingChoices}
		<div class="desk-overview">
			{#if guideError}<p class="guide-error" role="alert">{guideError}</p>{/if}
			<section class="reception-section">
				<h2>Community rules</h2>
				{#if rulesText}<p class="rules-excerpt">{rulesText.length > 320 ? `${rulesText.slice(0, 320).trimEnd()}…` : rulesText}</p>{:else}<p class="reception-hint">This server has not published rules yet.</p>{/if}
				{#if $communityRulesAvailable}<button type="button" class="rules-button" onclick={() => communityRulesOpen.set(true)}>Read all rules</button>{/if}
			</section>
			<section class="reception-section">
				<h2>Your community roles</h2>
				<button type="button" class="rules-button" onclick={() => editingChoices = true}>Manage community roles and sidebar</button>
				{#if myRoleIds.length}<p class="reception-hint">{roles.filter(role => myRoleIds.includes(role.id)).map(role => role.name).join(', ') || 'Your previous roles are no longer available.'}</p>{:else}<p class="reception-hint">You have not chosen any community roles.</p>{/if}
			</section>
			<section class="reception-section desk-room-section">
				<h2>Rooms in your sidebar</h2><p class="reception-hint">Show or hide rooms here, then open them from the channel list.</p>
				{#if $channels.filter(ch => !['dm', 'group', 'category', 'reception'].includes(ch.type)).length === 0}<p class="reception-hint">No rooms are available yet.</p>{/if}
				<div class="room-list">
					{#each $channels as ch (ch.id)}
						{#if !['dm', 'group', 'category', 'reception'].includes(ch.type)}
							<div class="room-row" class:room-row-off={isHidden(ch.id)}><span class="room-name">#{ch.name}{#if ch.description}<small>{ch.description}</small>{/if}</span><button type="button" class="room-switch" role="switch" aria-checked={!isHidden(ch.id)} aria-label={`Show ${ch.name} in sidebar`} onclick={() => toggleRoom(ch.id)}><span class="switch-track" aria-hidden="true"></span><span>{isHidden(ch.id) ? 'Off' : 'On'}</span></button></div>
						{/if}
					{/each}
				</div>
				{#if guidedRooms.filter(room => !$channels.some(channel => channel.id === room.id)).length}
					<h3>Other rooms you can open</h3>
					<div class="room-list">
						{#each guidedRooms.filter(room => !$channels.some(channel => channel.id === room.id)) as room (room.id)}
							<div class="room-row room-row-off"><span class="room-name">#{room.name}{#if room.description}<small>{room.description}</small>{/if}</span><span class="room-status">Choose {roles.find(role => role.id === room.roleId)?.name || 'a role'} to open</span></div>
						{/each}
					</div>
				{/if}
				</section>
			<section class="reception-section">
				<h2>Need a hand?</h2>
				<p class="reception-hint">{helpText || "Read the rules, choose a role to open its rooms, or browse all rooms you can access. You can return here from the server name at any time."}</p>
				{#if resourceUrl}<a href={resourceUrl} target="_blank" rel="noopener noreferrer">{helpLabel}</a>{/if}
				{#if $communityRulesAvailable}<button type="button" class="rules-button" onclick={() => communityRulesOpen.set(true)}>Open rules and help</button>{/if}
			</section>
		</div>
	{:else}
	<div class="reception-body">
		<section class="reception-section">
			<h2>Before you jump in</h2>
			<p class="reception-hint">Every server has its own expectations. Community roles below open the rooms linked to them. Staff access is assigned separately by staff.</p>
			{#if $communityRulesAvailable}<button type="button" class="rules-button" onclick={() => communityRulesOpen.set(true)}>Read server rules</button>{/if}
		</section>

		<section class="reception-section">
			<h2>Find your role</h2>
			<p class="reception-hint">Choose any community role that fits. Your choice is saved on this server and opens its rooms immediately.</p>
			{#if guideError}<p class="guide-error" role="alert">{guideError}</p>{/if}
			{#if loadingGuide}<p>Loading the room guide…</p>{:else if roles.length === 0}<p class="reception-empty">This server has not set up newcomer roles yet.</p>{:else}
				<div class="role-list">
					{#each roles as role (role.id)}
						<div class="role-card">
							<div><strong>{role.name}</strong>{#if role.description}<p>{role.description}</p>{/if}
								{#each guidedRooms.filter(room => room.roleId === role.id) as room (room.id)}
									<div class="guided-room"><span>#{room.name}</span>{#if room.description}<small>{room.description}</small>{/if}{#if myRoleIds.includes(role.id) && $channels.some(channel => channel.id === room.id)}<button type="button" onclick={() => openRoom(room.id)}>Open room</button>{/if}</div>
								{/each}
							</div>
							<button type="button" onclick={() => toggleRole(role.id)} disabled={!canChooseRoles || Boolean(changingRole)} aria-pressed={myRoleIds.includes(role.id)}>{myRoleIds.includes(role.id) ? 'Leave role' : 'Choose role'}</button>
						</div>
					{/each}
				</div>
				{#if !canChooseRoles}<p class="reception-hint">Sign in with a member account to choose roles.</p>{/if}
			{/if}
			<button type="button" class="refresh-guide" onclick={() => refreshGuide()}>Refresh room guide</button>
		</section>

		<section class="reception-section view-section">
			<h2>Shape your view</h2>
			<p class="reception-hint">Show or hide rooms in your sidebar. This changes only your view; your community roles control access.</p>
			<label class="rail-choice"><input type="checkbox" checked={$desktopServerRailPinned} onchange={event => desktopServerRailPinned.set(event.currentTarget.checked)} /><span>Show the server rail on desktop <small>A quick bar for switching between saved servers.</small></span></label>
			<div class="room-list">
				{#each $channels as ch (ch.id)}
					{#if !['dm', 'group', 'category', 'reception'].includes(ch.type)}
						<button
							type="button"
							class="room-row"
							class:room-row-off={isHidden(ch.id)}
							role="switch" aria-checked={!isHidden(ch.id)} aria-label={`Show ${ch.name} in sidebar`}
							onclick={() => toggleRoom(ch.id)}
						>
							<span class="room-name">#{ch.name}{#if ch.description}<small>{ch.description}</small>{/if}</span>
							<span class="switch-track" class:enabled={!isHidden(ch.id)} aria-hidden="true"></span><span class="room-status">{isHidden(ch.id) ? 'Off' : 'On'}</span>
						</button>
					{/if}
				{/each}
			</div>
		</section>
	</div>
	{/if}

	<div class="reception-footer">
		{#if mode === 'desk'}
			{#if editingChoices}<button type="button" class="primary" onclick={() => editingChoices = false}>Done</button>{/if}
		{:else}<button type="button" class="primary" onclick={openGeneral} disabled={!firstRoom}>Show me the server</button>{/if}
	</div>
</div>

<style>
	.reception-board {
		display: grid;
		container-type: inline-size;
		grid-template-rows: auto 1fr auto;
		min-height: 100%;
		padding: 0;
		gap: 32px;
	}
	.reception-header h1 {
		margin: 0;
		font-size: clamp(32px, 5cqi, 64px);
		line-height: 1.1;
	}
	.reception-header.with-artwork{position:relative;isolation:isolate;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-end;min-height:clamp(300px,45cqi,520px);padding:clamp(18px,3vw,32px);overflow:hidden;border-radius:var(--radius-lg);background:var(--surface-sunken)}
	.reception-header.with-artwork::before{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(0deg,rgba(0,0,0,.86),rgba(0,0,0,.34) 65%,rgba(0,0,0,.16))}
	.server-banner{position:absolute;inset:0;z-index:-2;width:100%;height:100%;object-fit:cover}
	.with-artwork :is(h1,.server-description,.reception-subtitle){color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.65)}
	.welcome-message{white-space:pre-wrap;line-height:1.6;max-width:70ch;overflow-wrap:anywhere}.with-artwork .welcome-message{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.65)}
	.poster-blocks{position:absolute;inset:0;z-index:1;pointer-events:none}.poster-block{position:absolute;pointer-events:auto;min-width:0;padding:8px 10px;background:color-mix(in srgb,var(--surface-base) 92%,transparent);color:var(--text-primary);border:1px solid var(--border-default);border-radius:var(--radius-md);box-shadow:0 2px 10px rgba(0,0,0,.22)}.poster-block p{margin:0;overflow-wrap:anywhere}.poster-block :is(a,button){font:inherit;color:var(--accent-primary);overflow-wrap:anywhere}.poster-block button{border:0;background:transparent;cursor:pointer}.poster-block button:disabled{opacity:.7;cursor:default}
	@media(max-width:700px){.poster-blocks{position:relative;inset:auto;display:grid;gap:8px;width:100%;pointer-events:auto;margin-top:14px}.poster-block{position:static;width:auto!important}.reception-header.with-artwork{min-height:220px}}
	@container(max-width:700px){.reception-body,.desk-overview{grid-template-columns:1fr}.view-section,.desk-room-section{grid-column:auto}.poster-blocks{position:relative;inset:auto;display:grid;gap:8px;width:100%;pointer-events:auto;margin-top:14px}.poster-block{position:static;width:auto!important}}
	.motion-button{position:absolute;top:12px;right:12px;z-index:1;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--surface-base);color:var(--text-primary);font:inherit;cursor:pointer}
	.desk{width:100%;margin:0}
	.desk-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px;align-content:start}
	.desk-room-section{grid-column:1/-1}
	.rules-excerpt{white-space:pre-wrap;line-height:1.6;color:var(--text-primary);overflow-wrap:anywhere}
	.edit-choices{grid-column:1/-1;justify-self:start;align-self:start;padding:10px 14px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--surface-raised);color:var(--text-primary);font:inherit;cursor:pointer}
	.desk-overview .room-row{border:1px solid var(--border-default);cursor:default}
	.server-icon{width:56px;height:56px;border-radius:15px;object-fit:cover;margin-bottom:12px}.server-icon-fallback{display:grid;place-items:center;background:var(--accent-primary);color:var(--text-on-accent,white);font-weight:700;font-size:1.5rem}
	.server-description{margin:8px 0 0;color:var(--text-primary)}
	.reception-subtitle {
		margin: 8px 0 0;
		color: #b9bbbe;
	}
	.reception-body {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
		gap: 24px;
		align-content: start;
	}
	.view-section{grid-column:1 / -1}
	.reception-section h2 {
		margin: 0 0 12px;
		font-size: 16px;
	}
	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.chip {
		appearance: none;
		border: 1px solid #4f545c;
		background: var(--surface-base);
		color: var(--text-primary);
		padding: 8px 12px;
		border-radius: 9999px;
		cursor: pointer;
	}
	.chip-on {
		background: #5865f2;
		border-color: #5865f2;
		color: white;
	}
	.reception-empty {
		color: #b9bbbe;
		font-size: 13px;
	}
	.role-list{display:grid;gap:10px;margin-top:15px}
	.role-card{display:flex;justify-content:space-between;align-items:start;gap:12px;padding:14px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-raised)}
	.role-card p{margin:5px 0;color:var(--text-secondary);font-size:.85rem}
	.role-card button,.refresh-guide{flex:none;padding:8px 11px;border:1px solid var(--border-default);border-radius:9px;background:var(--surface-base);color:var(--text-primary);cursor:pointer}
	.role-card button[aria-pressed="true"]{background:var(--accent-primary);color:var(--text-on-accent,white);border-color:transparent}
	.role-card button:disabled{opacity:.55;cursor:not-allowed}.refresh-guide{margin-top:12px}
	.guided-room{display:grid;gap:3px;margin-top:9px;font-size:.82rem}.guided-room small,.room-name small{display:block;color:var(--text-secondary);font-size:.76rem;font-weight:400}
	.guided-room button{justify-self:start;margin-top:3px;border:0;background:none;color:var(--accent-primary);padding:3px 0;cursor:pointer}
	.guide-error{color:var(--danger)}
	.rail-choice{display:flex;align-items:center;gap:10px;margin:15px 0;padding:10px 12px;border:1px solid var(--border-default);border-radius:10px;background:var(--surface-raised);cursor:pointer}.rail-choice input{width:17px;height:17px}.rail-choice small{display:block;color:var(--text-secondary);font-size:.77rem;margin-top:3px}
	.room-list {
		display: grid;
		gap: 8px;
	}
	.room-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--surface-base);
		color: var(--text-primary);
		width: 100%;
		text-align: left;
		cursor: pointer;
	}
	.room-row-off {
		opacity: 0.7;
	}
	.room-status {
		font-size: 12px;
		opacity: 0.8;
	}
	.reception-footer {
		display: flex;
		justify-content: flex-end;
	}
	.primary {
		appearance: none;
		border: none;
		background: #5865f2;
		color: white;
		padding: 12px 18px;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 600;
	}
	.rules-button{appearance:none;border:1px solid #4f545c;border-radius:9px;background:#2f3136;color:#fff;padding:10px 13px;cursor:pointer}
	@media(max-width:720px){.reception-body,.desk-overview{grid-template-columns:1fr}.view-section,.desk-room-section{grid-column:auto}.role-card{flex-direction:column}.role-card button{align-self:flex-start}}
	.room-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }
	.room-row { gap: 16px; border: 1px solid var(--border-default); }
	.room-row-off { opacity: 1; }
	.room-switch { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; flex: none; border: 0; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
	.switch-track { display: inline-block; width: 40px; height: 24px; flex: none; padding: 3px; box-sizing: border-box; border-radius: var(--radius-full); background: var(--text-muted); }
	.switch-track::after { content: ''; display: block; width: 18px; height: 18px; border-radius: 50%; background: var(--surface-app); transition: transform 150ms ease; }
	.room-switch[aria-checked="true"] .switch-track, .switch-track.enabled { background: var(--accent-primary); }
	.room-switch[aria-checked="true"] .switch-track::after, .switch-track.enabled::after { transform: translateX(16px); background: var(--text-on-accent, white); }
	.room-switch:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; border-radius: var(--radius-sm); }
</style>
