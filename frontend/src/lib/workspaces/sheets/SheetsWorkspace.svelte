<!--
	Sheets (design contract §8.8): the library, or one workbook in the office shell.

	- Row A is the editor header (ArtifactShell): no mode segment; ⋯ Export lists each format with
	  its truth ("XLSX · supported subset", "CSV · active sheet") next to Backup and Original file.
	- The editor is SheetsGrid: one toolbar, the formula bar, the grid filling the stage, the sheet
	  tabs. Nothing sits between row A and the toolbar except a notice while something needs saying.
	- Importing shows a preview dialog before anything is created: the CSV delimiter (re-read on
	  change), what each sheet holds and the import limits. Confirming makes a private copy on this
	  device; nothing is uploaded.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import ArtifactShell from '../ArtifactShell.svelte';
	import ArtifactLibrary from '../ArtifactLibrary.svelte';
	import SheetsGrid from './SheetsGrid.svelte';
	import { ArtifactSession, createArtifact, openArtifact, download, from64, Y } from '../session';
	import { captureScope, targets, WorkspaceError, type Scope, type Target } from '../bridge';
	import { initialize, snapshot, addSheet, axes } from './model';
	import { parseFormula, type CellVersion } from './formula';
	import { SheetWorker } from './workerClient';
	import type { ImportedWorkbook } from './engine.worker';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import LoadLine from '$lib/components/ui/LoadLine.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { toast } from '$lib/toast';
	import { _ } from '$lib/i18n';
	import '../workspace.css';
	import './sheets.css';

	let scope = $state<Scope | null>(null), active = $state<ArtifactSession | null>(null), busy = $state(false), error = $state(''), errorDetail = $state<unknown>(null);
	let importData = $state<ImportedWorkbook | null>(null), importFile = $state<File | null>(null), delimiter = $state(','), importOpen = $state(false);
	let selectionAnchor = $state<string | null>(null), focusAnchor = $state<string | null>(null), activeSheetId = $state('');
	let previousTarget: unknown, stopped = false, generation = 0, unsubscribe = () => {};
	const worker = new SheetWorker();
	const current = (own: number, owner: Scope) => !stopped && own === generation && owner.isCurrent();
	const isDelimited = $derived(!!importFile && /\.csv$/i.test(importFile.name));

	/** Our own sentences show; a browser or worker failure is logged and the cause stands in. */
	function fail(e: unknown, cause: string) {
		errorDetail = e;
		error = e instanceof WorkspaceError || (e instanceof Error && e.constructor === Error) ? e.message : cause;
	}
	async function run(fn: (owner: Scope, own: number) => Promise<void>, cause = "Couldn't open the spreadsheet") {
		const owner = scope;
		if (!owner) return;
		const own = ++generation;
		error = '';
		busy = true;
		try { await fn(owner, own); }
		catch (e) { if (current(own, owner)) fail(e, cause); }
		finally { if (current(own, owner)) busy = false; }
	}
	async function use(candidate: ArtifactSession, own: number, owner: Scope) {
		if (!current(own, owner)) { await candidate.close(); return; }
		if (candidate === active) { await candidate.close(); return; }
		const previous = active;
		if (previous && !(await previous.close())) { await candidate.close(); throw new Error('Save or export recovery before closing the current spreadsheet.'); }
		if (!current(own, owner)) { await candidate.close(); return; }
		active = candidate;
		selectionAnchor = null;
		activeSheetId = '';
	}
	async function create() { await run(async (owner, own) => { focusAnchor = null; await use(await createArtifact(owner, 'sheets', 'Untitled spreadsheet', (doc) => initialize(doc.getMap('data'))), own, owner); }, "Couldn't start a spreadsheet"); }
	async function open(id: string) { await run(async (owner, own) => { focusAnchor = null; await use(await openArtifact(owner, id, 'sheets'), own, owner); }); }
	async function library() {
		await run(async (owner, own) => {
			if (active && !(await active.close())) throw new Error('Local save failed. Export recovery before leaving.');
			if (current(own, owner)) { active = null; selectionAnchor = null; focusAnchor = null; }
		}, "Couldn't return to the library");
	}
	async function target(input: Target) { if (input.id) await run(async (owner, own) => { focusAnchor = input.anchor || null; await use(await openArtifact(owner, input.id!, 'sheets'), own, owner); }); }

	/** Read a CSV, TSV, XLSX or ODS file for the preview (CSV with the chosen delimiter). */
	async function parse(file: File, own: number, owner: Scope) {
		const buffer = await file.arrayBuffer();
		if (!current(own, owner)) return;
		const parsed = await worker.run<ImportedWorkbook>('import', { buffer, name: file.name, delimiter: file.name.toLowerCase().endsWith('.tsv') ? '\t' : delimiter });
		if (!current(own, owner)) return;
		importFile = file;
		importData = parsed;
		importOpen = true;
		worker.close();
	}
	async function loadFile(file: File) {
		await run(async (owner, own) => {
			if (file.size > (file.name.endsWith('.wabi.json') ? 24 : 12) * 1024 * 1024) throw new Error('File exceeds the supported import size.');
			if (file.name.endsWith('.wabi.json')) {
				const value = JSON.parse(await file.text());
				if (!current(own, owner)) return;
				if (value.schema !== 1 || value.kind !== 'sheets' || typeof value.update !== 'string') throw new Error('Not a Wabi spreadsheet backup.');
				const source = new Y.Doc();
				try {
					Y.applyUpdate(source, from64(value.update));
					const data = source.getMap('data');
					if (data.get('schema') !== 1 || !(data.get('sheets') instanceof Y.Map)) throw new Error('Unsupported workbook schema.');
					// Source data stays separate until the new local transaction commits.
					await use(await createArtifact(owner, 'sheets', source.getText('title').toString(), (doc) => { const destination = doc.getMap('data'); for (const [key, item] of data) destination.set(key, item instanceof Y.Map || item instanceof Y.Array || item instanceof Y.Text ? item.clone() : item); }, 'native', undefined, { name: file.name, type: file.type, blob: file }), own, owner);
				} finally { source.destroy(); }
				return;
			}
			await parse(file, own, owner);
		}, "Couldn't read that file");
	}
	/** The delimiter is chosen where it matters: in the preview, which re-reads the file. */
	async function changeDelimiter(next: string) {
		delimiter = next;
		const file = importFile;
		if (!file) return;
		await run(async (owner, own) => { await parse(file, own, owner); }, "Couldn't read that file");
	}
	async function confirmImport() {
		await run(async (owner, own) => {
			if (!importData || !importFile) return;
			const data = importData, file = importFile;
			const candidate = await createArtifact(owner, 'sheets', file.name, (doc) => {
				const root = doc.getMap('data');
				root.set('schema', 1);
				root.set('sheets', new Y.Map());
				const created = data.sheets.map((sheet) => addSheet(root, sheet.name, sheet.rows, sheet.columns)), book = snapshot(root);
				doc.transact(() => {
					data.sheets.forEach((source, index) => {
						const target = created[index], rows = axes(target.sheet, 'rows'), columns = axes(target.sheet, 'columns'), ops = target.sheet.get('ops') as Y.Map<CellVersion>;
						for (const cell of source.cells) {
							if (!rows[cell.r] || !columns[cell.c] || cell.input.length > 8192) throw new Error('Imported cell exceeds the supported target or text limits.');
							const id = crypto.randomUUID(), version: CellVersion = { id, cell: `${rows[cell.r].id}|${columns[cell.c].id}`, input: cell.input, parents: [], imported: true, ...(cell.literal !== undefined ? { literal: cell.literal } : {}), ...(cell.cached !== undefined ? { cached: cell.cached } : {}) };
							if (cell.input.startsWith('=') && cell.literal === undefined) { try { version.expression = parseFormula(cell.input, book, target.id); } catch (e) { version.parseError = e instanceof Error ? e.message : '#UNSUPPORTED!'; } }
							ops.set(id, version);
						}
					});
				});
			}, 'native', undefined, { name: file.name, type: file.type, blob: file });
			await use(candidate, own, owner);
			if (current(own, owner)) { importData = null; importFile = null; importOpen = false; }
			worker.close();
		}, "Couldn't create the spreadsheet");
	}
	const FORMATS: { format: 'xlsx' | 'ods' | 'csv' | 'tsv'; key: string; label: string }[] = [
		{ format: 'xlsx', key: 'office.sheets.export_xlsx', label: 'XLSX (.xlsx)' },
		{ format: 'ods', key: 'office.sheets.export_ods', label: 'ODS (.ods)' },
		{ format: 'csv', key: 'office.sheets.export_csv', label: 'CSV (.csv)' },
		{ format: 'tsv', key: 'office.sheets.export_tsv', label: 'TSV (.tsv)' }
	];
	async function exportFile(format: string) {
		await run(async (owner, own) => {
			const source = active;
			if (!source) return;
			await source.flush();
			if (!current(own, owner)) return;
			const book = snapshot(source.data), activeId = book.sheets.some((sheet) => sheet.id === activeSheetId) ? activeSheetId : book.sheets[0]?.id;
			if (!activeId) throw new Error('Workbook is empty.');
			const result = await worker.run<{ bytes: ArrayBuffer; type: string }>('export', { book, format, activeId });
			if (current(own, owner)) {
				download(`${source.title}.${format}`, new Blob([result.bytes], { type: result.type }));
				// The format's limits, said once where they matter.
				toast('Exported values and supported formulas. Advanced Office layout is not a lossless round trip; Backup (.wabi.json) keeps Wabi formatting and history.', { tone: 'info', timeout: 9000 });
			}
			worker.close();
		}, "Couldn't export the spreadsheet");
	}
	// The truth per format ("XLSX · supported subset") is each row's hint.
	const exports = $derived<MenuEntry[]>(FORMATS.map((item) => ({ id: `export-${item.format}`, label: item.label, icon: 'download', keepCase: true, hint: $_(item.key).split(' · ')[1] ?? '', disabled: busy, onSelect: () => void exportFile(item.format) })));
	async function useCopy(copy: ArtifactSession) {
		const owner = scope;
		if (!owner) { await copy.close(); return; }
		focusAnchor = null;
		await use(copy, ++generation, owner);
	}
	function cancelFile() { worker.close(); generation++; busy = false; importData = null; importFile = null; importOpen = false; }
	onMount(() => {
		void captureScope().then((owner) => {
			if (stopped || !owner.isCurrent()) return;
			scope = owner;
			unsubscribe = targets.subscribe((value) => { if (value.sheets && value.sheets !== previousTarget) { previousTarget = value.sheets; void target(value.sheets); } });
		}).catch((e) => { if (!stopped) fail(e, "Couldn't open Sheets"); });
	});
	onDestroy(() => { stopped = true; generation++; unsubscribe(); worker.close(); if (active) void active.close(); });
