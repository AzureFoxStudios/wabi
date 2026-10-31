<!--
	An office tool's library (design contract §8.8): a top-aligned 880 column. Display title with
	PREVIEW, one truth line, New / Open file…, then "On this device" and "Shared with you" with mono
	counts and lift cards. Real states: skeleton while loading, an error notice in the Shared
	section when the server can't be reached (never "No shared documents"), and empty states in
	the tool's own nouns.
-->
<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { listLocal } from './session';
	import { request, openWorkspace, type Scope, type ArtifactKind, type Meta } from './bridge';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { _ } from '$lib/i18n';

	let {
		scope,
		kind,
		label,
		onopen,
		onnew,
		onimport,
		accept,
		importOptions
	}: {
		scope: Scope;
		kind: ArtifactKind;
		label: string;
		onopen: (id: string) => void;
		onnew: () => void;
		onimport: (file: File) => void;
		accept: string;
		/** Extra import choices shown beside Open file… (Sheets: the CSV delimiter). */
		importOptions?: Snippet;
	} = $props();

	const NOUNS: Record<ArtifactKind, { one: string; many: string }> = {
		document: { one: 'document', many: 'documents' },
		sheets: { one: 'spreadsheet', many: 'spreadsheets' },
		present: { one: 'presentation', many: 'presentations' }
	};
	const noun = $derived(NOUNS[kind]);

	let local = $state<{ id: string; title: string; updatedAt: number }[]>([]);
	let shared = $state<Meta[]>([]);
	let localLoading = $state(true), sharedLoading = $state(true);
	let localError = $state(''), sharedError = $state(''), addressError = $state('');
	let address = $state('');
	let fileInput: HTMLInputElement;

	async function refreshShared() {
		sharedLoading = true;
		sharedError = '';
		try {
			const data = await request<{ artifacts: Meta[] }>(scope, '/artifacts');
			if (scope.isCurrent()) shared = data.artifacts.filter((a) => a.kind === kind);
		} catch (e) {
			if (scope.isCurrent()) sharedError = e instanceof Error ? e.message : String(e);
		} finally {
			sharedLoading = false;
		}
	}
	async function refresh() {
		localLoading = true;
		localError = '';
		try {
			const rows = await listLocal(scope, kind);
			if (scope.isCurrent()) local = rows;
		} catch (e) {
			localError = e instanceof Error ? e.message : String(e);
		} finally {
			localLoading = false;
		}
		await refreshShared();
	}
	function openAddress() {
		addressError = '';
		try {
			let id = address.trim();
			if (id.includes('://')) {
				const url = new URL(id);
				if (new URL(scope.server).origin !== url.origin) throw new Error('Switch to the server in this link before opening its document.');
				id = url.searchParams.get('workspaceArtifact') || '';
			}
			if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Paste a Wabi ${noun.one} link or ID.`);
			onopen(id);
		} catch (e) {
			addressError = e instanceof Error ? e.message : String(e);
		}
	}
	const edited = (at: number) => {
		const date = new Date(at);
		const today = new Date();
		const sameDay = date.toDateString() === today.toDateString();
		return sameDay
			? `Edited ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)}`
			: `Edited ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date)}`;
	};
	const roleWord = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
	onMount(() => { void refresh(); });
</script>

<div class="workspace-library">
	<div class="workspace-library__column">
		<header class="workspace-library__head">
			<h1 class="workspace-library__title">{label}</h1>
			<span class="w-tag w-tag--mat" title={$_('maturity.preview_title')}>{$_('maturity.preview')}</span>
		</header>
		<p class="workspace-library__truth">Private on this device until you share. Shared {noun.many} are server-readable.</p>
		<div class="workspace-toolbar workspace-library__actions">
			<button type="button" class="w-btn w-btn--primary" onclick={onnew}><Icon name="plus" size={16} />New {noun.one}</button>
			<button type="button" class="w-btn" onclick={() => fileInput.click()}><Icon name="upload" size={16} />Open file…</button>
			{@render importOptions?.()}
			{#if kind === 'present'}
				<!-- Presentations shared with you open from their link; this joins one by its link. -->
				<button type="button" class="w-btn w-btn--quiet" onclick={() => openWorkspace('audience')}><Icon name="present" size={16} />Join a presentation</button>
			{/if}
		</div>
		<input class="workspace-file-input" type="file" {accept} bind:this={fileInput} onchange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) onimport(file); }} />

		<section class="workspace-library__section" aria-labelledby={`lib-local-${kind}`}>
			<h2 class="workspace-library__section-title" id={`lib-local-${kind}`}>On this device <span class="workspace-library__count">{localLoading ? '' : local.length}</span></h2>
			{#if localLoading}
				<Skeleton variant="card" rows={3} label={`Loading ${noun.many} on this device`} class="workspace-library__skeleton" />
			{:else if localError}
				<Notice title={`Couldn't list the ${noun.many} on this device`} text="Nothing was changed. Try again in a moment." onretry={() => void refresh()} error={localError} />
			{:else if local.length}
				<div class="workspace-library__cards">
					{#each local as item (item.id)}
						<button type="button" class="workspace-card" onclick={() => onopen(item.id)}>
							<span class="workspace-card__title">{item.title}</span>
							<span class="workspace-card__meta">{edited(item.updatedAt)}</span>
						</button>
					{/each}
				</div>
			{:else}
				<div class="workspace-library__empty">
					<p class="workspace-library__empty-title">No {noun.many} on this device yet</p>
					<p class="workspace-library__empty-text">Start a {noun.one}. It stays on this device until you share it.</p>
					<button type="button" class="w-btn" onclick={onnew}>Start a {noun.one}</button>
				</div>
			{/if}
		</section>

		<section class="workspace-library__section" aria-labelledby={`lib-shared-${kind}`}>
			<div class="workspace-library__section-head">
				<h2 class="workspace-library__section-title" id={`lib-shared-${kind}`}>Shared with you <span class="workspace-library__count">{sharedLoading || sharedError ? '' : shared.length}</span></h2>
				<Tooltip text="Refresh the shared list" placement="bottom">
					<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Refresh library" disabled={sharedLoading} onclick={() => void refreshShared()}><Icon name="refresh" /></button>
				</Tooltip>
			</div>
			{#if sharedLoading}
				<Skeleton variant="card" rows={2} label={`Loading shared ${noun.many}`} class="workspace-library__skeleton" />
			{:else if sharedError}
				<Notice title={`Couldn't reach the shared ${noun.many} on this server`} text={`Your ${noun.many} on this device are unaffected.`} onretry={() => void refreshShared()} error={sharedError} />
			{:else if shared.length}
				<div class="workspace-library__cards">
					{#each shared as item (item.id)}
						<button type="button" class="workspace-card" onclick={() => onopen(item.id)}>
							<span class="workspace-card__title">{item.title}</span>
							<span class="workspace-card__meta">
								<span class="w-seal workspace-card__seal"><Icon name="lockOpen" />Server-readable</span>
								<span>{roleWord(item.role)} · {item.mode === 'live' ? 'Collaborative' : 'Snapshot'}</span>
							</span>
						</button>
					{/each}
				</div>
			{:else}
				<p class="workspace-library__empty-text">Nothing has been shared with you here yet.</p>
			{/if}
			<form class="workspace-library__open" onsubmit={(event) => { event.preventDefault(); openAddress(); }}>
				<label class="w-field workspace-library__address"><Icon name="link" /><input aria-label="Document link or ID" placeholder="Paste a Wabi link to open it" bind:value={address} /></label>
				<button type="submit" class="w-btn" disabled={!address.trim()}>Open shared {noun.one}</button>
			</form>
			{#if addressError}<p class="workspace-library__error" role="alert"><Icon name="alert" size={16} />{addressError}</p>{/if}
		</section>
	</div>
</div>
