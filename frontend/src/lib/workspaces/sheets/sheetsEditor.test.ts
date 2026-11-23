import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The Sheets editor (design contract §8.8 Sheets; critiques office-sheets#1, #2, #5, #6, #7, #10,
// #12, #13, #15, #16, #17). Sources are read as text: a regression that brings back the button
// bands, the export strip, the developer legend or magic heights fails here. Comments are removed
// by a loop that repeats one pattern until nothing changes (never a single-pass replace).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const grid = read('./SheetsGrid.svelte');
const page = read('./SheetsWorkspace.svelte');
const css = read('./sheets.css');
const stripComments = (source: string) => {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
};
const markup = grid.slice(grid.indexOf('</script>'));

describe('one toolbar, one formula bar, the grid owns the rest', () => {
	test('a single toolbar row with the contract controls; the rest is in ⋯ Spreadsheet tools', () => {
		expect(markup.match(/role="toolbar"/g)?.length).toBe(1);
		expect(markup).toContain('aria-label="Spreadsheet tools"');
		for (const label of ['Number format', 'Bold', 'Italic', 'Alignment', 'Cell fill color', 'Borders', 'Insert row', 'Insert column', 'Sort my view', 'Chart', 'More spreadsheet tools']) expect(markup).toContain(label);
		// Old bands and wordy buttons are gone from the bar.
		for (const gone of ['Move sheet left', 'Move sheet right', 'Unfreeze headers', 'Recover cell drafts {cellDrafts.length}</button>', '+ Sheet</button>', 'sheet-tools']) expect(markup).not.toContain(gone);
		expect(grid).toContain("label:$_('office.sheets.apply_row_order')");
		expect(grid).toContain("hint:sort==='none'?'Sort your view first'");
	});

	test('the toolbar is one tab stop with arrow keys between its controls', () => {
		expect(grid).toContain('function toolbarKeydown(event:KeyboardEvent)');
		expect(grid).toContain("if(event.key==='ArrowRight')next=(index+1)%items.length");
		expect(markup.match(/data-rove/g)!.length).toBeGreaterThanOrEqual(10);
	});

	test('the formula bar keeps its label and adds the name box and fx', () => {
		expect(markup).toContain('aria-label="Cell value or formula"');
		// The name box shows the selected cell and is also where you type an address to go there.
		expect(markup).toContain('<input class="sheet-formula__name" aria-label="Name box"');
		expect(markup).toContain('onkeydown={nameKeydown}');
		expect(markup).toContain('<span class="sheet-formula__fx" aria-hidden="true">fx</span>');
	});

	test('the fill handle, find bar, underline, date and AutoSum keys exist, and one loop serves every drag', () => {
		expect(markup).toContain('class="fill-handle"');
		expect(grid).toContain('fillValues(source,');
		expect(markup).toContain('role="search" aria-label="Find in sheet"');
		expect(grid).toContain("(lower==='f'||lower==='h')");
		expect(grid).toContain("if(lower==='u'&&allowSelected)");
		expect(grid).toContain("key===';'&&!event.shiftKey");
		expect(grid).toContain("event.altKey&&!mod&&key==='='");
		expect(grid).toContain("event.altKey&&el===cellEditor");
		// Selecting, writing a formula's range and the fill handle share one frame loop that also scrolls at the edges.
		expect(grid).toContain('function dragLoop()');
		expect(grid).toContain('document.elementFromPoint(x,y)');
		// Stepping through matches must not pull the caret out of the find bar.
		expect(grid).toContain("focused?.closest('.sheet-find')");
	});

	test('Enter and Tab move the active cell inside a multi-cell selection without changing the selection', () => {
		expect(grid).toContain('nextInRange(bounds,activePos(),key,shift)');
		expect(grid).toContain('const activeRow=$derived(inner?.row??selectedRow)');
		// The highlighted cell, the editor, the name box and formatting all follow the active cell.
		expect(markup).toContain('class:active={row.id===activeRow&&column.id===activeColumn}');
		expect(grid).toContain("editing&&editSurface==='cell'&&row.id===activeRow&&column.id===activeColumn");
		// Any change to the selection itself puts the active cell back on its corner.
		expect(grid).toContain('void selectedRow;void selectedColumn;void endRow;void endColumn;void sheetId;inner=null;');
	});

	test('columns can be resized by dragging their edge, and the cell menu opens from mouse and keyboard', () => {
		expect(markup).toContain('class="col-resize"');
		expect(markup).toContain('onpointerdown={event=>resizeStart(event,column.id)}');
		expect(markup).toContain('autoFit(column.id)');
		expect(markup).toContain('oncontextmenu={event=>openCellMenu(event,row.id,column.id)}');
		expect(grid).toContain("key==='ContextMenu'||(event.shiftKey&&key==='F10')");
		// The fixed-layout table must be given its width, or the browser squeezes the columns to the window.
		expect(markup).toContain('style:width={`${tableWidth}px`}');
	});

	test('no developer legend; a cached result is named where it is read', () => {
		expect(grid).not.toContain('† source-cached result; STALE means the workbook changed.');
		expect(markup).toContain("{activeCached==='stale'?'Stale':'Cached'}");
	});

	test('one scroll container fills the stage; no magic heights', () => {
		expect(page).not.toContain('calc(100% - 52px)');
		expect(grid).not.toContain('min-height:260px');
		const code = stripComments(css);
		expect(code).toMatch(/\.sheet-grid \{\s*flex: 1;\s*min-height: 0;\s*overflow: auto;/);
	});

	test('the footer: sheet tabs (rename, right-click) and a Sum / Avg / Count readout', () => {
		expect(markup).toContain('role="tablist" aria-label="Sheets"');
		expect(markup).toContain('ondblclick={()=>void startRename(item.id)}');
		expect(markup).toContain('oncontextmenu={event=>openTabMenu(event,item.id)}');
		expect(markup).toContain('<span>Sum {number(stats.sum)}</span>');
		expect(markup).toContain('<span>Count {stats.count}</span>');
	});
});

describe('the grid', () => {
	test('typed values show before (or without) the calculator; formulas wait for it', () => {
		expect(grid).toContain("return version.input.startsWith('=')?null:literal(version.input);");
		expect(grid).toContain('calculations.values[key]??typed(versions[0])');
	});

	test('Shift extends the range from its far corner, not from the anchor', () => {
		// The moving corner is the range's far end; the anchor only changes without Shift.
		expect(grid).toContain('item.id===(endRow||selectedRow)');
		expect(grid).toContain('const from=event.shiftKey?focusPos():activePos();');
		expect(grid).toContain('event.shiftKey);return;');
	});

	test('Excel keys: Enter and Tab move, F2 or typing edits, Ctrl+Arrow jumps, headers select', () => {
		expect(grid).toContain('// Enter and Tab move; they do not edit. F2, double click or typing opens the editor.');
		expect(grid).toContain("if(key==='F2'){event.preventDefault();startEdit();return;}");
		expect(grid).toContain('jumpTarget(isFilled,from,arrow,rows.length,columns)');
		expect(grid).toContain("void openEditor('enter',key)");
		expect(grid).toContain('onclick={event=>selectColumn(index,event.shiftKey)}');
		expect(grid).toContain('onclick={event=>selectRow(ri,event.shiftKey)}');
		expect(grid).toContain('onclick={selectAll}');
	});

	test('the cell edits in place, and a formula can point at cells instead of committing', () => {
		// A textarea, so Alt+Enter can hold a second line; it floats over the cell instead of being clipped by it.
		expect(grid).toContain('<textarea class="sheet-cell-editor"');
		// Clicking while a formula wants a reference keeps focus in the editor and writes the address.
		expect(grid).toContain('draft.startsWith(\'=\')&&(liveSpan(draft,pointSpan)||canPoint(draft,at))');
		expect(grid).toContain('event.preventDefault();');
		expect(grid).toContain('pointDragging=true;writePoint();');
		// The formula bar and the cell share one key handler, so both get F4, autocomplete and Esc.
		expect(grid).toContain('onkeydown={editorKeydown}');
	});

	test('numbers are mono and right-aligned; the selection has a perimeter; headers tint', () => {
		expect(markup).toContain('class:num={isNumber}');
		expect(markup).toContain("style:text-align={cellStyle.align||(isNumber?'right':undefined)}");
		for (const edge of ['edge-t', 'edge-b', 'edge-l', 'edge-r']) expect(markup).toContain(`class:${edge}=`);
		expect(markup).toContain('class:selected-head={selectedColumns.has(column.id)}');
	});

	test('sheets.css draws only with roles and tokens, solid gridlines in High Contrast', () => {
		const code = stripComments(css);
		expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(code).not.toMatch(/rgba?\(/);
		expect(code).not.toMatch(/--surface-|--text-primary|--border-subtle|--accent-primary|system-ui/);
		expect(code).toContain(":root[data-char='contrast'] .sheet-grid :is(th, td) {");
		expect(code).toContain('box-shadow: inset 0 2px 0 var(--w-sig);');
	});

	test('the chart uses the palette series, not hard-coded hues', () => {
		expect(grid).not.toContain('hsl(');
		expect(grid).toContain("const PIE=['var(--w-accent)','var(--w-seal)','var(--w-online)','var(--w-sig)'");
	});
});

describe('the workbook frame', () => {
	test('exports live in ⋯ Export with each format’s truth', () => {
		expect(page).not.toContain('Export spreadsheet</button>');
		expect(page).toContain("{ format: 'xlsx', key: 'office.sheets.export_xlsx', label: 'XLSX (.xlsx)' }");
		expect(page).toContain('{exports}>');
	});

	test('import is a kit dialog with the delimiter in context and the limits stated', () => {
		expect(page).toContain('<BaseModal isOpen={importOpen}');
		expect(page).not.toContain('<dialog');
		expect(page).toContain('aria-label="CSV delimiter"');
		expect(page).toContain('Up to 12 MB per file.');
		expect(page).not.toContain('workspace-home-note');
	});
});
