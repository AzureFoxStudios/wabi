<!--
	Documents (design contract §8.8, documents-wabi-ink.png): the library, or one document on a
	writing page.

	- Row A is the editor header (ArtifactShell): crumb, PREVIEW, title, locality, save state, the
	  Write | Read segment, Share… and ⋯ (Export: the text as Markdown, HTML or plain text).
	- The page grid: CONTENTS and FACTS in the left aside (sticky), a 680 column with the display
	  title, the meta line (who, and when it was started on this device), a hairline, then the
	  writing page (CollaborativeText on the shared WritingFrame). A right margin balances it.
	  Narrower stages drop the right margin, then the aside.
	- Read renders the same .w-prose on the page background with the markers gone: there is no
	  separate preview panel and no theme-independent paper colour.
	- Opening, creating or importing shows the 2px line; a failure is a notice at the top of the
	  page (with Export recovery when a document is open), never text after the editor.
-->
<script lang="ts">
	import { onMount, onDestroy, tick as settle } from 'svelte';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import ArtifactShell from './ArtifactShell.svelte';
	import ArtifactLibrary from './ArtifactLibrary.svelte';
	import CollaborativeText from './CollaborativeText.svelte';
	import type { OfficeHeaderModes } from './OfficeEditorHeader.svelte';
	import { ArtifactSession, createArtifact, openArtifact, listLocal, download, Y, from64 } from './session';
	import { captureScope, targets, WorkspaceError, type Scope, type Target } from './bridge';
	import { currentHeading, documentFacts, documentHeadings, documentOutline, startedLine } from './documentPage';
	import { currentUser, serverMembers } from '$lib/presenceIdentity';
	import PlannerAvatar from '$lib/components/business/PlannerAvatar.svelte';
	import LoadLine from '$lib/components/ui/LoadLine.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import './workspace.css';
	import './documents.css';

	let scope = $state<Scope | null>(null), active = $state<ArtifactSession | null>(null);
	let error = $state(''), errorDetail = $state<unknown>(null), loading = $state(true), initialShare = $state<'snapshot' | 'live' | undefined>();
	let tick = $state(0), selectionAnchor = $state<string | null>(null), focusAnchor = $state<string | null>(null);
	let mode = $state<'write' | 'read'>('write'), caret = $state(0), pageWidth = $state(0);
	let shell = $state<ArtifactShell>();
	let editor = $state<CollaborativeText>();
	let reading = $state<HTMLElement | null>(null);
	let stop = () => {}, unsubscribe = () => {}, generation = 0, alive = true, previousTarget: unknown;

	const text = $derived.by(() => { tick; return active ? active.body.toString() : ''; });
	const title = $derived.by(() => { tick; return active ? active.title : ''; });
	const format = $derived(active?.record.format ?? 'markdown');
	const headings = $derived(documentHeadings(text, format));
	const outline = $derived(documentOutline(headings));
	const section = $derived(currentHeading(headings, caret));
	const sectionId = $derived(section >= 0 ? String(headings[section].offset) : null);
	const facts = $derived.by(() => { tick; return active ? documentFacts(text, format, active.record.updatedAt) : null; });
	const shared = $derived.by(() => { tick; return !!active?.record.meta; });
	const author = $derived.by(() => {
		tick;
		const owner = active?.record.meta?.ownerUserId;
		const me = $currentUser;
		if (!owner || (me?.dbUserId && me.dbUserId === owner)) return me ? { name: me.username, color: me.color, src: me.profilePicture } : null;
		const person = $serverMembers.find((user) => user.dbUserId === owner);
		return person ? { name: person.username, color: person.color, src: person.profilePicture } : null;
	});
	const started = $derived.by(() => { tick; return active?.record.createdAt ? startedLine(active.record.createdAt) : ''; });

	// Page tiers by the page's own width: the full grid, then no right margin, then one column.
	const tier = $derived(pageWidth >= 1160 ? 'wide' : pageWidth >= 1000 ? 'mid' : 'narrow');
	const hang = $derived(tier !== 'narrow' || (pageWidth - 680) / 2 >= 56);

	const html = $derived.by(() => {
		tick;
		if (!active || mode !== 'read') return '';
		const body = active.body.toString();
		const rendered = active.record.format === 'text' || active.record.format === 'code' ? `<pre>${body.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>` : active.record.format === 'html' ? body : marked.parse(body, { async: false });
		return DOMPurify.sanitize(rendered, { FORBID_TAGS: ['img', 'iframe', 'video', 'audio', 'object', 'embed', 'style', 'form'], FORBID_ATTR: ['style', 'srcset', 'target'], ALLOW_DATA_ATTR: false });
	});

	const modes = $derived<OfficeHeaderModes>({
		label: 'Document mode',
		options: [{ value: 'write', label: 'Write' }, { value: 'read', label: 'Read' }],
		value: mode,
		onchange: (value: string) => {
			mode = value === 'read' ? 'read' : 'write';
			// Read has no text selection: the header and ⋯ stop offering one.
			if (mode === 'read') selectionAnchor = null;
		}
	});
	const EXPORT_AS: Record<string, { label: string; extension: string; type: string }> = {
		markdown: { label: 'Markdown (.md)', extension: 'md', type: 'text/markdown;charset=utf-8' },
		html: { label: 'HTML (.html)', extension: 'html', type: 'text/html;charset=utf-8' },
		text: { label: 'Plain text (.txt)', extension: 'txt', type: 'text/plain;charset=utf-8' },
		code: { label: 'Plain text (.txt)', extension: 'txt', type: 'text/plain;charset=utf-8' }
	};
	const exports = $derived.by((): MenuEntry[] => {
		const as = EXPORT_AS[format] ?? EXPORT_AS.text;
		return [{ id: 'export-text', label: as.label, icon: 'download', hint: 'The text only', keepCase: true, onSelect: () => { if (active) download(`${active.title}.${as.extension}`, active.body.toString(), as.type); } }];
	});

	const current = (own: number, owner: Scope) => alive && own === generation && owner.isCurrent();
	/**
	 * What the notice says: our own sentences (a plain Error or the server's WorkspaceError) say
	 * what happened and what to do; anything else (a browser or parser error) is only logged, and
	 * the cause of the action stands in for it.
	 */
	function fail(e: unknown, cause: string) {
		errorDetail = e;
		error = e instanceof WorkspaceError || (e instanceof Error && e.constructor === Error) ? e.message : cause;
	}
	async function adopt(candidate: ArtifactSession, own: number, owner: Scope) {
		if (!current(own, owner)) { await candidate.close(); return; }
		if (candidate === active) { await candidate.close(); return; }
		const old = active;
		if (old && !(await old.close())) { await candidate.close(); throw new Error('Save the current document or export recovery before switching.'); }
		if (!current(own, owner)) { await candidate.close(); return; }
		stop();
		active = candidate;
		selectionAnchor = null;
		caret = 0;
		stop = candidate.state.subscribe(() => tick++);
	}
	async function run(fn: (owner: Scope, own: number) => Promise<void>, cause = "Couldn't open the document") {
		const owner = scope;
		if (!owner) return;
		const own = ++generation;
		loading = true;
		error = '';
		try { await fn(owner, own); }
		catch (e) { if (current(own, owner)) fail(e, cause); }
		finally { if (current(own, owner)) loading = false; }
	}
	async function open(id: string) {
		await run(async (owner, own) => { initialShare = undefined; focusAnchor = null; await adopt(await openArtifact(owner, id, 'document'), own, owner); });
	}
	async function create() {
		await run(async (owner, own) => { initialShare = undefined; focusAnchor = null; await adopt(await createArtifact(owner, 'document', 'Untitled document', () => {}, 'markdown'), own, owner); }, "Couldn't start a document");
	}
	async function library() {
		await run(async (owner, own) => {
			const old = active;
			if (old && !(await old.close())) throw new Error('Local save failed. Export recovery before leaving.');
			if (current(own, owner)) { stop(); active = null; initialShare = undefined; selectionAnchor = null; focusAnchor = null; }
		}, "Couldn't return to the library");
	}
	async function importFile(file: File) {
		await run(async (owner, own) => {
			if (file.size > 12 * 1024 * 1024) throw new Error('Document file exceeds the 12 MB import limit.');
			const raw = await file.text();
			if (!current(own, owner)) return;
			let name = file.name, kind = /\.html?$/i.test(file.name) ? 'html' : /\.md$/i.test(file.name) ? 'markdown' : 'text', body = raw;
			if (file.name.endsWith('.wabi.json')) {
				const value = JSON.parse(raw);
				if (value.schema !== 1 || value.kind !== 'document' || typeof value.update !== 'string' || !['text', 'markdown', 'html', 'code'].includes(value.format)) throw new Error('Not a supported Wabi document backup.');
				const source = new Y.Doc();
				try { Y.applyUpdate(source, from64(value.update)); name = source.getText('title').toString(); body = source.getText('body').toString(); kind = value.format; }
				finally { source.destroy(); }
			}
			if (body.length > 1048576) throw new Error('Document text exceeds the 1 MB editing limit.');
			initialShare = undefined;
			focusAnchor = null;
			await adopt(await createArtifact(owner, 'document', name, (doc) => doc.getText('body').insert(0, body), kind, undefined, { name: file.name, type: file.type, blob: file }), own, owner);
		}, "Couldn't import that file");
	}
	async function target(input: Target) {
		await run(async (owner, own) => {
			initialShare = input.shareMode;
			focusAnchor = input.anchor || null;
			if (input.id) { await adopt(await openArtifact(owner, input.id, 'document'), own, owner); return; }
			if (input.source) {
				const source = input.source, rows = await listLocal(owner, 'document');
				if (!current(own, owner)) return;
				const old = rows.find((row) => row.sourceKey === source.sourceKey);
				const candidate = old ? await openArtifact(owner, old.id, 'document') : await createArtifact(owner, 'document', source.title, (doc) => doc.getText('body').insert(0, source.content), source.format, source.sourceKey);
				await adopt(candidate, own, owner);
			}
		});
	}
	async function useCopy(copy: ArtifactSession) {
		const owner = scope;
		if (!owner) { await copy.close(); return; }
		await adopt(copy, ++generation, owner);
		initialShare = undefined;
		focusAnchor = null;
	}

	/** CONTENTS: Write puts the caret on the heading; Read scrolls its rendered heading in. */
	async function jump(index: number) {
		const heading = index >= 0 ? headings[index] : null;
		if (mode === 'write') {
			editor?.reveal(heading ? heading.offset : 0);
			caret = heading ? heading.offset : 0;
			return;
		}
		await settle();
		const target = heading ? reading?.querySelectorAll('h1, h2, h3, h4, h5, h6')[index] : reading;
		target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
		caret = heading ? heading.offset : 0;
	}

	onMount(() => {
		void (async () => {
			try {
				const owner = await captureScope();
				if (!alive || !owner.isCurrent()) return;
				scope = owner;
				loading = false;
				unsubscribe = targets.subscribe((value) => {
					if (value.documents && value.documents !== previousTarget) { previousTarget = value.documents; void target(value.documents); }
				});
			} catch (e) {
				if (alive) { loading = false; fail(e, "Couldn't open Documents"); }
			}
		})();
	});
	onDestroy(() => { alive = false; generation++; unsubscribe(); stop(); if (active) void active.close(); });
