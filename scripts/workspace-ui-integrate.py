"""Idempotent integration on the isolated workspace branch; no deployment or main writes."""
from pathlib import Path
import re,json

def change(path,before,after):
    p=Path(path);text=p.read_text()
    if after in text:return
    if text.count(before)!=1:raise RuntimeError(f'Integration anchor missing or ambiguous: {path}: {before[:100]}')
    p.write_text(text.replace(before,after,1))
def add_import(path,line):
    p=Path(path);text=p.read_text()
    if line not in text:p.write_text(text.replace('<script lang="ts">','<script lang="ts">\n\t'+line,1))

# Use the interoperable v1 implementation supported by the repository's Rust 1.93 toolchain.
p=Path('core/crates/wabi-server/Cargo.toml');text=p.read_text()
text=text.replace('yrs = { version = "=0.27.4", features = ["small-client", "sync"] }','yrs = { version = "=0.24.0", features = ["sync"] }')
p.write_text(text)

p=Path('frontend/vite.config.ts');text=p.read_text()
if 'const workspaceSelection' not in text:
    text=text.replace("import { readFileSync } from 'node:fs';","import { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';")
    config="""const workspaceSelection = new Set((process.env.WABI_WORKSPACE_ADDONS || 'none').split(',').map(v => v.trim()));
if ([...workspaceSelection].some(v => !['none', 'all', 'sheets', 'present'].includes(v))) throw new Error('WABI_WORKSPACE_ADDONS must be none, all, sheets, present, or sheets,present');
const workspacePackaged = { sheets: workspaceSelection.has('all') || workspaceSelection.has('sheets'), present: workspaceSelection.has('all') || workspaceSelection.has('present') };
const workspaceEntry = (name: 'sheets' | 'present') => fileURLToPath(new URL(workspacePackaged[name] ? `./src/lib/workspaces/${name}/addon.ts` : './src/lib/workspaces/addonUnavailable.ts', import.meta.url));

"""
    text=text.replace('export default defineConfig({',config+"export default defineConfig({\n\tresolve: { alias: { '@wabi/workspace-sheets': workspaceEntry('sheets'), '@wabi/workspace-present': workspaceEntry('present') } },\n\tworker: { format: 'es' },")
    text=text.replace("'process.env': {},","'process.env': {},\n\t\t'__WABI_WORKSPACE_PACKAGED__': JSON.stringify(workspacePackaged),")
    text=text.replace("plugins: [\n\t\tsveltekit(),", """plugins: [
        {
            name: 'wabi-workspace-bundle-evidence',
            apply: 'build',
            generateBundle(_options, bundle) {
                const chunks = Object.entries(bundle).flatMap(([file, output]) => output.type === 'chunk' ? [{ file, entry: output.isEntry, imports: output.imports, dynamicImports: output.dynamicImports, modules: Object.keys(output.modules).filter(id => /workspaces\\/|node_modules\\/(?:xlsx|pptxgenjs|pdfjs-dist|yjs|y-codemirror)/.test(id)) }] : []);
                this.emitFile({ type: 'asset', fileName: 'wabi-workspace-bundle.json', source: JSON.stringify({ schema: 1, packaged: workspacePackaged, chunks }, null, 2) });
            }
        },
        sveltekit(),""")
    p.write_text(text)

p=Path('frontend/src/lib/addons/loader.ts');text=p.read_text()
if "'sheets': () => import('@wabi/workspace-sheets')" not in text:
    text=text.replace("const BUNDLED_ADDON_LOADERS: Record<string, () => Promise<unknown>> = {", "const BUNDLED_ADDON_LOADERS: Record<string, () => Promise<unknown>> = {\n\t'sheets': () => import('@wabi/workspace-sheets'),\n\t'present': () => import('@wabi/workspace-present'),")
    text=text.replace('const LOCAL_MANIFESTS: Record<string, AddonManifest> = {',"const LOCAL_MANIFESTS: Record<string, AddonManifest> = {\n\t'sheets': { id: 'sheets', name: 'Sheets', version: '0.1.0', frontendEntry: 'bundled:sheets', dependencies: [] },\n\t'present': { id: 'present', name: 'Present', version: '0.1.0', frontendEntry: 'bundled:present', dependencies: [] },")
    text=text.replace("console.error(`[Addons] Disable error for ${addonId}:`, err);", "console.error(`[Addons] Disable error for ${addonId}:`, err);\n\t\t\tif (addonId === 'sheets' || addonId === 'present') throw err;")
    p.write_text(text)
