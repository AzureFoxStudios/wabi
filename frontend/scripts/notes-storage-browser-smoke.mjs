// Actual IndexedDB in two headful browser windows; no live server or user data.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite, browser;
try {
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false }, plugins: [{
		name: 'notebook-storage-fixture', configureServer(server) {
			server.middlewares.use('/favicon.ico', (_req, res) => { res.statusCode = 204; res.end(); });
			server.middlewares.use('/notebook-storage-fixture', (_req, res) => {
				res.setHeader('Content-Type', 'text/html');
				res.end('<!doctype html><title>Isolated local notebook test</title><p>Testing local note transactions.</p>');
			});
		}
	}] });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
	const context = await browser.newContext();
	const a = await context.newPage();
	const b = await context.newPage();
	for (const page of [a, b]) {
		await page.goto(`${origin}/notebook-storage-fixture`);
		if (page === a) await page.evaluate(async () => {
			await new Promise((resolve, reject) => {
				const opening = indexedDB.open('wabi-local-notes', 1);
				opening.onupgradeneeded = () => {
					const db = opening.result;
					const notes = db.createObjectStore('notes', { keyPath: ['scopeId', 'id'] });
					notes.createIndex('scope', 'scopeId'); notes.createIndex('title', ['scopeId', 'normalizedTitle'], { unique: true });
					notes.add({ scopeId: 'upgrade-fixture', id: 'preserved', title: 'Original', normalizedTitle: 'original', text: 'Keep old data', revision: 7 });
					db.createObjectStore('recovery', { keyPath: 'id' }).add({ id: 'old-recovery', scopeId: 'upgrade-fixture', raw: ' original bytes ' });
				};
				opening.onsuccess = () => { opening.result.close(); resolve(); };
				opening.onerror = () => reject(opening.error);
			});
		});
		await page.evaluate(async () => {
			const { LocalNotebook } = await import('/src/lib/notes/db.ts');
			window.current = true;
			window.book = new LocalNotebook({ scopeId: 'https://example.test/CasePath|account:1', isCurrent: () => window.current });
		});
	}
	const initial = await a.evaluate(() => window.book.create('First note', 'original'));
	const outcomes = await Promise.all([a, b].map((page, index) => page.evaluate(async ({ id, index }) => {
		try { return { ok: true, note: await window.book.save(id, 1, { text: `writer ${index}` }) }; }
		catch (error) { return { ok: false, code: error.code }; }
	}, { id: initial.id, index })));
	assert.equal(outcomes.filter(result => result.ok).length, 1, 'exactly one concurrent writer commits');
	assert.equal(outcomes.find(result => !result.ok).code, 'conflict');
	assert.equal((await b.evaluate(id => window.book.get(id), initial.id)).revision, 2);
	const upgrade = await a.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		return new LocalNotebook({ scopeId: 'upgrade-fixture', isCurrent: () => true }).get('preserved');
	});
	assert.equal(upgrade.text, 'Keep old data', 'additive database upgrade preserves existing records');
	assert.equal(upgrade.revision, 7);
	const scratchpads = await Promise.all([a, b].map(page => page.evaluate(() => window.book.getScratchpad())));
	assert.equal(scratchpads[0].id, scratchpads[1].id, 'concurrent panel mounts share one scratchpad');

	const graph = await a.evaluate(async () => {
		const source = await window.book.create('Source', '[[Destination|read this]] and `[[Destination]]`');
		const target = await window.book.create('Destination', 'target');
		const before = await window.book.outgoing(source.id);
		const renamed = await window.book.save(target.id, 1, { title: 'New destination' });
		const rewritten = await window.book.get(source.id);
		let staleCode;
		try { await window.book.save(source.id, source.revision, { text: 'stale draft' }); } catch (error) { staleCode = error.code; }
		const trashed = await window.book.setTrashed(target.id, renamed.revision, true);
		let duplicateCode;
		try { await window.book.create(' NEW   DESTINATION '); } catch (error) { duplicateCode = error.code; }
		const restored = await window.book.setTrashed(target.id, trashed.revision, false);
		const retrash = await window.book.setTrashed(target.id, restored.revision, true);
		await window.book.permanentlyDelete(target.id, retrash.revision);
		const replacement = await window.book.create('New destination');
		const edited = await window.book.save(source.id, rewritten.revision, { text: `${rewritten.text}\nUnrelated edit.` });
		const afterReuse = await window.book.outgoing(source.id);
		const relinked = await window.book.relink(source.id, edited.revision, 'New destination', replacement.id);
		const afterRelink = await window.book.outgoing(source.id);
		return { source, target, before, rewritten, staleCode, duplicateCode, replacement, afterReuse, afterRelink, relinked };
	});
	assert.equal(graph.before[0].targetId, graph.target.id, 'a newly created title resolves previously missing links');
	assert.equal(graph.rewritten.text, '[[New destination|read this]] and `[[Destination]]`');
	assert.equal(graph.staleCode, 'conflict', 'rename invalidates dirty incoming editors');
	assert.equal(graph.duplicateCode, 'title-taken', 'Trash reserves normalized titles');
	assert.equal(graph.afterReuse[0].targetId, graph.target.id, 'deleted UUID does not follow a reused title');
	assert.equal(graph.afterRelink[0].targetId, graph.replacement.id, 'explicit relink changes identity');

	const isolation = await b.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const otherAccount = new LocalNotebook({ scopeId: 'https://example.test/CasePath|account:2', isCurrent: () => true });
		const otherServer = new LocalNotebook({ scopeId: 'https://other.test/CasePath|account:1', isCurrent: () => true });
		const wrongPath = new LocalNotebook({ scopeId: 'https://example.test/casepath|account:1', isCurrent: () => true });
		window.current = false;
		let retiredCode;
		try { await window.book.create('Leaked draft'); } catch (error) { retiredCode = error.code; }
		return { counts: await Promise.all([otherAccount, otherServer, wrongPath].map(async book => (await book.list()).length)), retiredCode };
	});
	assert.deepEqual(isolation.counts, [0, 0, 0]);
	assert.equal(isolation.retiredCode, 'retired');

	const rollback = await a.evaluate(async () => {
		const { openNotebookDatabase } = await import('/src/lib/notes/db.ts');
		const db = await openNotebookDatabase();
		const original = db.transaction.bind(db);
		db.transaction = (...args) => {
			const tx = original(...args);
			if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
			return tx;
		};
		let failed = false;
		try { await window.book.create('Must not report saved', 'retain draft'); } catch { failed = true; }
		db.transaction = original;
		return { failed, absent: !(await window.book.list()).some(note => note.title === 'Must not report saved') };
	});
	assert.deepEqual(rollback, { failed: true, absent: true });

	const editorResult = await a.evaluate(async () => {
		const { NoteEditor, retainedNoteEditors, announceNotebookChange } = await import('/src/lib/notes/editor.ts');
		const { get } = await import('/node_modules/svelte/src/store/index-client.js');
		const note = await window.book.create('Independent editors', 'initial');
		const first = new NoteEditor(window.book, note);
		const second = new NoteEditor(window.book, note);
		first.update({ text: 'winning draft' });
		second.update({ text: 'my recoverable draft' });
		await first.save();
		await second.save();
		const conflict = get(second.state);
		const recovery = await second.saveRecoveryCopy('Recovered writing');
		const copied = await window.book.get(recovery.id);
		const clean = new NoteEditor(window.book, await window.book.get(note.id));
		const newer = await window.book.save(note.id, 2, { text: 'external update' });
		announceNotebookChange(newer.scopeId);
		await clean.refresh();
		const cleanText = get(clean.state).text;
		// A storage failure keeps the draft accessible after its view unmounts.
		const failing = new NoteEditor(window.book, newer);
		const original = window.book.save.bind(window.book);
		window.book.save = async () => { throw new Error('Quota exceeded'); };
		failing.update({ text: 'must survive failed save' });
		await failing.save();
		const failed = get(failing.state);
		failing.dispose();
		await failing.save();
		const retained = retainedNoteEditors(window.book).map(editor => editor.downloadText());
		window.book.save = original;
		await failing.save();
		first.dispose(); second.dispose(); clean.dispose();
		return { conflict: { status: conflict.status, text: conflict.text }, copied: copied.text, cleanText, failed: failed.status, retained, recovered: (await window.book.get(note.id)).text };
	});
	assert.deepEqual(editorResult.conflict, { status: 'conflict', text: 'my recoverable draft' });
	assert.equal(editorResult.copied, 'my recoverable draft');
	assert.equal(editorResult.cleanText, 'external update');
	assert.equal(editorResult.failed, 'failed');
	assert.ok(editorResult.retained.some(text => text.includes('must survive failed save')));
	assert.equal(editorResult.recovered, 'must survive failed save');
	const migration = await a.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const key = 'wabi:dm-notes:v1:1:1';
		const raw = JSON.stringify([{ text: 'Recovered writing', createdAt: 1 }, null, { text: 'Recovered writing' }]);
		localStorage.setItem(key, raw);
		const first = await window.book.importLegacy(key, raw);
		const again = await window.book.importLegacy(key, raw);
		const notes = await Promise.all(first.noteIds.map(id => window.book.get(id)));
		const other = new LocalNotebook({ scopeId: 'other-owner', isCurrent: () => true });
		let code;
		try { await other.importLegacy(key, raw); } catch (error) { code = error.code; }
		return { first, again, notes, code, originalPreserved: localStorage.getItem(key) === raw };
	});
	assert.equal(migration.first.noteIds.length, 2);
	assert.equal(migration.first.issues.length, 1);
	assert.equal(migration.again.alreadyImported, true);
	assert.deepEqual(migration.again.noteIds, migration.first.noteIds);
	assert.equal(new Set(migration.notes.map(note => note.title)).size, 2);
	assert.ok(migration.notes.every(note => !note.contextChannelId));
	assert.equal(migration.code, 'conflict', 'another account cannot silently claim an already migrated source');
	assert.equal(migration.originalPreserved, true);
	const backupResult = await a.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const { parseNotebookBackup } = await import('/src/lib/notes/backup.ts');
		const source = new LocalNotebook({ scopeId: 'backup-source', isCurrent: () => true });
		const first = await source.create('A', 'first', 'legacy-channel');
		const second = await source.create('A (2)', 'second');
		const graph = await source.create('Graph', '[[A|one]] and [[A (2)|two]]');
		const removed = await source.create('Deleted target');
		const dangling = await source.create('Dangling', '[[Deleted target]]');
		const trash = await source.setTrashed(removed.id, 1, true); await source.permanentlyDelete(removed.id, trash.revision);
		const raw = JSON.stringify(await source.exportBackup());
		parseNotebookBackup(raw);
		const destination = new LocalNotebook({ scopeId: 'backup-destination', isCurrent: () => true });
		await destination.create('A', 'keep existing');
		const imported = await destination.importBackup(raw);
		const repeated = await destination.importBackup(raw);
		const copiedGraph = await destination.get(graph.id);
		const copiedNotes = await destination.list();
		const copiedLinks = await destination.outgoing(graph.id);
		const danglingLink = (await destination.outgoing(dangling.id))[0];
		const roundTrip = parseNotebookBackup(JSON.stringify(await destination.exportBackup()));
		const collide = await source.importBackup(raw);
		const clone = (await source.list()).find(note => note.importedFrom?.id === graph.id);
		return { imported, repeated, copiedGraph, copiedNotes, copiedLinks, danglingLink, removedId: removed.id, roundTripCount: roundTrip.notes.length, collide, clone, cloneLinks: await source.outgoing(clone.id), originalIds: [first.id, second.id, graph.id, dangling.id] };
	});
	assert.equal(backupResult.repeated.alreadyImported, true);
	assert.equal(backupResult.roundTripCount, 5);
	assert.ok(backupResult.copiedNotes.every(note => !note.contextChannelId), 'cross-notebook import detaches conversation IDs');
	assert.ok(backupResult.copiedLinks.every(link => backupResult.copiedNotes.some(note => note.id === link.targetId && note.normalizedTitle === link.normalizedTitle)));
	assert.notEqual(backupResult.danglingLink.targetId, backupResult.removedId, 'missing imported UUID cannot bind to a destination record');
	assert.ok(backupResult.collide.noteIds.every(id => !backupResult.originalIds.includes(id)), 'colliding UUIDs remap together');
	assert.ok(backupResult.cloneLinks.every(link => backupResult.collide.noteIds.includes(link.targetId)));
	const renameDraft = await a.evaluate(async () => {
		const { NoteEditor } = await import('/src/lib/notes/editor.ts');
		const { get } = await import('/node_modules/svelte/src/store/index-client.js');
		const note = await window.book.create('Self reference', '[[Self reference]]');
		const editor = new NoteEditor(window.book, note);
		const original = window.book.save.bind(window.book);
		let release;
		window.book.save = async (...args) => { const result = await original(...args); await new Promise(resolve => { release = resolve; }); return result; };
		editor.update({ title: 'Renamed self' });
		const pending = editor.save();
		while (!release) await new Promise(resolve => setTimeout(resolve, 5));
		editor.update({ text: '[[Self reference]] plus new writing' });
		release(); await pending; window.book.save = original;
		const draft = get(editor.state), committed = await window.book.get(note.id);
		editor.dispose();
		return { status: draft.status, draft: draft.text, committed: committed.text };
	});
	assert.deepEqual(renameDraft, { status: 'conflict', draft: '[[Self reference]] plus new writing', committed: '[[Renamed self]]' });
	await a.evaluate(async () => {
		const { NoteEditor } = await import('/src/lib/notes/editor.ts');
		const note = await window.book.create('Reload recovery', 'before');
		const editor = new NoteEditor(window.book, note);
		editor.update({ text: 'The conflicting draft must survive reload.' });
		await window.book.save(note.id, 1, { text: 'newer committed writing' });
		await editor.save();
		window.recoveryEditor = editor;
	});
	const recoveryBefore = await a.evaluate(() => window.book.listRecoveredDrafts());
	assert.ok(recoveryBefore.some(draft => draft.text === 'The conflicting draft must survive reload.'));

	a.once('dialog', dialog => dialog.accept());
	await a.reload();
	const persisted = await a.evaluate(async id => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		return new LocalNotebook({ scopeId: 'https://example.test/CasePath|account:1', isCurrent: () => true }).get(id);
	}, graph.source.id);
	assert.equal(persisted.revision, graph.relinked.revision, 'acknowledged writes survive window reload');
	const recoveryAfter = await a.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		return new LocalNotebook({ scopeId: 'https://example.test/CasePath|account:1', isCurrent: () => true }).listRecoveredDrafts();
	});
	assert.ok(recoveryAfter.some(draft => draft.text === 'The conflicting draft must survive reload.'));
	const blockedContext = await browser.newContext();
	const blockedPage = await blockedContext.newPage();
	await blockedPage.goto(`${origin}/notebook-storage-fixture`);
	const blocked = await blockedPage.evaluate(async () => {
		const blocker = await new Promise((resolve, reject) => {
			const opening = indexedDB.open('wabi-local-notes', 1);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const book = new LocalNotebook({ scopeId: 'blocked-fixture', isCurrent: () => true });
		let code;
		try { await book.list(); } catch (error) { code = error.code; }
		blocker.close();
		const after = await book.create('Retry after blocked upgrade');
		return { code, title: after.title };
	});
	assert.deepEqual(blocked, { code: 'unavailable', title: 'Retry after blocked upgrade' });
	await blockedContext.close();
	console.log('PASS: additive upgrade; two-window CAS; atomic rename/backlinks; trash/restore; deleted identity/relink; scoped drafts; abort/retry; reload recovery; shared scratchpad; partial/idempotent legacy recovery; backup validation/round-trip/UUID remapping; typing during self-link rename.');
} finally {
	await browser?.close();
	await vite?.close();
}