</script>

{#snippet failure()}
	{#if error}
		<Notice class="document-notice" title={error} text={active ? 'Your document is still here on this device.' : 'Nothing was changed.'} error={errorDetail}>
			{#snippet actions()}
				{#if active}<button type="button" class="w-btn w-btn--sm" onclick={() => download(`${active!.title}.wabi.json`, active!.recovery())}>Export recovery</button>{/if}
			{/snippet}
		</Notice>
	{/if}
{/snippet}

{#if scope && active}
	{#key active.id}
		<ArtifactShell bind:this={shell} session={active} onlibrary={library} {initialShare} {selectionAnchor} onanchor={(anchor) => (focusAnchor = anchor)} oncopy={useCopy} {modes} {exports}>
			<div class="document-page document-page--{tier}" class:document-page--read={mode === 'read'} bind:clientWidth={pageWidth}>
				<LoadLine active={loading} label="Opening document…" class="document-line" />
				{@render failure()}
				<div class="document-grid">
					{#if tier !== 'narrow'}
						<aside class="document-aside" aria-label="About this document">
							<nav class="w-outline document-outline" aria-label="Contents">
								<p class="w-outline__title">Contents</p>
								<ol>
									<li>
										<button type="button" aria-current={section < 0 ? 'location' : undefined} onclick={() => void jump(-1)}>{title}</button>
										{#if outline.length}
											<ol>
												{#each outline as entry (entry.id)}
													<li>
														<button type="button" aria-current={sectionId === entry.id ? 'location' : undefined} onclick={() => void jump(headings.findIndex((heading) => String(heading.offset) === entry.id))}>{entry.text}</button>
														{#if entry.children.length}
															<ol class="document-outline__deep">
																{#each entry.children as child (child.id)}
																	<li><button type="button" aria-current={sectionId === child.id ? 'location' : undefined} onclick={() => void jump(headings.findIndex((heading) => String(heading.offset) === child.id))}>{child.text}</button></li>
																{/each}
															</ol>
														{/if}
													</li>
												{/each}
											</ol>
										{/if}
									</li>
								</ol>
							</nav>
							{#if facts}
								<p class="w-outline__title document-facts-title">Facts</p>
								<dl class="w-facts document-facts">
									<dt>Words</dt><dd>{facts.words}</dd>
									<dt>Reading</dt><dd>{facts.reading}</dd>
									<dt>Edited</dt><dd>{facts.edited}</dd>
									<dt>Format</dt><dd>{facts.format}</dd>
								</dl>
							{/if}
						</aside>
					{/if}
					<article class="document-sheet" aria-label={title}>
						<header class="document-head">
							<h1 class="document-title">{title}</h1>
							{#if author || started}
								<p class="document-meta">
									{#if author}<PlannerAvatar name={author.name} color={author.color} src={author.src} size="sm" /><span class="document-meta__who">{author.name}</span>{/if}
									{#if author && started}<span class="document-meta__sep" aria-hidden="true">·</span>{/if}
									{#if started}<span>{started}</span>{/if}
								</p>
							{/if}
						</header>
						<hr class="document-rule" />
						{#if mode === 'write'}
							<CollaborativeText bind:this={editor} session={active} {hang} onselection={(anchor) => (selectionAnchor = anchor)} oncaret={(at) => (caret = at)} {focusAnchor} oncomment={shared ? () => shell?.commentOnSelection() : undefined} />
						{:else}
							<div class="w-prose document-read" bind:this={reading}>{@html html}</div>
						{/if}
					</article>
				</div>
			</div>
		</ArtifactShell>
	{/key}
{:else if scope}
	<section class="wabi-workspace document-library">
		<LoadLine active={loading} label="Opening document…" class="document-line" />
		{@render failure()}
		<ArtifactLibrary {scope} kind="document" label="Documents" onopen={open} onnew={create} onimport={importFile} accept=".txt,.md,.markdown,.html,.htm,.wabi.json" />
	</section>
{:else}
	<section class="wabi-workspace document-library">
		<LoadLine active={loading} label="Opening Documents…" class="document-line" />
		{@render failure()}
	</section>
{/if}