p=Path('frontend/src/lib/addonInventory.ts');text=p.read_text()
if '__WABI_WORKSPACE_PACKAGED__' not in text:
    text="declare const __WABI_WORKSPACE_PACKAGED__: { sheets: boolean; present: boolean };\n"+text
    text=text.replace("if (!normalizedId) return Promise.resolve(false);", "if (!normalizedId) return Promise.resolve(false);\n\tif (normalizedId === 'sheets' || normalizedId === 'present') return Promise.resolve(typeof __WABI_WORKSPACE_PACKAGED__ !== 'undefined' && __WABI_WORKSPACE_PACKAGED__[normalizedId]);")
    p.write_text(text)

p=Path('frontend/src/lib/workspaces/bridge.ts');text=p.read_text()
if 'export function workspaceToolFromTab' not in text:
    text+='\nexport function workspaceToolFromTab(tab: string | null | undefined): Tool | null {\n    const id = tab?.startsWith(\'addon:workspace-\') ? tab.slice(\'addon:workspace-\'.length) : \'\';\n    return [\'documents\',\'sheets\',\'present\',\'audience\'].includes(id) ? id as Tool : null;\n}\n'
    p.write_text(text)
layout='frontend/src/lib/components/MainLayout.svelte'
add_import(layout,"import WorkspaceHost from '$lib/workspaces/WorkspaceHost.svelte';")
add_import(layout,"import WorkspaceLinkHandler from '$lib/workspaces/WorkspaceLinkHandler.svelte';")
add_import(layout,"import { workspaceToolFromTab } from '$lib/workspaces/bridge';")
p=Path(layout);text=p.read_text()
if '$: activeOfficeTool = workspaceToolFromTab($activeTabId);' not in text:
    text=text.replace('</script>',"\t$: activeOfficeTool = workspaceToolFromTab($activeTabId);\n</script>",1)
if '<WorkspaceLinkHandler />' not in text:text=text.replace('<AuthErrorBanner />','<AuthErrorBanner />\n\t<WorkspaceLinkHandler />',1)
if '<WorkspaceHost tool={activeOfficeTool}' not in text:
    marker='{#if isModelViewportTabActive}'
    if text.count(marker)!=1:raise RuntimeError('Main workspace rendering anchor missing')
    text=text.replace(marker,'{#if activeOfficeTool}\n\t\t\t\t\t<WorkspaceHost tool={activeOfficeTool} />\n\t\t\t\t{:else if isModelViewportTabActive}',1)
p.write_text(text)

reader='frontend/src/lib/components/ReaderDocumentWorkbench.svelte'
add_import(reader,"import WorkspaceShortcuts from '$lib/workspaces/WorkspaceShortcuts.svelte';")
add_import(reader,"import { openWorkspace } from '$lib/workspaces/bridge';")
p=Path(reader);text=p.read_text()
if '<WorkspaceShortcuts />' not in text:
    marker='<div class="reader-workbench" class:has-selection={Boolean(selection)}>'
    if marker not in text:raise RuntimeError('Reader layout integration anchor missing')
    text=text.replace(marker,marker+'\n\t<WorkspaceShortcuts />',1)
if 'async function prepareWorkspaceSource' not in text:
    begin=text.index("\tfunction explainRemoteState(action: 'share' | 'live'): void {")
    end=text.index('\n\tfunction formatUpdated',begin)
    replacement="""	async function prepareWorkspaceSource() {
        if (!activeDocumentId || !selection) return null;
        const id = activeDocumentId, selected = selection.id, scope = get(readerDocumentScope);
        await flushReaderDocument(id);
        if (get(readerDocumentScope) !== scope || get(readerSelection)?.id !== selected) return null;
        if (get(readerDocumentSaveState)[id] === 'error') { remoteNotice = 'Local save failed. Retry saving or download recovery before publishing.'; return null; }
        const document = get(readerDocuments)[id];
        if (!document) return null;
        return { title: document.title, content: document.content, format: document.format, sourceKey: `reader:${document.documentId}:revision:${document.revision}` };
    }
    async function explainRemoteState(action: 'share' | 'live'): Promise<void> {
        try {
            const source = await prepareWorkspaceSource();
            if (source) openWorkspace('documents', { source, shareMode: action === 'live' ? 'live' : 'snapshot' });
        } catch (error) { remoteNotice = error instanceof Error ? error.message : 'Could not open the sharing workspace. Your Reader draft is retained.'; }
    }
    async function makePresentationFromReader(): Promise<void> {
        try { const source = await prepareWorkspaceSource(); if (source) openWorkspace('present', { source }); }
        catch (error) { remoteNotice = error instanceof Error ? error.message : 'Could not prepare a private presentation.'; }
    }
"""
    text=text[:begin]+replacement+text[end:]
