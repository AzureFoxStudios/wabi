<!--
	The stage masthead (design contract §7.23, §8.2): one component, mounted once by MainLayout
	above every center-stage workspace except Server home and the DM hub, and never unmounted on
	view switches, so the folio never moves and the channel context stays where it is.

	- Height --w-mast (96): row A (56) names the object, row B (40) is the folio. Its bottom
	  hairline is the masthead rule that the sidebar and the companion share at y = 96.
	- Row A comes from `stageHeader` (lib/stageHeader.ts) when the active workspace describes it:
	  title + scope tags + "Saved 09:41" status + kit actions, or a whole component (the office
	  editor header) with its props. Otherwise the built-in row A applies: the channel / DM row
	  (chat/ChatHeader.svelte) for the channel views, the workspace's own name for the rest.
	- Phone shell (≤768px): one 52px bar: the channel title, then the "Chat ▾" workspace button
	  that names the current workspace, then search; no folio row.
	- Stage-width layout uses `@container stage` (stagebar.css sets the container on .chat-stack).
-->
<script lang="ts">
	import { _ } from '$lib/i18n';
	import { isMobile } from '$lib/layoutStoreStates';
	import { activeWorkspaceView } from '$lib/workspaceNavigationState';
	import { stageHeader, type StageHeaderAction, type StageHeaderTag } from '$lib/stageHeader';
	import { channels, currentChannel } from '$lib/socket';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { OFFICE_TAB_LABEL, workspaceToolFromTab } from '$lib/workspaces/bridge';
	import { readerSelection } from '$lib/readerWorkspace';
	import { modelViewportSelection } from '$lib/modelViewportTab';
	import { focusedMapPlace } from '$lib/mapWorkspace';
	import type { WorkspaceViewKey } from './chat/types';
	import type { IconName } from './ui/icons';
	import ChatHeader from './chat/ChatHeader.svelte';
	import WorkspaceViewBar from './WorkspaceViewBar.svelte';
	import Icon from './ui/Icon.svelte';
	import Tooltip from './ui/Tooltip.svelte';

	let {
		activityBadge = '',
		onSelectView
	}: {
		activityBadge?: string;
		onSelectView: (view: WorkspaceViewKey) => void;
	} = $props();

	const { activeTabId } = mobileTabQueue;
	const view = $derived($activeWorkspaceView);
	const phone = $derived($isMobile);
	const channelKind = $derived($channels.find((channel) => channel.id === $currentChannel)?.type ?? null);
	// The channel views keep the channel's own row A (§7.10 group "This channel").
	const channelView = $derived(view === 'messages' || view === 'whiteboard');
	const header = $derived($stageHeader);

	type DefaultHeader = { title: string; crumb?: string; preview?: boolean };
	const fallback = $derived.by<DefaultHeader>(() => {
		switch (view) {
			case 'planner': return { title: $_('places.my_planner') };
			case 'notes': return { title: $_('places.notes') };
			case 'files': return { title: $_('places.files') };
			case 'notifications': return { title: $_('places.activity') };
			case 'voice': return { title: $_('places.calls') };
			case 'lore': return { title: $_('places.project') };
			case 'media': return { title: $_('places.media') };
			case 'reader':
				return $readerSelection?.title ? { crumb: $_('places.reader'), title: $readerSelection.title } : { title: $_('places.reader') };
			case 'model':
				return $modelViewportSelection?.fileName
					? { crumb: $_('places.model_viewer'), title: $modelViewportSelection.fileName }
					: { title: $_('places.model_viewer') };
			case 'map':
				return $focusedMapPlace?.name ? { crumb: $_('places.map'), title: $focusedMapPlace.name } : { title: $_('places.map') };
			case 'documents':
			case 'sheets':
			case 'present': {
				// A joined presentation is part of Present; its crumb is "Presentation".
				const tool = workspaceToolFromTab($activeTabId);
				return { title: tool ? OFFICE_TAB_LABEL[tool] : $_(`places.${view}`), preview: true };
			}
			default: return { title: '' };
		}
	});

	const SEAL_GLYPH: Record<string, IconName> = { 'Encryption pending': 'hourglass', 'Experimental encryption': 'lock' };

	function sealGlyph(tag: StageHeaderTag): IconName {
		return SEAL_GLYPH[tag.label] ?? 'lockOpen';
	}

	function actionClass(action: StageHeaderAction): string {
		if (action.iconOnly) return 'w-ibtn';
		if (action.variant === 'primary') return 'w-btn w-btn--primary';
		if (action.variant === 'danger') return 'w-btn w-btn--danger w-btn--sm';
		if (action.variant === 'quiet') return 'w-btn w-btn--quiet';
		return 'w-btn';
	}