</script>

{#snippet status()}
	{#if busy && !importOpen}
		<div class="sheet-notice">
			<Notice tone="info" title="Working on this device…" text="The file stays here; nothing is uploaded.">
				{#snippet actions()}<button type="button" class="w-btn w-btn--sm" onclick={cancelFile}>Cancel</button>{/snippet}
			</Notice>
		</div>
	{/if}
	{#if error && !importOpen}
		<div class="sheet-notice">
			<Notice title={error} text={active ? 'Your spreadsheet is still here on this device.' : 'Nothing was changed.'} error={errorDetail}>
				{#snippet actions()}
					{#if active}<button type="button" class="w-btn w-btn--sm" onclick={() => download(`${active!.title}.wabi.json`, active!.recovery())}>Export recovery</button>{:else}<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => (error = '')}>Dismiss</button>{/if}
				{/snippet}
			</Notice>
		</div>
	{/if}
{/snippet}

{#if scope && active}
	{#key active.id}
		<ArtifactShell session={active} onlibrary={library} {selectionAnchor} onanchor={(anchor) => (focusAnchor = anchor)} oncopy={useCopy} {exports}>
			<div class="sheets-page">
				<LoadLine active={busy} label="Working on this device…" class="sheets-line" />
				{@render status()}
				<SheetsGrid session={active} onselection={(anchor) => (selectionAnchor = anchor)} onactivesheet={(id) => (activeSheetId = id)} {focusAnchor} />
			</div>
		</ArtifactShell>
	{/key}
{:else if scope}
	<section class="wabi-workspace sheets-library">
		<LoadLine active={busy} label="Working on this device…" class="sheets-line" />
		{@render status()}
		<ArtifactLibrary {scope} kind="sheets" label="Sheets" onopen={open} onnew={create} onimport={loadFile} accept=".csv,.tsv,.xlsx,.ods,.wabi.json" />
	</section>
{:else}
	<section class="wabi-workspace sheets-library">{@render status()}</section>
{/if}

<BaseModal isOpen={importOpen} onClose={() => { if (!busy) cancelFile(); }} size="md" padded title={importFile ? `Import ${importFile.name}` : 'Import preview'} note="Nothing is uploaded" ariaLabel="Spreadsheet import preview">
	<div class="sheet-import">
		<p class="sheet-import__truth">The original file is kept. Confirming creates a private, editable Wabi copy on this device; it does not upload the file.</p>
		{#if isDelimited}
			<label class="sheet-import__field"><span class="w-label">Values separated by</span>
				<span class="w-field sheet-import__select"><select aria-label="CSV delimiter" value={delimiter} disabled={busy} onchange={(event) => void changeDelimiter(event.currentTarget.value)}><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option></select></span>
			</label>
		{/if}
		{#if error}<Notice title={error} text="Nothing was created." error={errorDetail} />{/if}
		{#if importData}
			{#each importData.warnings as warning}<p class="sheet-import__warning">{warning}</p>{/each}
			{#each importData.sheets as sheet}
				<section class="sheet-import__sheet">
					<h3 class="sheet-import__name">{sheet.name}</h3>
					<p class="sheet-import__facts">{sheet.rows} rows · {sheet.columns} columns · {sheet.cells.length} filled cells</p>
					<div class="sheet-import__preview">
						<table><tbody>{#each [0, 1, 2, 3, 4] as r}<tr>{#each [0, 1, 2, 3, 4] as c}<td>{sheet.cells.find((cell) => cell.r === r && cell.c === c)?.input || ''}</td>{/each}</tr>{/each}</tbody></table>
					</div>
				</section>
			{/each}
		{/if}
		<p class="sheet-import__limits">Up to 12 MB per file. Values and supported formulas come across; charts, macros and advanced Office layout do not.</p>
	</div>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" disabled={busy} onclick={cancelFile}>Cancel</button>
		<button type="button" class="w-btn w-btn--primary" disabled={busy || !importData} onclick={() => void confirmImport()}>Create private spreadsheet</button>
	</div>
</BaseModal>
