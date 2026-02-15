<script lang="ts">
  import { currentUser, getSocket } from '$lib/socket';

  type Scope = 'channel' | 'category' | 'tag_forum';
  type SubjectType = 'everyone' | 'role' | 'user';

  const bits = [
    { value: 1, label: 'View Channel' },
    { value: 2, label: 'Send Messages' },
    { value: 4, label: 'Manage Channels' },
    { value: 8, label: 'Manage Roles' },
    { value: 16, label: 'Manage Group Members' },
    { value: 32, label: 'Manage Overwrites' },
    { value: 64, label: 'Manage Group Avatar' }
  ];

  let scope: Scope = 'channel';
  let resourceId = 'general';
  let subjectType: SubjectType = 'everyone';
  let subjectId = 'everyone';
  let allowBits = 0;
  let denyBits = 0;
  let overwrites: any[] = [];
  let warning = '';
  let status = '';

  let roleName = 'member';
  let roleAllowBits = 0;
  let roleDenyBits = 0;
  let roleRows: any[] = [];

  let previewResourceId = 'general';
  let previewTargetUserId = '';
  let previewRoleNames = 'member';
  let previewResult: any = null;

  $: isAdmin = ['owner', 'admin'].includes($currentUser?.highestRole || '');
  $: hasConflict = (allowBits & denyBits) !== 0;
  $: hasRoleConflict = (roleAllowBits & roleDenyBits) !== 0;

  function toggleBit(current: number, bit: number): number {
    return (current & bit) === bit ? (current & ~bit) : (current | bit);
  }

  function emitWithCallback(event: string, payload: any): Promise<any> {
    return new Promise((resolve) => {
      const sock = getSocket();
      if (!sock) {
        resolve({ success: false, error: 'Not connected' });
        return;
      }
      sock.emit(event, payload, (response: any) => resolve(response));
    });
  }

  async function loadOverwrites() {
    const res = await emitWithCallback('list-permission-overwrites', { scope, resourceId });
    if (!res.success) {
      status = res.error || 'Failed to load overwrites';
      return;
    }
    overwrites = res.overwrites || [];
    status = `Loaded ${overwrites.length} overwrite(s)`;
  }

  async function saveOverwrite() {
    if (hasConflict) {
      warning = 'Deny/allow overlap detected. This can leak access assumptions. Resolve conflicts before saving.';
      return;
    }
    warning = '';
    const res = await emitWithCallback('upsert-permission-overwrite', { scope, resourceId, subjectType, subjectId, allowBits, denyBits });
    if (!res.success) {
      status = res.error || 'Failed to save overwrite';
      return;
    }
    status = res.warning || 'Overwrite saved';
    await loadOverwrites();
  }

  async function removeOverwrite(row: any) {
    const res = await emitWithCallback('delete-permission-overwrite', {
      scope,
      resourceId,
      subjectType: row.subject_type,
      subjectId: row.subject_id
    });
    status = res.success ? 'Overwrite deleted' : (res.error || 'Failed to delete overwrite');
    await loadOverwrites();
  }

  async function loadRoleBasePermissions() {
    const res = await emitWithCallback('list-role-base-permissions', {});
    if (!res.success) {
      status = res.error || 'Failed to load role base permissions';
      return;
    }
    roleRows = res.rows || [];
  }

  async function saveRoleBasePermissions() {
    if (hasRoleConflict) {
      warning = 'Role base permission has deny/allow overlap. Fix overlap before saving.';
      return;
    }
    warning = '';
    const res = await emitWithCallback('upsert-role-base-permission', {
      roleName,
      allowBits: roleAllowBits,
      denyBits: roleDenyBits
    });
    status = res.success ? (res.warning || 'Role base permissions saved') : (res.error || 'Failed to save role base permissions');
    await loadRoleBasePermissions();
  }

  async function previewPermissions() {
    const payload: any = {
      resourceId: previewResourceId,
      context: { channelId: previewResourceId }
    };

    if (previewTargetUserId.trim()) {
      payload.targetUserId = Number(previewTargetUserId);
    } else {
      payload.roleNames = previewRoleNames.split(',').map(v => v.trim()).filter(Boolean);
    }

    const res = await emitWithCallback('preview-effective-permissions', payload);
    if (!res.success) {
      status = res.error || 'Failed to preview permissions';
      return;
    }

    previewResult = res.preview;
    status = 'Preview updated';
  }

  $: if (isAdmin) {
    // lazy background refresh
    if (overwrites.length === 0) {
      void loadOverwrites();
      void loadRoleBasePermissions();
    }
  }