</script>

{#snippet workspaceButton()}
	{#if phone}
		<WorkspaceViewBar variant="trigger" activeView={view} {onSelectView} {activityBadge} {channelKind} canOpenWhiteboard={Boolean($currentChannel)} />
	{/if}
{/snippet}

{#snippet tags(scope: readonly StageHeaderTag[])}
	{#each scope as tag (tag.label)}
		{#if tag.kind === 'seal'}
			<span class="w-seal stage-a__chip" title={tag.title}><Icon name={sealGlyph(tag)} />{tag.label}</span>
		{:else if tag.kind === 'maturity'}
			<span class="w-tag w-tag--mat stage-a__chip" title={tag.title ?? $_('maturity.preview_title')}>{tag.label}</span>
		{:else}
			<span class="w-tag stage-a__chip" title={tag.title}>{tag.label}</span>
		{/if}
	{/each}
{/snippet}

{#snippet actions(list: readonly StageHeaderAction[])}
	{#if list.length}
		<div class="stage-a__actions">
			{#each list as action (action.id)}
				{#if action.iconOnly}
					<Tooltip text={action.label} shortcut={action.shortcut} placement="bottom">
						<button
							type="button"
							class={actionClass(action)}
							aria-label={action.label}
							aria-pressed={action.pressed}
							disabled={action.disabled}
							onclick={(event) => action.onSelect(event.currentTarget)}
						>
							{#if action.icon}<Icon name={action.icon} />{/if}
						</button>
					</Tooltip>
				{:else}
					<button
						type="button"
						class={actionClass(action)}
						aria-pressed={action.pressed}
						disabled={action.disabled}
						onclick={(event) => action.onSelect(event.currentTarget)}
					>
						{#if action.icon}<Icon name={action.icon} size={16} />{/if}{action.label}
					</button>
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<div class="stage-bar" class:stage-bar--phone={phone} data-view={view}>
	<div class="stage-bar__a stage-a">
		{#if header?.component}
			{@const HeaderComponent = header.component}
			<div class="stage-a__lead stage-a__lead--component">
				<HeaderComponent {...header.props} />
				{@render workspaceButton()}
			</div>
			{@render actions(header.actions)}
		{:else if header}
			<div class="stage-a__lead">
				<h2 class="stage-a__title"><span class="stage-a__name">{header.title}</span></h2>
				{@render workspaceButton()}
				{@render tags(header.scope)}
				{#if header.status}<span class="stage-a__status" role="status">{header.status}</span>{/if}
			</div>
			{@render actions(header.actions)}
		{:else if (channelView || phone) && $currentChannel}
			<!-- The phone bar always names the channel; its "Chat ▾" button names the workspace (§8.12). -->
			<ChatHeader channelId={$currentChannel} {view} trail={workspaceButton} />
		{:else}
			<div class="stage-a__lead">
				{#if fallback.crumb}
					<span class="stage-a__crumb">{fallback.crumb}</span>
					<Icon name="chevRight" size={14} class="stage-a__crumb-sep" />
				{/if}
				<h2 class="stage-a__title"><span class="stage-a__name">{fallback.title}</span></h2>
				{#if fallback.preview}<span class="w-tag w-tag--mat stage-a__chip" title={$_('maturity.preview_title')}>{$_('maturity.preview')}</span>{/if}
				{@render workspaceButton()}
			</div>
		{/if}
	</div>
	{#if !phone}
		<div class="stage-bar__b">
			<WorkspaceViewBar activeView={view} {onSelectView} {activityBadge} {channelKind} canOpenWhiteboard={Boolean($currentChannel)} />
		</div>
	{/if}
</div>
