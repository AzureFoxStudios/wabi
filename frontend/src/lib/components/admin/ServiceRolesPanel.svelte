<script lang="ts">
	import { _ } from '$lib/i18n';
    import { onMount, untrack } from 'svelte';
    import { activeServerUrl } from '$lib/serverUrl';
    import { currentUser, connected } from '$lib/socket';
    import { getAuthToken, authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
    import { serviceAccessRequest, type ServiceRole, type ServiceAccessSnapshot } from '$lib/api/serviceAccess';
    let snapshot = $state<ServiceAccessSnapshot | null>(null);
    let busy = $state(false), error = $state(''), notice = $state(''), newName = $state('');
    let renameId = $state(''), renameName = $state(''), deleteId = $state('');
    let sessionVersion = $state(0);
    let epoch = 0;
    const canEdit = $derived($connected && ['owner', 'admin'].includes($currentUser?.highestRole || ''));
    onMount(() => onAuthSessionCleared(() => { epoch++; sessionVersion++; snapshot = null; }));
    $effect(() => {
        const server = $activeServerUrl, actor = $currentUser?.dbUserId, enabled = canEdit, version = sessionVersion;
        untrack(() => { epoch++; snapshot = null; error = ''; notice = ''; newName = ''; renameId = ''; deleteId = ''; busy = false; if (enabled && actor) void request(); });
        return () => { epoch++; };
    });
    async function request(roles?: ServiceRole[], message = '') {
        const server = $activeServerUrl, actor = $currentUser?.dbUserId;
        const generation = authSessionGeneration(server), token = getAuthToken(server), ticket = ++epoch;
        if (!canEdit || !token || (roles && !snapshot)) return;
        const current = () => ticket === epoch && server === $activeServerUrl && actor === $currentUser?.dbUserId && generation === authSessionGeneration(server) && canEdit;
        busy = true; error = ''; notice = '';
        try {
            const result = await serviceAccessRequest(server, token, roles ? { revision: snapshot!.access.revision, roles } : undefined);
            if (!current()) return;
            snapshot = result; notice = message; renameId = ''; deleteId = '';
            if (message === $_('srp.role_created')) newName = '';
        } catch (e) { if (current()) error = e instanceof Error ? e.message : String(e); }
        finally { if (current()) busy = false; }
    }
    function change(id: string, patch: Partial<ServiceRole>) {
        if (!snapshot || busy) return;
        void request(snapshot.access.roles.map(r => r.id === id ? { ...r, ...patch } : r), $_('srp.role_saved'));
    }
    function toggle(role: ServiceRole, field: 'services' | 'members', value: string | number, checked: boolean) {
        if (field === 'services') change(role.id, { services: checked ? [...role.services, value as string] : role.services.filter(v => v !== value) });
        else change(role.id, { members: checked ? [...role.members, value as number] : role.members.filter(v => v !== value) });
    }
    function pick(role: ServiceRole, field: 'services' | 'members', value: string | number, input: HTMLInputElement) {
        const checked = input.checked;
        input.checked = field === 'services' ? role.services.includes(value as string) : role.members.includes(value as number);
        toggle(role, field, value, checked);
    }
    function closeable(node: HTMLDetailsElement) {
        const outside = (event: PointerEvent) => { if (!node.contains(event.target as Node)) node.open = false; };
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && node.open) { node.open = false; node.querySelector('summary')?.focus(); } };
        document.addEventListener('pointerdown', outside); node.addEventListener('keydown', escape);
        return { destroy() { document.removeEventListener('pointerdown', outside); node.removeEventListener('keydown', escape); } };
    }
    function create() {
        if (!snapshot || busy || !newName.trim()) return;
        void request([...snapshot.access.roles, { id: crypto.randomUUID(), name: newName.trim(), services: [], members: [] }], $_('srp.role_created'));
    }
    function remove(id: string) {
        if (!snapshot || busy) return;
        void request(snapshot.access.roles.filter(r => r.id !== id), $_('srp.role_deleted'));
    }
</script>