if 'on:click={makePresentationFromReader}' not in text:
    marker="<button type=\"button\" on:click={() => explainRemoteState('live')}>Go Live</button>"
    if marker not in text:raise RuntimeError('Reader live action anchor missing')
    text=text.replace(marker,marker.replace('>Go Live<','>Collaborate<')+'\n\t\t\t\t<button type="button" on:click={makePresentationFromReader}>Make presentation</button>',1)
p.write_text(text)

# Canonical server discovery advertises optional collaboration separately from client installation.
p=Path('core/crates/wabi-server/src/api/addons.rs');text=p.read_text()
if 'fn configured_workspace_addons' not in text:
    function='''fn configured_workspace_addons(state: &AppState) -> Result<Vec<AddonCapability>> {
    let mut out = enabled_addons();
    let settings = state.wdb.workspace_get("settings")?.map(|r| r.value).unwrap_or_default();
    for (id, name) in [("sheets", "Sheets"), ("present", "Present")] {
        out.push(AddonCapability {
            id: id.into(), name: name.into(), version: "0.1.0".into(),
            description: "Optional local-first workspace; client package and server sharing are independent".into(),
            enabled: settings[id].as_bool().unwrap_or(false), backend_runtime: String::new(), cargo_feature: None, permissions: vec![],
            frontend: FrontendInfo { bundled: true, contributions: FrontendContributions {
                channel_types: vec![], workspace_panels: vec![format!("workspace:{id}")], settings_pages: vec![id.into()], mobile_tabs: vec![format!("workspace:{id}")],
            } },
        });
    }
    Ok(out)
}

'''
    text=text.replace('/// GET /api/addons — list enabled addons + frontend extension manifests.',function+'/// GET /api/addons — list enabled addons + frontend extension manifests.',1)
    text=text.replace('State(_state): State<Arc<AppState>>','State(state): State<Arc<AppState>>')
    text=text.replace('addons: enabled_addons(),','addons: configured_workspace_addons(&state)?,')
    text=text.replace('match enabled_addons()','match configured_workspace_addons(&state)?')
    p.write_text(text)

# Small typed integration repairs, independent of the compilation result.
p=Path('frontend/src/lib/workspaces/present/files.ts');text=p.read_text().replace('...pptx.defineSlideMaster&&{} ,','').replace('y:split?.6:height*.48','y:split ? .6 : height*.48');p.write_text(text)
p=Path('frontend/src/lib/workspaces/sheets/engine.worker.ts');text=p.read_text()
if "import type { WorkSheet } from 'xlsx';" not in text:text="import type { WorkSheet } from 'xlsx';\n"+text
text=text.replace('XLSX.WorkSheet','WorkSheet');p.write_text(text)
p=Path('frontend/src/lib/workspaces/sheets/SheetsWorkspace.svelte');text=p.read_text().replace('item instanceof Y.AbstractType?item.clone():item','item instanceof Y.Map||item instanceof Y.Array||item instanceof Y.Text?item.clone():item');p.write_text(text)
p=Path('frontend/src/lib/workspaces/DocumentsWorkspace.svelte');text=p.read_text()
text=text.replace('let generation=0;', 'let generation=0;let previousTarget:unknown;')
text=text.replace('if(value.documents)void target(value.documents);','if(value.documents&&value.documents!==previousTarget){previousTarget=value.documents;void target(value.documents);}')
p.write_text(text)
print('Reader, addon lifecycle, capability discovery, and minimal/expanded build boundaries integrated.')
