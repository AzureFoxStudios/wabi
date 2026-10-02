<script lang="ts">
    import { workspaceExportState, dismissExportStatus } from './fileExport';
    const attention=$derived($workspaceExportState.phase==='error'||$workspaceExportState.phase==='uncertain');
</script>
{#if $workspaceExportState.phase!=='idle'}
    <div class="file-export-notice" class:attention role={attention?'alert':'status'} aria-live="polite" aria-label="File export status">
        <span>{$workspaceExportState.message}</span>
        {#if $workspaceExportState.phase!=='saving'}<button onclick={dismissExportStatus} aria-label="Dismiss export status">Dismiss</button>{/if}
    </div>
{/if}
<style>
    .file-export-notice{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.5rem .75rem;font:13px/1.4 system-ui;background:var(--surface-raised,#25293f);color:var(--text-primary,#eef0f8);border-bottom:1px solid var(--border-subtle,#484c66)}
    .file-export-notice.attention{border-inline-start:3px solid var(--text-warning,#e4b45a)}
    button{flex-shrink:0;padding:.35rem .6rem;border:1px solid var(--border-subtle,#484c66);border-radius:5px;background:transparent;color:inherit;cursor:pointer}
</style>
