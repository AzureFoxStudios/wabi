<script lang="ts">
	import { _ } from '$lib/i18n';
	import ServiceRolesPanel from "./ServiceRolesPanel.svelte";
	import CommunityRolesPanel from "./CommunityRolesPanel.svelte";
	import { badgeCatalog } from '$lib/socket';
	import type { AdminRoleDefinition } from '$lib/adminRoleCatalog';
	let { roleDefinitions, loading = false, error = '', onRetry, onOpenPeople }: {
		roleDefinitions: AdminRoleDefinition[];
		loading?: boolean;
		error?: string;
		onRetry: () => void;
		onOpenPeople: () => void;
	} = $props();
	type Tab = 'staff' | 'community' | 'service' | 'badges';
	let tab = $state<Tab>('community');
	const TABS: Array<[Tab, string, string]> = [
		['community', $_('rnp.tab_community'), $_('rnp.tab_community_hint')],
		['staff', $_('rnp.tab_staff'), $_('rnp.tab_staff_hint')],
		['service', $_('rnp.tab_service'), $_('rnp.tab_service_hint')],
		['badges', $_('profile_settings.badges_heading'), $_('rnp.tab_badges_hint')]
	];
</script>

<section class="roles-center" aria-labelledby="roles-center-title">
	<header class="rc-head">
		<h3 id="roles-center-title">{$_('rnp.heading')}</h3>
		<p>{$_('rnp.intro')}</p>
	</header>
	<div class="w-seg rc-tabs" role="tablist" aria-label={$_('rnp.aria_kinds')}>
		{#each TABS as [id, label]}
			<button type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onclick={() => (tab = id)}>{label}</button>
		{/each}
	</div>
	<p class="rc-tabhint">{TABS.find(([id]) => id === tab)?.[2]}</p>

	{#if tab === 'community'}
		<CommunityRolesPanel />
	{:else if tab === 'staff'}
		<section class="rc-card" aria-label={$_('rnp.server_roles')} aria-busy={loading}>
			<div class="rc-row-head"><p>{$_('rnp.staff_desc')}</p><button class="w-btn" type="button" onclick={onOpenPeople}>{$_('rnp.manage_people')}</button></div>
			{#if error}
				<div class="rc-feedback" role="alert"><p>{error}</p><button class="w-btn" onclick={onRetry}>Try again</button></div>
			{:else if loading && roleDefinitions.length === 0}
				<p class="rc-feedback" role="status">{$_('rnp.loading_roles')}</p>
			{:else if roleDefinitions.length === 0}
				<div class="rc-feedback" role="status"><p>{$_('rnp.no_catalog')}</p><button class="w-btn" onclick={onRetry}>{$_('lore_roles.reload')}</button></div>
			{:else}
				<ol class="rc-ladder">
					{#each roleDefinitions as role, index (role.roleName)}
						<li><span class="rc-rank w-mono">{String(index + 1).padStart(2, '0')}</span><div><strong>{role.displayName}</strong>{#if role.description}<p>{role.description}</p>{/if}</div></li>
					{/each}
				</ol>
				<p class="rc-note">{$_('rnp.builtin_fixed')} <button type="button" class="rc-link" onclick={() => (tab = 'community')}>{$_('rnp.tab_community')}</button>.</p>
			{/if}
		</section>
	{:else if tab === 'service'}
		<ServiceRolesPanel />
	{:else}
		<section class="rc-card" aria-label={$_('profile_settings.badges_heading')}>
			<p>{$_('rnp.badges_intro')} <button type="button" class="rc-link" onclick={onOpenPeople}>{$_('places.people')}</button> {$_('rnp.badges_how')}</p>
			<ul class="rc-badges">
				{#each $badgeCatalog as badge (badge.id)}
					<li><span class="rc-glyph" aria-hidden="true">{badge.icon}</span><div><strong>{badge.label}</strong><small class="w-mono">{badge.id}</small></div></li>
				{/each}
			</ul>
			<p class="rc-note">{$_('rnp.fixed_badges')}</p>
		</section>
	{/if}
</section>

<style>
	.roles-center { display: grid; gap: 12px; margin-bottom: 18px; }
	.rc-head h3 { margin: 0; font: 600 calc(22px * var(--w-fs, 1))/1.2 var(--w-serif); color: var(--w-text); }
	.rc-head p, .rc-tabhint, .rc-note, .rc-card p, .rc-feedback { margin: 4px 0 0; font: 400 calc(13.5px * var(--w-fs, 1))/1.55 var(--w-sans); color: var(--w-mute); }
	.rc-tabs { justify-self: start; flex-wrap: wrap; }
	.rc-tabhint { margin: -4px 0 4px; font-family: var(--w-mono); font-size: calc(12px * var(--w-fs, 1)); color: var(--w-faint); }
	.rc-card { padding: 18px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-bg2); }
	.rc-row-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
	.rc-row-head p { margin: 0; flex: 1 1 18rem; }
	.rc-ladder { list-style: none; margin: 0; padding: 0; }
	.rc-ladder li { display: flex; gap: 14px; align-items: baseline; padding: 12px 0; border-top: var(--w-bw, 1px) solid var(--w-line); }
	.rc-ladder li:first-child { border-top: 0; }
	.rc-rank { font-size: calc(12px * var(--w-fs, 1)); color: var(--w-faint); }
	.rc-ladder strong, .rc-badges strong { font: 600 calc(15px * var(--w-fs, 1)) var(--w-sans); color: var(--w-text); }
	.rc-ladder p { margin: 2px 0 0; }
	.rc-badges { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
	.rc-badges li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-bg); }
	.rc-badges small { display: block; color: var(--w-faint); font-size: calc(11px * var(--w-fs, 1)); }
	.rc-glyph { font-size: 20px; width: 28px; text-align: center; }
	.rc-link { border: 0; background: none; padding: 0; color: var(--w-accent); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
	.rc-feedback { display: grid; justify-items: start; gap: 10px; }
</style>