<section class="admin-section service-roles" aria-label={$_('srp.aria')} aria-busy={busy}>
    <h4>{$_('srp.heading')}</h4>
    <p>{$_('srp.desc')}</p>
    {#if error}<div role="alert" class="feedback"><span>{error}</span><button type="button" class="ui-btn ui-btn-secondary" disabled={busy || !canEdit} onclick={() => request()}>{$_('lore_roles.reload')}</button></div>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if !canEdit}<p role="status">{$_('srp.connect_admin')}</p>
    {:else if !snapshot && !error}<p role="status">{$_('srp.loading')}</p>
    {:else if snapshot}
        {#if snapshot.services.length === 0}<p class="hint">{$_('srp.no_services')}</p>{/if}
        <ul class="roles">
            {#each snapshot.access.roles as role (role.id)}
                {@const builtin = role.id.startsWith('builtin:')}
                <li>
                    <div class="row">
                        {#if renameId === role.id}
                            <form class="rename" onsubmit={(e) => { e.preventDefault(); change(role.id, { name: renameName.trim() }); }}>
                                <input aria-label={$_('lore_roles.role_name')} maxlength="40" bind:value={renameName} disabled={busy} />
                                <button class="ui-btn ui-btn-primary" disabled={busy || !renameName.trim()}>{$_('srp.save_name')}</button>
                                <button class="ui-btn ui-btn-secondary" type="button" disabled={busy} onclick={() => renameId = ''}>{$_('common.cancel')}</button>
                            </form>
                        {:else}<div class="name"><strong>{role.name}</strong><small>{builtin ? $_('srp.builtin') : $_('srp.custom')}</small></div>{/if}
                        <details class="picker" use:closeable>
                            <summary aria-label={$_('srp.services_for', { values: { name: role.name } })}>{$_('srp.services')} <span>{role.services.length}</span></summary>
                            <div class="choices">
                                {#each snapshot.services as service (service.id)}
                                    <label><input type="checkbox" checked={role.services.includes(service.id)} disabled={busy} onchange={(e) => pick(role, 'services', service.id, e.currentTarget)} /><span>{service.name}<small>{service.exposed ? service.kind : $_('srp.not_exposed')}</small></span></label>
                                {/each}
                                {#each role.services.filter(id => !snapshot!.services.some(s => s.id === id)) as id}
                                    <label><input type="checkbox" checked disabled={busy} onchange={(e) => pick(role, 'services', id, e.currentTarget)} /><span>{id}<small>{$_('srp.no_longer')}</small></span></label>
                                {/each}
                                {#if !snapshot.services.length && !role.services.length}<p>{$_('srp.no_registered')}</p>{/if}
                            </div>
                        </details>
                        {#if !builtin}
                            <details class="picker" use:closeable>
                                <summary aria-label={$_('srp.members_for', { values: { name: role.name } })}>{$_('group_settings.members')} <span>{role.members.length}</span></summary>
                                <div class="choices">
                                    {#each snapshot.members as member (member.id)}
                                        <label><input type="checkbox" checked={role.members.includes(member.id)} disabled={busy} onchange={(e) => pick(role, 'members', member.id, e.currentTarget)} />{member.name}</label>
                                    {/each}
                                    {#each role.members.filter(id => !snapshot!.members.some(m => m.id === id)) as id}
                                        <label><input type="checkbox" checked disabled={busy} onchange={(e) => pick(role, 'members', id, e.currentTarget)} />{$_('srp.unavail_member', { values: { id } })}</label>
                                    {/each}
                                </div>
                            </details>
                            <button type="button" class="ui-btn ui-btn-secondary" disabled={busy} onclick={() => { renameId = role.id; renameName = role.name; }}>{$_('forum_channel.rename_btn')}</button>
                            <button type="button" class="ui-btn ui-btn-secondary" disabled={busy} onclick={() => deleteId = role.id}>{$_('admin.actions.delete')}</button>
                        {/if}
                    </div>
                    {#if deleteId === role.id}
                        <div class="feedback" role="alert"><span>{$_('srp.delete_confirm', { values: { name: role.name, count: role.members.length } })}</span><button type="button" class="ui-btn ui-btn-danger" disabled={busy} onclick={() => remove(role.id)}>{$_('srp.delete_role')}</button><button type="button" class="ui-btn ui-btn-secondary" disabled={busy} onclick={() => deleteId = ''}>{$_('common.cancel')}</button></div>
                    {/if}
                </li>
            {/each}
        </ul>
        <form class="create" onsubmit={(e) => { e.preventDefault(); create(); }}>
            <input aria-label={$_('srp.new_role_aria')} placeholder={$_('srp.new_role_aria')} maxlength="40" bind:value={newName} disabled={busy} />
            <button class="ui-btn ui-btn-primary" disabled={busy || !newName.trim()}>{$_('lore_roles.create_role')}</button>
        </form>
        <p class="hint">{$_('srp.grants_hint')}</p>
    {/if}
</section>

<style>
    .service-roles { min-width: 0; }
    p { color: var(--w-mute); line-height: 1.5; text-wrap: pretty; }
    .roles { list-style: none; margin: var(--space-3) 0; padding: 0; }
    li { border-bottom: 1px solid var(--w-line); padding: var(--space-2) 0; }
    .row, .create, .rename, .feedback { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .row { position: relative; }
    .name { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
    small { display: block; color: var(--w-mute); font-size: var(--font-size-xs); }
    button, summary, input:not([type=checkbox]) { min-height: 40px; }
    input:not([type=checkbox]) { max-width: 100%; min-width: 0; padding: var(--space-2); background: var(--w-sink); color: var(--w-text); border: 1px solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); }
    .picker { position: relative; }
    summary { cursor: pointer; border: 1px solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); padding: var(--space-2); box-sizing: border-box; }
    summary span { font-variant-numeric: tabular-nums; color: var(--w-mute); }
    .choices { position: absolute; inset-inline-end: 0; top: calc(100% + var(--space-1)); z-index: var(--z-dropdown); width: min(20rem, 75vw); max-height: 18rem; overflow: auto; padding: var(--space-2); border: 1px solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-raise); box-shadow: 0 8px 24px rgb(0 0 0 / 25%); }
    label { display: flex; align-items: center; gap: var(--space-2); min-height: 40px; cursor: pointer; overflow-wrap: anywhere; }
    label input { flex-shrink: 0; }
    .hint { font-size: var(--font-size-sm); }
    .feedback { margin: var(--space-2) 0; }
    .feedback span { flex: 1 1 15rem; }
    summary:focus-visible, input:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
    @media (max-width: 600px) { .name { flex-basis: 8rem; } .picker { position: static; } .choices { inset-inline-start: 0; inset-inline-end: auto; width: min(20rem, 100%); } button, summary, label { min-height: 44px; } }
</style>
