<script lang="ts">
	import { onMount } from 'svelte';
	import { currentChannel } from '$lib/socket-manager';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';

	type LookupKind = 'item' | 'job' | 'action' | 'quest' | 'status' | 'zone' | 'map' | 'market' | 'profile';

	interface LookupCard {
		id: string;
		kind: LookupKind;
		title: string;
		subtitle?: string;
		detail?: string;
		iconUrl?: string;
		link?: string;
		source: 'xivapi' | 'universalis' | 'fallback';
		pinKey?: string;
	}

	interface RaidNote {
		id: string;
		title: string;
		body: string;
		phase?: string;
		createdAt: number;
		createdBy?: string;
	}

	interface WipeLogEntry {
		id: string;
		encounter: string;
		phase?: string;
		reason: string;
		createdAt: number;
		createdBy?: string;
	}

	interface PrepBoardTemplate {
		id: string;
		name: string;
		description?: string;
		notes: RaidNote[];
		createdAt: number;
		createdBy?: string;
	}

	interface FfxivChannelState {
		channelId: string;
		pinnedCards: LookupCard[];
		raidNotes: RaidNote[];
		wipeLogs: WipeLogEntry[];
		templates: PrepBoardTemplate[];
		updatedAt: number;
	}

	const lookupKinds: Array<{ id: LookupKind; label: string }> = [
		{ id: 'item', label: 'Item' },
		{ id: 'job', label: 'Job' },
		{ id: 'action', label: 'Action' },
		{ id: 'quest', label: 'Quest' },
		{ id: 'status', label: 'Status' },
		{ id: 'zone', label: 'Zone' },
		{ id: 'map', label: 'Map' },
		{ id: 'market', label: 'Market' },
		{ id: 'profile', label: 'Profile' }
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
	$: if (channelId) {
		void refreshState();
	} else {
		state = null;
		cards = [];
		statusMessage = 'Open a channel to start building a raid board.';
	}

	function headers(): HeadersInit {
		const token = getAuthToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	async function fetchJson(path: string, init: RequestInit = {}): Promise<any | null> {
		try {
			const response = await fetch(`${getServerUrl()}${path}`, {
				...init,
				headers: {
					'Content-Type': 'application/json',
					...(init.headers || {}),
					...headers()
				}
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) {
				statusMessage = typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status})`;
				return null;
			}
			return payload;
		} catch (error) {
			statusMessage = error instanceof Error ? error.message : 'Request failed';
			return null;
		}
	}

	async function refreshState(): Promise<void> {
		if (!channelId) return;
		isLoading = true;
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/state?channelId=${encodeURIComponent(channelId)}`, {
			method: 'GET'
		});
		if (payload?.state) {
			state = payload.state as FfxivChannelState;
		}
		isLoading = false;
	}

	async function search(): Promise<void> {
		if (!channelId || !searchQuery.trim()) return;
		isSubmitting = true;
		statusMessage = '';
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/lookup`, {
			method: 'POST',
			body: JSON.stringify({
				channelId,
				kind: searchKind,
				query: searchQuery,
				world: searchWorld || undefined,
				dataCenter: searchDataCenter || undefined
			})
		});
		cards = Array.isArray(payload?.cards) ? payload.cards : [];
		if (cards.length === 0) {
			statusMessage = 'No results returned.';
		}
		isSubmitting = false;
	}

	async function pinCard(card: LookupCard): Promise<void> {
		if (!channelId) return;
		isSubmitting = true;
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/pin`, {
			method: 'POST',
			body: JSON.stringify({ channelId, card })
		});
		if (payload?.state) state = payload.state as FfxivChannelState;
		isSubmitting = false;
	}

	async function unpinCard(cardId: string): Promise<void> {
		if (!channelId) return;
		isSubmitting = true;
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/unpin`, {
			method: 'POST',
			body: JSON.stringify({ channelId, cardId })
		});
		if (payload?.state) state = payload.state as FfxivChannelState;
		isSubmitting = false;
	}

	async function addNote(): Promise<void> {
		if (!channelId || !noteTitle.trim() || !noteBody.trim()) return;
		isSubmitting = true;
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/note`, {
			method: 'POST',
			body: JSON.stringify({
				channelId,
				title: noteTitle,
				phase: notePhase,
				body: noteBody
			})
		});
		if (payload?.state) state = payload.state as FfxivChannelState;
		noteTitle = '';
		notePhase = '';
		noteBody = '';
		isSubmitting = false;
	}

	async function addWipe(): Promise<void> {
		if (!channelId || !wipeEncounter.trim() || !wipeReason.trim()) return;
		isSubmitting = true;
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/wipe`, {
			method: 'POST',
			body: JSON.stringify({
				channelId,
				encounter: wipeEncounter,
				phase: wipePhase,
				reason: wipeReason
			})
		});
		if (payload?.state) state = payload.state as FfxivChannelState;
		wipeEncounter = '';
		wipePhase = '';
		wipeReason = '';
		isSubmitting = false;
	}

	async function saveTemplate(): Promise<void> {
		if (!channelId || !templateName.trim()) return;
		isSubmitting = true;
		const payload = await fetchJson(`/api/plugins/runtime/ffxiv-super-addon/template`, {
			method: 'POST',
			body: JSON.stringify({
				channelId,
				name: templateName,
				description: templateDescription,
				notes: state?.raidNotes || []
			})
		});
		if (payload?.state) state = payload.state as FfxivChannelState;
		templateName = '';
		templateDescription = '';
		isSubmitting = false;
	}

	function formatTime(timestamp: number): string {
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		}).format(timestamp);
	}

	onMount(() => {
		void refreshState();
	});
</script>

<div class="ffxiv-panel">
	<div class="panel-header">
		<div>
			<div class="eyebrow">FFXIV Reference</div>
			<h3>Raid prep and static lookup</h3>
			<p>Search XIVAPI, pin cards, and keep phase notes in one channel-scoped board.</p>
		</div>
		<div class="channel-pill">{channelId || 'No channel'}</div>
	</div>

	<div class="search-card">
		<div class="search-grid">
			<label>
				<span>Kind</span>
				<select bind:value={searchKind}>
					{#each lookupKinds as kind}
						<option value={kind.id}>{kind.label}</option>
					{/each}
				</select>
			</label>
			<label class="wide">
				<span>Query</span>
				<input bind:value={searchQuery} placeholder="Item, job, quest, or market search" />
			</label>
			<label>
				<span>World</span>
				<input bind:value={searchWorld} placeholder="Ultros" />
			</label>
			<label>
				<span>Data center</span>
				<input bind:value={searchDataCenter} placeholder="Aether" />
			</label>
		</div>
		<div class="actions">
			<button type="button" on:click={search} disabled={isLoading || isSubmitting || !channelId}>Search</button>
			<button type="button" class="ghost" on:click={refreshState} disabled={isLoading || !channelId}>Refresh</button>
		</div>
	</div>

	{#if statusMessage}
		<div class="status">{statusMessage}</div>
	{/if}

	<div class="two-col">
		<section class="card-list">
			<div class="section-title">
				<h4>Results</h4>
				<span>{cards.length} cards</span>
			</div>
			{#if cards.length === 0}
				<div class="empty">Search for an FFXIV item, job, quest, map, or market price.</div>
			{:else}
				{#each cards as card (card.id)}
					<article class="lookup-card">
						<div class="card-top">
							{#if card.iconUrl}
								<img src={card.iconUrl} alt="" />
							{/if}
							<div>
								<div class="card-kind">{card.kind}</div>
								<h5>{card.title}</h5>
								{#if card.subtitle}<p class="subtitle">{card.subtitle}</p>{/if}
							</div>
						</div>
						{#if card.detail}<p class="detail">{card.detail}</p>{/if}
						<div class="card-actions">
							{#if card.link}
								<a href={card.link} target="_blank" rel="noreferrer">Open source</a>
							{/if}
							<button type="button" on:click={() => pinCard(card)} disabled={isSubmitting || !channelId}>Pin</button>
						</div>
					</article>
				{/each}
			{/if}
		</section>

		<section class="card-list">
			<div class="section-title">
				<h4>Pinned</h4>
				<span>{state?.pinnedCards.length || 0} saved</span>
			</div>
			{#if !state?.pinnedCards?.length}
				<div class="empty">Pinned cards appear here so your raid team can keep the important bits in view.</div>
			{:else}
				{#each state.pinnedCards as card (card.id)}
					<article class="lookup-card pinned">
						<div class="card-top">
							<div>
								<div class="card-kind">{card.kind}</div>
								<h5>{card.title}</h5>
								{#if card.subtitle}<p class="subtitle">{card.subtitle}</p>{/if}
							</div>
						</div>
						{#if card.detail}<p class="detail">{card.detail}</p>{/if}
						<div class="card-actions">
							<button type="button" class="ghost" on:click={() => unpinCard(card.id)} disabled={isSubmitting}>Unpin</button>
						</div>
					</article>
				{/each}
			{/if}
		</section>
	</div>

	<div class="three-col">
		<section class="card-list">
			<div class="section-title">
				<h4>Raid notes</h4>
				<span>{state?.raidNotes.length || 0}</span>
			</div>
			<div class="note-form">
				<input bind:value={noteTitle} placeholder="Phase title" />
				<input bind:value={notePhase} placeholder="Phase / mechanic" />
				<textarea bind:value={noteBody} placeholder="Callout, checklist, mechanic note" rows="4"></textarea>
				<button type="button" on:click={addNote} disabled={isSubmitting || !channelId}>Add note</button>
			</div>
			{#if state?.raidNotes?.length}
				{#each state.raidNotes.slice().reverse() as note (note.id)}
					<article class="mini-card">
						<div class="mini-top">
							<h5>{note.title}</h5>
							{#if note.phase}<span>{note.phase}</span>{/if}
						</div>
						<p>{note.body}</p>
						<div class="mini-meta">{formatTime(note.createdAt)}</div>
					</article>
				{/each}
			{/if}
		</section>

		<section class="card-list">
			<div class="section-title">
				<h4>Wipe log</h4>
				<span>{state?.wipeLogs.length || 0}</span>
			</div>
			<div class="note-form">
				<input bind:value={wipeEncounter} placeholder="Encounter name" />
				<input bind:value={wipePhase} placeholder="Phase" />
				<textarea bind:value={wipeReason} placeholder="What happened?" rows="4"></textarea>
				<button type="button" on:click={addWipe} disabled={isSubmitting || !channelId}>Log wipe</button>
			</div>
			{#if state?.wipeLogs?.length}
				{#each state.wipeLogs.slice().reverse() as wipe (wipe.id)}
					<article class="mini-card">
						<div class="mini-top">
							<h5>{wipe.encounter}</h5>
							{#if wipe.phase}<span>{wipe.phase}</span>{/if}
						</div>
						<p>{wipe.reason}</p>
						<div class="mini-meta">{formatTime(wipe.createdAt)}</div>
					</article>
				{/each}
			{/if}
		</section>

		<section class="card-list">
			<div class="section-title">
				<h4>Prep templates</h4>
				<span>{state?.templates.length || 0}</span>
			</div>
			<div class="note-form">
				<input bind:value={templateName} placeholder="Template name" />
				<input bind:value={templateDescription} placeholder="Description" />
				<button type="button" on:click={saveTemplate} disabled={isSubmitting || !channelId}>Save template</button>
			</div>
			{#if state?.templates?.length}
				{#each state.templates.slice().reverse() as template (template.id)}
					<article class="mini-card">
						<div class="mini-top">
							<h5>{template.name}</h5>
							<span>{template.notes.length} notes</span>
						</div>
						{#if template.description}<p>{template.description}</p>{/if}
						<div class="mini-meta">{formatTime(template.createdAt)}</div>
					</article>
				{/each}
			{/if}
		</section>
	</div>
</div>

<style>
	.ffxiv-panel {
		display: grid;
		gap: 0.85rem;
		padding: 0.95rem;
		border-radius: 18px;
		color: var(--text-inverse, #e2e8f0);
		background:
			radial-gradient(circle at top right, rgba(var(--color-info-rgb, 56, 189, 248), 0.14), transparent 38%),
			rgba(var(--surface-app-rgb, 15, 23, 42), 0.9);
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.16);
		box-shadow: 0 18px 44px rgba(var(--surface-app-rgb, 15, 23, 42), 0.24);
		backdrop-filter: blur(14px);
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		gap: 0.8rem;
	}

	.eyebrow {
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-info, #7dd3fc);
	}

	h3,
	h4,
	h5,
	p {
		margin: 0;
	}

	h3 {
		font-size: 1.02rem;
		margin-top: 0.2rem;
	}

	p {
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.76);
	}

	.channel-pill {
		align-self: flex-start;
		padding: 0.28rem 0.5rem;
		border-radius: 999px;
		background: rgba(14, 165, 233, 0.18);
		color: var(--text-info, #bae6fd);
		font-size: 0.74rem;
		height: fit-content;
	}

	.search-card,
	.card-list,
	.lookup-card,
	.mini-card {
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.14);
		border-radius: 16px;
		background: rgba(var(--surface-base-rgb, 30, 41, 59), 0.72);
	}

	.search-card {
		padding: 0.8rem;
		display: grid;
		gap: 0.7rem;
	}

	.search-grid {
		display: grid;
		grid-template-columns: 1fr 1.4fr 1fr 1fr;
		gap: 0.55rem;
	}

	label {
		display: grid;
		gap: 0.25rem;
		font-size: 0.72rem;
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.82);
	}

	label span {
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 0.66rem;
	}

	input,
	select,
	textarea {
		width: 100%;
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.16);
		border-radius: 10px;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.68);
		color: var(--text-inverse, var(--text-inverse, #f8fafc));
		padding: 0.52rem 0.65rem;
		font: inherit;
	}

	.wide {
		grid-column: span 2;
	}

	.actions,
	.card-actions,
	.section-title,
	.mini-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.actions button,
	.card-actions button,
	.note-form button {
		border: 1px solid rgba(var(--color-info-rgb, 59, 130, 246), 0.24);
		border-radius: 10px;
		padding: 0.48rem 0.7rem;
		background: rgba(59, 130, 246, 0.16);
		color: var(--text-info, #dbeafe);
		cursor: pointer;
	}

	.actions button.ghost,
	.card-actions button.ghost {
		background: rgba(var(--surface-base-rgb, 30, 41, 59), 0.88);
		border-color: rgba(var(--text-muted-rgb, 148, 163, 184), 0.16);
		color: var(--text-inverse, #e2e8f0);
	}

	.actions button:disabled,
	.card-actions button:disabled,
	.note-form button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.status {
		padding: 0.7rem 0.85rem;
		border-radius: 12px;
		background: rgba(var(--surface-base-rgb, 30, 41, 59), 0.74);
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.12);
		color: var(--text-inverse, var(--text-inverse, #f8fafc));
		font-size: 0.84rem;
	}

	.two-col,
	.three-col {
		display: grid;
		gap: 0.85rem;
	}

	.two-col {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.three-col {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.card-list {
		display: grid;
		gap: 0.65rem;
		padding: 0.8rem;
		align-content: start;
	}

	.section-title h4 {
		font-size: 0.84rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-inverse, #e2e8f0);
	}

	.section-title span,
	.card-kind,
	.mini-meta {
		font-size: 0.72rem;
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.64);
	}

	.lookup-card,
	.mini-card {
		padding: 0.75rem;
		display: grid;
		gap: 0.55rem;
	}

	.lookup-card img {
		width: 36px;
		height: 36px;
		object-fit: cover;
		border-radius: 8px;
		margin-right: 0.55rem;
	}

	.card-top {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
	}

	.subtitle {
		color: var(--text-secondary, #cbd5e1);
		font-size: 0.78rem;
	}

	.detail {
		color: var(--text-inverse, #e2e8f0);
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.empty {
		padding: 0.85rem;
		border-radius: 12px;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.48);
		border: 1px dashed rgba(var(--text-muted-rgb, 148, 163, 184), 0.18);
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.72);
		font-size: 0.8rem;
		line-height: 1.45;
	}

	.note-form {
		display: grid;
		gap: 0.45rem;
	}

	.note-form textarea {
		resize: vertical;
		min-height: 96px;
	}

	.mini-card p {
		font-size: 0.8rem;
		line-height: 1.45;
	}

	@media (max-width: 1100px) {
		.search-grid,
		.two-col,
		.three-col {
			grid-template-columns: 1fr;
		}
	}
</style>
