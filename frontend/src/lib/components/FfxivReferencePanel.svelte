<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { currentChannel } from '$lib/socket-manager';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import './FfxivReferencePanel.css';

	type LookupKind = 'item' | 'job' | 'action' | 'quest' | 'status' | 'zone' | 'map' | 'market' | 'profile';
	interface LookupCard { id: string; kind: LookupKind; title: string; subtitle?: string; detail?: string; iconUrl?: string; link?: string; source: 'xivapi' | 'universalis' | 'fallback'; pinKey?: string; }
	interface RaidNote { id: string; title: string; body: string; phase?: string; createdAt: number; createdBy?: string; }
	interface WipeLogEntry { id: string; encounter: string; phase?: string; reason: string; createdAt: number; createdBy?: string; }
	interface PrepBoardTemplate { id: string; name: string; description?: string; notes: RaidNote[]; createdAt: number; createdBy?: string; }
	interface FfxivChannelState { channelId: string; pinnedCards: LookupCard[]; raidNotes: RaidNote[]; wipeLogs: WipeLogEntry[]; templates: PrepBoardTemplate[]; updatedAt: number; }

	const lookupKinds: Array<{ id: LookupKind; label: string }> = [
		{ id: 'item', label: $_('ffxiv.kind_item') }, { id: 'job', label: $_('ffxiv.kind_job') }, { id: 'action', label: $_('ffxiv.kind_action') },
		{ id: 'quest', label: $_('ffxiv.kind_quest') }, { id: 'status', label: $_('ffxiv.kind_status') }, { id: 'zone', label: $_('ffxiv.kind_zone') },
		{ id: 'map', label: $_('ffxiv.kind_map') }, { id: 'market', label: $_('ffxiv.kind_market') }, { id: 'profile', label: $_('ffxiv.kind_profile') }
	];

	let channelId = '';
	let state: FfxivChannelState | null = null;
	let cards: LookupCard[] = [];
	let searchKind: LookupKind = 'item';
	let searchQuery = '';
	let searchWorld = '';
	let searchDataCenter = '';
	let statusMessage = '';
	let isLoading = false;
	let isSubmitting = false;
	let noteTitle = '';
	let notePhase = '';
	let noteBody = '';
	let wipeEncounter = '';
	let wipePhase = '';
	let wipeReason = '';
	let templateName = '';
	let templateDescription = '';

	$: channelId = $currentChannel || '';
	$: if (channelId) void refreshState(); else { state = null; cards = []; statusMessage = $_('ffxiv.open_channel'); }

	function headers(): HeadersInit { const token = getAuthToken(); return token ? { Authorization: `Bearer ${token}` } : {}; }
	async function fetchJson(path: string, init: RequestInit = {}): Promise<any | null> {
		try {
			const response = await fetch(`${getServerUrl()}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}), ...headers() } });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) { statusMessage = typeof payload?.error === 'string' ? payload.error : $_('ffxiv.request_failed_status', { values: { status: response.status } }); return null; }
			return payload;
		} catch (error) { statusMessage = error instanceof Error ? error.message : $_('ffxiv.request_failed'); return null; }
	}
	async function refreshState(): Promise<void> { if (!channelId) return; isLoading = true; const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/state?channelId=${encodeURIComponent(channelId)}`, { method: 'GET' }); if (payload?.state) state = payload.state as FfxivChannelState; isLoading = false; }
	async function search(): Promise<void> {
		if (!channelId || !searchQuery.trim()) return;
		isSubmitting = true; statusMessage = '';
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/lookup`, { method: 'POST', body: JSON.stringify({ channelId, kind: searchKind, query: searchQuery, world: searchWorld || undefined, dataCenter: searchDataCenter || undefined }) });
		cards = Array.isArray(payload?.cards) ? payload.cards : [];
		if (cards.length === 0) statusMessage = $_('ffxiv.no_results');
		isSubmitting = false;
	}
	async function pinCard(card: LookupCard): Promise<void> { if (!channelId) return; isSubmitting = true; const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/pin`, { method: 'POST', body: JSON.stringify({ channelId, card }) }); if (payload?.state) state = payload.state as FfxivChannelState; isSubmitting = false; }
	async function unpinCard(cardId: string): Promise<void> { if (!channelId) return; isSubmitting = true; const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/unpin`, { method: 'POST', body: JSON.stringify({ channelId, cardId }) }); if (payload?.state) state = payload.state as FfxivChannelState; isSubmitting = false; }
	async function addNote(): Promise<void> { if (!channelId || !noteTitle.trim() || !noteBody.trim()) return; isSubmitting = true; const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/note`, { method: 'POST', body: JSON.stringify({ channelId, title: noteTitle, phase: notePhase, body: noteBody }) }); if (payload?.state) state = payload.state as FfxivChannelState; noteTitle = ''; notePhase = ''; noteBody = ''; isSubmitting = false; }
	async function addWipe(): Promise<void> { if (!channelId || !wipeEncounter.trim() || !wipeReason.trim()) return; isSubmitting = true; const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/wipe`, { method: 'POST', body: JSON.stringify({ channelId, encounter: wipeEncounter, phase: wipePhase, reason: wipeReason }) }); if (payload?.state) state = payload.state as FfxivChannelState; wipeEncounter = ''; wipePhase = ''; wipeReason = ''; isSubmitting = false; }
	async function saveTemplate(): Promise<void> { if (!channelId || !templateName.trim()) return; isSubmitting = true; const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/template`, { method: 'POST', body: JSON.stringify({ channelId, name: templateName, description: templateDescription, notes: state?.raidNotes || [] }) }); if (payload?.state) state = payload.state as FfxivChannelState; templateName = ''; templateDescription = ''; isSubmitting = false; }
	function formatTime(timestamp: number): string { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp); }
	onMount(() => { void refreshState(); });
