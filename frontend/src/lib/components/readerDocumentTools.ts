export interface ReaderAnchor {
	block: number;
	offset: number;
	progress: number;
}

export interface ReaderHeading {
	id: string;
	label: string;
	level: number;
}

export interface ReaderSearchMatch {
	start: number;
	end: number;
}

export function clampReaderProgress(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function readerPageMetrics(scroll: number, extent: number, size: number) {
	if (!Number.isFinite(size) || size <= 0) return { current: 1, total: 1 };
	const total = Math.max(1, Math.ceil(Math.max(0, extent - 1) / size));
	return { current: Math.max(1, Math.min(total, Math.round(Math.max(0, scroll) / size) + 1)), total };
}

/** Literal, case-insensitive search. Offsets always refer to the original text. */
export function findReaderMatches(text: string, query: string, limit = 1000): ReaderSearchMatch[] {
	const needle = query.trim();
	if (!needle || limit <= 0) return [];
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const expression = new RegExp(escaped, 'giu');
	const matches: ReaderSearchMatch[] = [];
	for (const match of text.matchAll(expression)) {
		matches.push({ start: match.index, end: match.index + match[0].length });
		if (matches.length >= limit) break;
	}
	return matches;
}

/** Only genuine document headings enter the outline; never invent chapter names. */
export function prepareReaderDocument(root: HTMLElement): ReaderHeading[] {
	const used = new Set(Array.from(root.querySelectorAll<HTMLElement>('[id]'), (el) => el.id));
	const outline = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map((el, index) => {
		if (!el.id) {
			let id = `reader-section-${index + 1}`;
			while (used.has(id)) id += '-';
			el.id = id;
			used.add(id);
		}
		return { id: el.id, label: el.textContent?.trim() || 'Untitled section', level: Number(el.tagName[1]) };
	});
	root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
		if (!link.getAttribute('href')?.startsWith('#')) {
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
		}
	});
	root.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
		image.decoding = 'async';
		image.referrerPolicy = 'no-referrer';
	});
	root.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
		if (pre.querySelector('.reader-code-copy')) return;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'reader-code-copy';
		button.textContent = 'Copy';
		button.setAttribute('aria-label', 'Copy code block');
		pre.prepend(button);
	});
	return outline;
}

export function readerBlocks(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,pre,li,figure,table'));
}

export function captureReaderAnchor(viewport: HTMLElement, blocks: HTMLElement[], paged: boolean): ReaderAnchor {
	const extent = paged ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
	const scroll = paged ? viewport.scrollLeft : viewport.scrollTop;
	const progress = extent > 0 ? clampReaderProgress(scroll / extent) : 0;
	const view = viewport.getBoundingClientRect();
	let block = 0;
	let offset = 0;
	// getClientRects, rather than a union rect, handles paragraphs spanning CSS columns.
	for (let index = 0; index < blocks.length; index++) {
		const rects = Array.from(blocks[index].getClientRects());
		const rect = paged
			? rects.find((part) => part.right > view.left + 32 && part.left < view.right - 16)
			: rects[0];
		if (!rect) continue;
		if (paged) {
			block = index;
			// Remember the fraction through a paragraph split across several pages.
			offset = rects.length > 1 ? rects.indexOf(rect) / rects.length : 0;
			break;
		}
		if (rect.top > view.top + 48) break;
		block = index;
		offset = clampReaderProgress((view.top + 32 - rect.top) / Math.max(1, rect.height));
	}
	return { block, offset, progress };
}

export function restoreReaderAnchor(viewport: HTMLElement, blocks: HTMLElement[], anchor: ReaderAnchor, paged: boolean): void {
	const target = blocks[anchor.block];
	if (!target || anchor.block < 0) {
		const max = paged ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
		viewport.scrollTo(paged ? { left: Math.max(0, max) * anchor.progress } : { top: Math.max(0, max) * anchor.progress });
		return;
	}
	// The start of a document includes its title, not just the first body paragraph.
	if (anchor.progress === 0 && anchor.block === 0 && anchor.offset === 0) {
		viewport.scrollTo({ top: 0, left: 0 });
		return;
	}
	const view = viewport.getBoundingClientRect();
	if (paged) {
		const rects = Array.from(target.getClientRects());
		const rect = rects[Math.min(rects.length - 1, Math.floor(anchor.offset * rects.length))];
		if (rect) {
			const left = viewport.scrollLeft + rect.left - view.left;
			viewport.scrollTo({ left: Math.max(0, Math.floor(left / Math.max(1, viewport.clientWidth))) * viewport.clientWidth });
		}
	} else {
		const rect = target.getBoundingClientRect();
		viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + rect.top - view.top + anchor.offset * rect.height - 32) });
	}
}

export function scrollReaderToElement(viewport: HTMLElement, target: HTMLElement, paged: boolean): void {
	const view = viewport.getBoundingClientRect();
	const rect = target.getClientRects()[0] || target.getBoundingClientRect();
	if (paged) {
		const left = viewport.scrollLeft + rect.left - view.left;
		viewport.scrollTo({ left: Math.max(0, Math.floor(left / Math.max(1, viewport.clientWidth))) * viewport.clientWidth });
	} else {
		viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + rect.top - view.top - 32) });
	}
}

export function clearReaderSearch(root: HTMLElement): void {
	root.querySelectorAll<HTMLElement>('mark[data-reader-search]').forEach((mark) => mark.replaceWith(...mark.childNodes));
	root.normalize();
}

/** Highlight text nodes, never HTML strings. Inline formatting and code remain intact. */
export function highlightReaderSearch(root: HTMLElement, query: string): HTMLElement[][] {
	clearReaderSearch(root);
	if (!query.trim()) return [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			return node.parentElement?.closest('button,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
		}
	});
	const nodes: { node: Text; start: number; end: number }[] = [];
	let text = '';
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const start = text.length;
		text += node.textContent || '';
		nodes.push({ node: node as Text, start, end: text.length });
	}
	const matches = findReaderMatches(text, query);
	const groups: HTMLElement[][] = matches.map(() => []);
	// Process each node once; reverse splits preserve offsets in its original prefix.
	let firstMatch = 0;
	for (const item of nodes) {
		while (firstMatch < matches.length && matches[firstMatch].end <= item.start) firstMatch++;
		let endMatch = firstMatch;
		while (endMatch < matches.length && matches[endMatch].start < item.end) endMatch++;
		for (let index = endMatch - 1; index >= firstMatch; index--) {
			const start = Math.max(0, matches[index].start - item.start);
			const end = Math.min(item.end - item.start, matches[index].end - item.start);
			if (end <= start) continue;
			item.node.splitText(end);
			const part = item.node.splitText(start);
			const mark = document.createElement('mark');
			mark.dataset.readerSearch = String(index);
			part.replaceWith(mark);
			mark.append(part);
			groups[index].push(mark);
		}
	}
	return groups;
}