</script>

{#if isAdmin}
  <div class="settings-section">
    <h3>🔐 Permission Overwrites</h3>
    <p class="muted">Edit role base permissions and resource overwrites with precedence-aware preview.</p>

    {#if warning}
      <div class="warning">⚠️ {warning}</div>
    {/if}
    {#if status}
      <div class="muted">{status}</div>
    {/if}

    <div class="row">
      <select bind:value={scope}>
        <option value="channel">Channel</option>
        <option value="category">Category</option>
        <option value="tag_forum">Tag/Forum</option>
      </select>
      <input bind:value={resourceId} placeholder="Resource ID" />
      <button on:click={loadOverwrites}>Load</button>
    </div>

    <div class="row">
      <select bind:value={subjectType}>
        <option value="everyone">everyone</option>
        <option value="role">role</option>
        <option value="user">user</option>
      </select>
      <input bind:value={subjectId} placeholder="subject id (role name or user id)" />
    </div>

    <div class="bits-grid">
      <div>
        <strong>Allow</strong>
        {#each bits as bit}
          <label><input type="checkbox" checked={(allowBits & bit.value) === bit.value} on:change={() => allowBits = toggleBit(allowBits, bit.value)} /> {bit.label}</label>
        {/each}
      </div>
      <div>
        <strong>Deny</strong>
        {#each bits as bit}
          <label><input type="checkbox" checked={(denyBits & bit.value) === bit.value} on:change={() => denyBits = toggleBit(denyBits, bit.value)} /> {bit.label}</label>
        {/each}
      </div>
    </div>

    <button on:click={saveOverwrite} disabled={hasConflict}>Save Overwrite</button>

    <ul>
      {#each overwrites as row}
        <li>
          {row.subject_type}:{row.subject_id} — allow {row.allow_bits} / deny {row.deny_bits}
          <button on:click={() => removeOverwrite(row)}>Delete</button>
        </li>
      {/each}
    </ul>

    <h4>Role Base Permissions</h4>
    <div class="row">
      <input bind:value={roleName} placeholder="role name" />
    </div>
    <div class="bits-grid">
      <div>
        <strong>Role Allow</strong>
        {#each bits as bit}
          <label><input type="checkbox" checked={(roleAllowBits & bit.value) === bit.value} on:change={() => roleAllowBits = toggleBit(roleAllowBits, bit.value)} /> {bit.label}</label>
        {/each}
      </div>
      <div>
        <strong>Role Deny</strong>
        {#each bits as bit}
          <label><input type="checkbox" checked={(roleDenyBits & bit.value) === bit.value} on:change={() => roleDenyBits = toggleBit(roleDenyBits, bit.value)} /> {bit.label}</label>
        {/each}
      </div>
    </div>
    <button on:click={saveRoleBasePermissions} disabled={hasRoleConflict}>Save Role Base</button>
    <ul>
      {#each roleRows as row}
        <li>{row.role_name}: allow {row.allow_bits} / deny {row.deny_bits}</li>
      {/each}
    </ul>

    <h4>Preview Effective Permissions</h4>
    <div class="row">
      <input bind:value={previewResourceId} placeholder="channel/resource id" />
      <input bind:value={previewTargetUserId} placeholder="user id (optional)" />
      <input bind:value={previewRoleNames} placeholder="role1,role2 (used when no user id)" />
      <button on:click={previewPermissions}>Preview</button>
    </div>

    {#if previewResult}
      <pre>{JSON.stringify(previewResult, null, 2)}</pre>
    {/if}
  </div>
{/if}

<style>
  .row { display:flex; gap:8px; margin:8px 0; flex-wrap: wrap; }
  .bits-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 8px 0; }
  label { display:block; font-size: 0.9rem; margin: 4px 0; }
  .warning { color: #ffb347; font-weight: 600; margin: 8px 0; }
  .muted { opacity: 0.8; font-size: 0.9rem; }
  pre { max-height: 180px; overflow: auto; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px; }
</style>