</script>

<div class="ffxiv-panel">
	<div class="panel-header"><div><div class="eyebrow">{$_('ffxiv.eyebrow')}</div><h3>{$_('ffxiv.heading')}</h3><p>{$_('ffxiv.intro')}</p></div><div class="channel-pill">{channelId || $_('ffxiv.no_channel')}</div></div>

	<div class="search-card">
		<div class="search-grid">
			<label><span>{$_('ffxiv.kind_label')}</span><select bind:value={searchKind}>{#each lookupKinds as kind}<option value={kind.id}>{kind.label}</option>{/each}</select></label>
			<label class="wide"><span>{$_('ffxiv.query_label')}</span><input bind:value={searchQuery} placeholder={$_('ffxiv.query_placeholder')} /></label>
			<label><span>{$_('ffxiv.world_label')}</span><input bind:value={searchWorld} placeholder="Ultros" /></label>
			<label><span>{$_('ffxiv.dc_label')}</span><input bind:value={searchDataCenter} placeholder="Aether" /></label>
		</div>
		<div class="actions"><button type="button" on:click={search} disabled={isLoading || isSubmitting || !channelId}>{$_('ffxiv.search')}</button><button type="button" class="ghost" on:click={refreshState} disabled={isLoading || !channelId}>{$_('ffxiv.refresh')}</button></div>
	</div>

	{#if statusMessage}<div class="status">{statusMessage}</div>{/if}

	<div class="two-col">
		<section class="card-list">
			<div class="section-title"><h4>{$_('ffxiv.results')}</h4><span>{$_('ffxiv.count_cards', { values: { count: cards.length } })}</span></div>
			{#if cards.length === 0}<div class="empty">{$_('ffxiv.empty_search')}</div>{:else}
				{#each cards as card (card.id)}
					<article class="lookup-card">
						<div class="card-top">{#if card.iconUrl}<img src={card.iconUrl} alt="" />{/if}<div><div class="card-kind">{card.kind}</div><h5>{card.title}</h5>{#if card.subtitle}<p class="subtitle">{card.subtitle}</p>{/if}</div></div>
						{#if card.detail}<p class="detail">{card.detail}</p>{/if}
						<div class="card-actions">{#if card.link}<a href={card.link} target="_blank" rel="noreferrer">{$_('ffxiv.open_source')}</a>{/if}<button type="button" on:click={() => pinCard(card)} disabled={isSubmitting || !channelId}>{$_('ffxiv.pin')}</button></div>
					</article>
				{/each}
			{/if}
		</section>

		<section class="card-list">
			<div class="section-title"><h4>{$_('ffxiv.pinned')}</h4><span>{$_('ffxiv.count_saved', { values: { count: state?.pinnedCards.length || 0 } })}</span></div>
			{#if !state?.pinnedCards?.length}<div class="empty">{$_('ffxiv.pinned_empty')}</div>{:else}
				{#each state.pinnedCards as card (card.id)}
					<article class="lookup-card pinned">
						<div class="card-top"><div><div class="card-kind">{card.kind}</div><h5>{card.title}</h5>{#if card.subtitle}<p class="subtitle">{card.subtitle}</p>{/if}</div></div>
						{#if card.detail}<p class="detail">{card.detail}</p>{/if}
						<div class="card-actions"><button type="button" class="ghost" on:click={() => unpinCard(card.id)} disabled={isSubmitting}>{$_('ffxiv.unpin')}</button></div>
					</article>
				{/each}
			{/if}
		</section>
	</div>

	<div class="three-col">
		<section class="card-list">
			<div class="section-title"><h4>{$_('ffxiv.raid_notes')}</h4><span>{state?.raidNotes.length || 0}</span></div>
			<div class="note-form"><input bind:value={noteTitle} placeholder={$_('ffxiv.phase_title')} /><input bind:value={notePhase} placeholder={$_('ffxiv.phase_mechanic')} /><textarea bind:value={noteBody} placeholder={$_('ffxiv.note_body')} rows="4"></textarea><button type="button" on:click={addNote} disabled={isSubmitting || !channelId}>{$_('ffxiv.add_note')}</button></div>
			{#if state?.raidNotes?.length}{#each state.raidNotes.slice().reverse() as note (note.id)}<article class="mini-card"><div class="mini-top"><h5>{note.title}</h5>{#if note.phase}<span>{note.phase}</span>{/if}</div><p>{note.body}</p><div class="mini-meta">{formatTime(note.createdAt)}</div></article>{/each}{/if}
		</section>

		<section class="card-list">
			<div class="section-title"><h4>{$_('ffxiv.wipe_log')}</h4><span>{state?.wipeLogs.length || 0}</span></div>
			<div class="note-form"><input bind:value={wipeEncounter} placeholder={$_('ffxiv.encounter_name')} /><input bind:value={wipePhase} placeholder={$_('ffxiv.phase')} /><textarea bind:value={wipeReason} placeholder={$_('ffxiv.what_happened')} rows="4"></textarea><button type="button" on:click={addWipe} disabled={isSubmitting || !channelId}>{$_('ffxiv.log_wipe')}</button></div>
			{#if state?.wipeLogs?.length}{#each state.wipeLogs.slice().reverse() as wipe (wipe.id)}<article class="mini-card"><div class="mini-top"><h5>{wipe.encounter}</h5>{#if wipe.phase}<span>{wipe.phase}</span>{/if}</div><p>{wipe.reason}</p><div class="mini-meta">{formatTime(wipe.createdAt)}</div></article>{/each}{/if}
		</section>

		<section class="card-list">
			<div class="section-title"><h4>{$_('ffxiv.prep_templates')}</h4><span>{state?.templates.length || 0}</span></div>
			<div class="note-form"><input bind:value={templateName} placeholder={$_('ffxiv.template_name')} /><input bind:value={templateDescription} placeholder={$_('ffxiv.description')} /><button type="button" on:click={saveTemplate} disabled={isSubmitting || !channelId}>{$_('ffxiv.save_template')}</button></div>
			{#if state?.templates?.length}{#each state.templates.slice().reverse() as template (template.id)}<article class="mini-card"><div class="mini-top"><h5>{template.name}</h5><span>{$_('ffxiv.count_notes', { values: { count: template.notes.length } })}</span></div>{#if template.description}<p>{template.description}</p>{/if}<div class="mini-meta">{formatTime(template.createdAt)}</div></article>{/each}{/if}
		</section>
	</div>
</div>
