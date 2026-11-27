<script lang="ts">
	/**
	 * The members' agreement to server-readable albums in one private conversation.
	 *
	 * `variant="panel"` fills the Albums surface while albums are closed; `variant="notice"` is the
	 * line in the conversation that tells a member someone asked. Each member agrees or withdraws
	 * for themselves; albums open while every current member has agreed (the server decides).
	 */
	import { _ } from '$lib/i18n';
	import { showToast } from '$lib/toast';
	import { cachedE2eeStatus, e2eeStatusRevision, setRoomAlbumsAgreement } from '$lib/dm/dmE2eeState';
	import { albumsAgreementView } from './albumsAgreementView';

	export let channelId: string;
	export let variant: 'panel' | 'notice' | 'open' = 'panel';
	/** Notice only: open the Albums surface, where the full explanation is. */
	export let onOpenAlbums: (() => void) | undefined = undefined;

	let busy = false;
	function statusAt(id: string, _revision: number) {
		return cachedE2eeStatus(id);
	}
	$: view = albumsAgreementView(statusAt(channelId, $e2eeStatusRevision));

	async function choose(agree: boolean) {
		if (busy) return;
		busy = true;
		try {
			await setRoomAlbumsAgreement(channelId, agree);
		} catch (error) {
			console.error('Albums agreement failed:', error);
			showToast($_('albums_agreement.failed'), 'error');
		} finally {
			busy = false;
		}
	}
</script>

{#if variant === 'notice'}
	{#if view.askedByOthers}
		<div class="w-notice w-notice--info albums-agreement-notice" role="status">
			<p class="w-notice__title">{$_('albums_agreement.asked_title')}</p>
			<p class="w-notice__text">{$_('albums_agreement.asked_text')}</p>
			<div class="w-notice__actions">
				<button type="button" class="w-btn w-btn--sm" disabled={busy} on:click={() => void choose(true)}>{$_('albums_agreement.agree')}</button>
				{#if onOpenAlbums}
					<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={onOpenAlbums}>{$_('albums_agreement.details')}</button>
				{/if}
			</div>
		</div>
	{/if}
{:else if variant === 'open'}
	{#if view.agreedByMe}
		<p class="albums-agreement-open">
			{$_('albums_agreement.open_note')}
			<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={busy} on:click={() => void choose(false)}>{$_('albums_agreement.withdraw')}</button>
		</p>
	{/if}
{:else}
	<div class="albums-agreement" role="group" aria-labelledby="albums-agreement-title">
		<h3 id="albums-agreement-title">{$_('albums_agreement.title')}</h3>
		<p>{$_('albums_agreement.explain')}</p>
		<p>{$_('albums_agreement.rule')}</p>
		<p class="albums-agreement__count" role="status">
			{#if view.agreedByMe}
				{$_('albums_agreement.waiting', { values: { n: view.waitingFor } })}
			{:else if view.askedByOthers}
				{$_('albums_agreement.others_agreed', { values: { n: view.agreedCount } })}
			{:else}
				{$_('albums_agreement.nobody')}
			{/if}
		</p>
		{#if view.agreedByMe}
			<button type="button" class="w-btn w-btn--quiet" disabled={busy} on:click={() => void choose(false)}>{$_('albums_agreement.withdraw')}</button>
		{:else}
			<button type="button" class="w-btn" disabled={busy} on:click={() => void choose(true)}>{$_('albums_agreement.agree')}</button>
		{/if}
	</div>
{/if}

<style>
	.albums-agreement {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding: 16px;
		max-width: 46ch;
		line-height: 1.45;
	}
	.albums-agreement h3,
	.albums-agreement p {
		margin: 0;
	}
	.albums-agreement__count {
		font-weight: 600;
	}
	.albums-agreement-open {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-size: 12px;
		color: var(--w-dim, inherit);
	}
	.albums-agreement-notice {
		margin: 0 0 8px;
	}
</style>
