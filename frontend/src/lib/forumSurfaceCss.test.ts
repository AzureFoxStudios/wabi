import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Contract: design spec §8.7 (forum list, article, votes, replies, reply dock, new thread), §2
// (rules not boxes, ink primary, words over glyphs, nothing moves under the pointer), §4.6
// (focus), §5.2 (selection grammar) and critiques forum-wiki#1, #2, #5–#9, #11, #13, #14, #19.
// Sources are read as text so a regression fails without a browser. Comments are removed by
// scanning, never by a regex replace over styles or markup.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const forumCss = read('../styles/components/forum.css');
const readingCss = read('../styles/surfaces/reading.css');
const controlsCss = read('../styles/components/controls.css');
const channel = read('./components/ForumChannel.svelte');
const row = read('./components/ForumPostRow.svelte');
const reply = read('./components/ForumReply.svelte');
const composer = read('./components/ForumComposer.svelte');
const body = read('./components/ForumBody.svelte');

interface Rule {
	selectors: string[];
	body: string;
	/** Enclosing at-rule preludes, outermost first. */
	context: string[];
}

function withoutComments(source: string, open = '/*', close = '*/'): string {
	let out = '';
	let index = 0;
	while (index < source.length) {
		const start = source.indexOf(open, index);
		if (start < 0) {
			out += source.slice(index);
			break;
		}
		out += source.slice(index, start);
		const end = source.indexOf(close, start + open.length);
		index = end < 0 ? source.length : end + close.length;
	}
	return out;
}

function splitSelectors(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of list) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current.trim());
	return parts.filter(Boolean);
}

function rules(source: string): Rule[] {
	const css = withoutComments(source);
	const out: Rule[] = [];
	const stack: string[] = [];
	let buffer = '';
	for (const ch of css) {
		if (ch === '{') {
			const prelude = buffer.trim().split(/\s+/).join(' ');
			buffer = '';
			stack.push(prelude.startsWith('@') ? prelude : `rule:${prelude}`);
			continue;
		}
		if (ch === '}') {
			const top = stack.pop();
			if (top?.startsWith('rule:')) {
				out.push({ selectors: splitSelectors(top.slice(5)), body: buffer.trim(), context: stack.filter((entry) => entry.startsWith('@')) });
			}
			buffer = '';
			continue;
		}
		if (ch === ';' && !stack.at(-1)?.startsWith('rule:')) {
			buffer = '';
			continue;
		}
		buffer += ch;
	}
	return out;
}

const declarations = (rule: Rule) =>
	rule.body
		.split(';')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const colon = entry.indexOf(':');
			return { property: entry.slice(0, colon).trim(), value: entry.slice(colon + 1).trim() };
		});

const forumRules = rules(forumCss);
const exact = (selector: string, context?: string) =>
	forumRules.filter((rule) => rule.selectors.includes(selector) && (context === undefined ? rule.context.length === 0 : rule.context.includes(context)));
const value = (selector: string, property: string, context?: string) =>
	exact(selector, context)
		.flatMap(declarations)
		.filter((declaration) => declaration.property === property)
		.map((declaration) => declaration.value)
		.at(-1);

/** The markup part of a Svelte file: no script, no style, no comments. */
function markup(source: string): string {
	let out = withoutComments(source, '<script', '</script>');
	out = withoutComments(out, '<style', '</style>');
	return withoutComments(out, '<!--', '-->');
}

describe('forum.css draws only with roles and tokens', () => {
	const css = withoutComments(forumCss);

	test('no raw colors or legacy tokens', () => {
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(css).not.toMatch(/\b(rgba?|hsla?)\(/);
		expect(css).not.toMatch(/--(surface|accent-primary|text-(heading|secondary|muted|primary)|border-(default|strong))/);
	});

	test('every text size follows --w-fs (a type token or calc(N * var(--w-fs)))', () => {
		for (const rule of forumRules) {
			for (const { property, value: v } of declarations(rule)) {
				if (property === 'font-size' || property === 'line-height') expect(v, `${rule.selectors.join(', ')} ${property}`).toContain('var(--w-fs)');
				if (property === 'font' && !v.startsWith('var(--w-t-') && v !== 'inherit') expect(v, rule.selectors.join(', ')).toContain('var(--w-fs)');
			}
		}
	});

	test('no transition: all, no !important, no infinite animation', () => {
		expect(css).not.toMatch(/transition:\s*all\b/);
		expect(css).not.toContain('!important');
		expect(css).not.toContain('infinite');
	});

	test('rendered HTML is never pre-wrapped (doubled paragraph gaps, forum-wiki#1)', () => {
		expect(css).not.toContain('pre-wrap');
		expect(withoutComments(readingCss)).not.toContain('pre-wrap');
	});
});

describe('layout (§8.7)', () => {
	test('a 44px toolbar, and the list beside the reading pane from 1050px of forum width', () => {
		expect(value('.forum-toolbar', 'height')).toBe('44px');
		expect(value('.forum-panes', 'grid-template-columns', '@container forum (min-width: 1050px)')).toBe('clamp(280px, 34%, 400px) minmax(0, 1fr)');
	});

	test('the panes are a grid of one row that fills the forum, whatever host flexes around it', () => {
		// The companion panel's stale `.right-panel-embedded .forum-body` flex-column rule (owned by
		// WorkspacePanelHost) floated the dock under short threads and stacked the two panes.
		expect(markup(channel)).toContain('<div class="forum-panes">');
		expect(markup(channel)).not.toContain('class="forum-body"');
		expect(value('.forum-panes', 'display')).toBe('grid');
		expect(value('.forum-panes', 'grid-template-rows')).toBe('minmax(0, 1fr)');
	});

	test('the list column ends on the footer rule beside the reply dock (§2.2)', () => {
		const wide = '@container forum (min-width: 1050px)';
		expect(value('.forum-panes', 'grid-template-rows', wide)).toBe('minmax(0, 1fr) var(--w-foot, 80px)');
		expect(value('.forum-panes::after', 'border-top', wide)).toBe('var(--w-bw) solid var(--w-line)');
		expect(value('.forum-panes::after', 'grid-area', wide)).toBe('2 / 1 / 3 / 2');
		expect(value('.forum-reading-pane', 'grid-area', wide)).toBe('1 / 2 / 3 / 3');
		expect(value('.forum-channel:not(.has-dock) .forum-panes::after', 'grid-column', wide)).toBe('1 / 3');
		expect(channel).toContain('class:has-dock=');
	});

	test('the toolbar steps by measure in em, so nothing paints over the search at mid widths', () => {
		const compact = '@container forum (max-width: 51.99em)';
		const narrow = '@container forum (max-width: 35.99em)';
		expect(value('.forum-channel', 'font')).toBe('var(--w-t-ui)');
		expect(value('.forum-channel .forum-filters .w-select__label', 'display', compact)).toBe('none');
		expect(value('.forum-channel:not(.is-reading, .is-composing) .forum-new-label', 'clip-path', compact)).toBe('inset(50%)');
		expect(value('.forum-channel .forum-category-select .w-select__value', 'max-width')).toBe('10em');
		expect(value('.forum-channel .forum-sort .forum-sort-glyph', 'display', narrow)).toBe('block');
		// Sort is offered at every width (it used to vanish under 520px).
		for (const rule of forumRules.filter((r) => r.selectors.some((sel) => /\.forum-sort\b(?![-\w])/.test(sel) && !sel.includes(' :is(') && !sel.includes('forum-sort-glyph')))) {
			expect(declarations(rule)).not.toContainEqual({ property: 'display', value: 'none' });
		}
	});

	test('the article, the replies and both composers share one 720 column', () => {
		const column = forumRules.find((rule) => rule.selectors.includes('.forum-article') && rule.selectors.includes('.forum-replies'));
		expect(column?.selectors).toContain('.forum-composer-inner');
		expect(declarations(column as Rule)).toContainEqual({ property: 'max-width', value: '720px' });
	});

	test('one scroller per pane: the reading pane clips, its content scrolls', () => {
		expect(value('.forum-reading-pane', 'overflow')).toBe('hidden');
		expect(value('.forum-reading-content', 'overflow-y')).toBe('auto');
		for (const selector of ['.forum-reply', '.forum-replies', '.forum-article', '.forum-reply-body', '.forum-article-body']) {
			expect(value(selector, 'overflow'), selector).toBeUndefined();
			expect(value(selector, 'overflow-y'), selector).toBeUndefined();
			expect(value(selector, 'max-height'), selector).toBeUndefined();
		}
	});

	test('the reply dock rests as a 56px field-button in the 80px footer band', () => {
		expect(value('.forum-reply-dock', 'height')).toBe('var(--w-foot, 80px)');
		expect(value('.forum-reply-dock', 'border-top')).toBe('var(--w-bw) solid var(--w-line)');
		expect(value('.forum-reply-open', 'height')).toBe('56px');
	});

	test('the dock and the reading column reserve the same scrollbar gutter, so their edges meet', () => {
		expect(value('.forum-reading-content', 'scrollbar-gutter')).toBe('stable both-edges');
		expect(value('.forum-reply-dock', 'scrollbar-gutter')).toBe('stable both-edges');
		expect(value('.forum-reply-dock', 'overflow')).toBe('hidden');
	});

	test('list titles serif 17/24 and the article title serif 30/38, matched past headings.css', () => {
		expect(value('.forum-post-row-title', 'font')).toBe('600 calc(17px * var(--w-fs)) / calc(24px * var(--w-fs)) var(--w-serif)');
		expect(value('.forum-article-title', 'font')).toBe('600 calc(30px * var(--w-fs)) / calc(38px * var(--w-fs)) var(--w-serif)');
		expect(readingCss).toContain(':root .forum-channel h1.forum-article-title');
		expect(readingCss).toContain(':root .forum-channel .forum-post-row-title');
	});
});

describe('selection, hover and focus (§5.2, §4.6, §2.7)', () => {
	test('the active row is a raise fill: no left bar, no padding shift (forum-wiki#9)', () => {
		const active = forumRules.filter((rule) => rule.selectors.some((selector) => selector.includes('.forum-post-row.active')));
		expect(active.length).toBeGreaterThan(0);
		for (const rule of active) {
			for (const { property } of declarations(rule)) {
				expect(property, rule.selectors.join(', ')).not.toMatch(/^(border-left|border-inline-start|padding|padding-left|margin|transform)/);
			}
		}
		expect(value('.forum-post-row.active', 'background')).toBe('var(--w-raise)');
		expect(value(":root[data-char='contrast'] .forum-post-row.active", 'box-shadow')).toBe('inset 0 0 0 1px var(--w-line-strong)');
	});

	test('hover changes fill or color only, never geometry', () => {
		const geometry = /^(width|height|min-width|min-height|padding|margin|gap|font|font-size|font-weight|transform|scale|translate|inset|top|left|right|bottom)/;
		const hover = forumRules.filter((rule) => rule.selectors.some((selector) => selector.includes(':hover')));
		expect(hover.length).toBeGreaterThan(0);
		for (const rule of hover) {
			for (const { property } of declarations(rule)) expect(geometry.test(property), `${rule.selectors.join(', ')} sets ${property}`).toBe(false);
		}
	});

	test('focus is a 2px accent outline (inset on rows and inside the vote pill); never a box-shadow ring', () => {
		const focus = forumRules.filter((rule) => rule.selectors.some((selector) => selector.includes(':focus-visible')) && !rule.context.includes('@media (forced-colors: active)'));
		expect(focus.length).toBeGreaterThan(0);
		for (const rule of focus) {
			const decls = declarations(rule);
			const outline = decls.find((d) => d.property === 'outline');
			if (outline?.value === 'none') {
				// A field-like control draws the kit ring instead (§4.6: fields get an accent edge plus --w-ring).
				expect(decls).toContainEqual({ property: 'border-color', value: 'var(--w-accent)' });
				continue;
			}
			expect(outline?.value, rule.selectors.join(', ')).toBe('2px solid var(--w-accent)');
		}
		expect(value('.forum-post-row-open:focus-visible', 'outline-offset')).toBe('-2px');
		expect(value('.forum-vote-btn:focus-visible', 'outline-offset')).toBe('-2px');
	});

	test('forced colors keep a focus outline where the field-button drew an edge and a ring (§10)', () => {
		const forced = '@media (forced-colors: active)';
		expect(value('.forum-reply-open:focus-visible', 'outline', forced)).toBe('2px solid CanvasText');
		expect(value('.forum-vote-btn:focus-visible', 'outline', forced)).toBe('2px solid CanvasText');
	});

	test('targets: vote keys reach 32px in the pill, 44px on touch and phones (§10)', () => {
		expect(value('.forum-vote', 'height')).toBe('32px');
		expect(value('.forum-vote-btn::before', 'inset')).toBe('-2px');
		const touch = '@media (pointer: coarse), (max-width: 599.98px)';
		expect(value('.forum-vote', 'height', touch)).toBe('44px');
		expect(value('.forum-vote-btn', 'width', touch)).toBe('40px');
		expect(value('.forum-channel .forum-more', 'height', '@media (max-width: 599.98px)')).toBe('44px');
		for (const source of [reply, row]) expect(markup(source)).not.toMatch(/w-ibtn--sm forum-more|w-btn--sm forum-mark-solution/);
	});

	test('row and reply tools stay in place and appear on hover or focus', () => {
		expect(value('.forum-post-row-tools', 'position')).toBe('absolute');
		const shown = forumRules.find((rule) => rule.selectors.includes('.forum-channel .forum-post-row:focus-within .forum-more'));
		expect(declarations(shown as Rule)).toContainEqual({ property: 'opacity', value: '1' });
	});
});

describe('markup: words over glyphs, true labels (§2.6, §9)', () => {
	const sources = { channel, row, reply, composer, body };

	test('no text glyphs, emoji or HTML-entity glyphs in forum chrome (forum-wiki#19)', () => {
		for (const [name, source] of Object.entries(sources)) {
			const html = markup(source);
			for (const glyph of ['▲', '▼', '⋯', '✓', '✕', '✎', '×', '←', '↻', '▶', '•', '\u{1F441}', '\u{1F4C4}']) {
				expect(html.includes(glyph), `${name} renders ${glyph}`).toBe(false);
			}
			expect(html, name).not.toMatch(/&#\d+;|&#x[0-9a-f]+;|&(times|check|larr|rarr|bull);/i);
		}
	});

	test('no "views" count: the old meta line showed the vote total under that word (forum-wiki#5)', () => {
		expect(markup(channel)).not.toMatch(/\bviews?\b/i);
		expect(markup(row)).not.toMatch(/\bviews?\b/i);
	});

	test('the byline says which version you read', () => {
		expect(channel).toContain('forumVersionNote(threadStarter, formatForumTime)');
	});

	test('a vote keeps keyboard focus: the keys lock with aria-disabled, never disabled mid-request', () => {
		for (const source of [markup(channel), markup(reply)]) {
			expect(source).not.toMatch(/disabled=\{[^}]*(voting|votingIds)/);
			expect(source.split("aria-disabled={").length - 1).toBeGreaterThanOrEqual(2);
			expect(source).toContain('A vote cannot be changed or taken back.');
		}
		expect(channel).toContain('myVotes[post.post_id]) return;');
	});

	test('votes are one labelled pill: aria-pressed and "Upvote, N points" on each button (forum-wiki#8)', () => {
		for (const source of [markup(channel), markup(reply)]) {
			expect(source).toContain('class="forum-vote" role="group"');
			expect(source.split('class="forum-vote-btn"').length - 1).toBe(2);
			expect(source.split('aria-pressed=').length - 1).toBe(2);
			expect(source).toContain("forumVoteLabel('up'");
			expect(source).toContain("forumVoteLabel('down'");
		}
	});

	test('the solution: a quiet "Mark as solution" for the thread author or a moderator, "Solved" as mark plus word', () => {
		expect(markup(reply)).toContain('w-btn w-btn--quiet forum-mark-solution');
		expect(markup(reply)).toContain('Mark as solution');
		expect(channel).toContain('forumCanMarkSolution(canPickSolution, $currentUser?.dbUserId, reply.author_user_id)');
		expect(channel).toContain('canManageForumPost($currentUser, threadStarter.author_user_id)');
		for (const source of [channel, row, reply]) expect(markup(source)).toContain('<Icon name="checkCircle" size={14} />Solved');
	});

	test('one control path: no "All threads" button or Categories overlay (forum-wiki#6)', () => {
		const html = markup(channel);
		expect(html).not.toContain('All threads</button>');
		expect(html).not.toContain('forum-category-header');
		expect(html).toContain('Threads');
		expect(channel).toContain('if (showNewThread) {\n\t\t\tshowNewThread = false;');
	});

	test('sentence-case verbs and the reply dock words (§9.3, §9.6)', () => {
		expect(composer).toContain("'Post thread' : 'Post reply'");
		expect(markup(composer)).toContain('Draft kept on this device');
		expect(markup(composer)).toContain("Reply to ${replyTo}…");
		expect(markup(channel)).toContain('New thread');
		for (const source of [channel, composer]) expect(source).not.toMatch(/Post Reply|Create Thread|New Thread\b/);
	});

	test('the reply dock starts collapsed and offers Write | Preview once open', () => {
		expect(composer).toContain('let expanded = showTitle || hasContent();');
		expect(markup(composer)).toContain("{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }");
	});

	test('no browser confirm/alert/prompt: discards go through the confirm dialog', () => {
		for (const source of [channel, composer, reply]) expect(source).not.toMatch(/window\.(confirm|alert|prompt)\(/);
		expect(composer).toContain('confirmAction(');
	});

	test('a failure is said where it was asked, in view, in plain words (§7.16)', () => {
		const html = markup(channel);
		// A vote, solution or delete: under that post's actions, revealed in the scroller.
		expect(html).toContain('{#if postNotice && postNotice.postId === threadStarter.post_id}');
		expect(html).toContain('<div class="forum-post-notice" use:reveal>');
		expect(markup(reply)).toContain('<div class="forum-post-notice" use:reveal>');
		expect(html).toContain('notice={postNotice && postNotice.postId === reply.post_id ? postNotice : null}');
		// A rename: in the strip under the toolbar where it was asked.
		expect(html).toContain('<div class="forum-category-notice">');
		// Only a load failure reaches the store's notice above the article; actions claim theirs.
		expect(channel).toContain('$: if (actionsInFlight === 0) loadError = storeError;');
		for (const action of ['votePost', 'markSolution', 'deleteForumPost', 'createPost', 'createThread', 'renameForumCategory']) {
			expect(channel, action).toContain(`runAction(() => ${action}(`);
		}
		expect(html).not.toContain('{error}</');
		expect(html).not.toContain('{loadError}</');
	});

	test('the forum is named as the masthead names it, without "#"', () => {
		expect(channel).toContain("$: channelName = activeChannel?.name || 'this forum';");
		expect(channel).not.toContain('`#${activeChannel.name}`');
	});

	test('icon-only controls carry a tooltip; an open reply dock takes the one primary (§2.4, §7.2)', () => {
		const html = markup(channel);
		expect(html).toContain('<Tooltip text="New thread" disabled={!newIconOnly}>');
		expect(html).toContain('<Tooltip text={`Sort: ${sortLabel}`} disabled={!sortIconOnly}>');
		expect(html).toContain('class:w-btn--primary={!inPanel && !dockOpen}');
		expect(composer).toContain('$: onExpandedChange?.(expanded);');
	});

	test('focus comes back after a reply posts and after the category strip closes', () => {
		expect(composer).toContain('if (!showTitle) void collapse();');
		expect(channel).toContain("closeCategoryEditor(true)");
		expect(channel).toContain(".querySelector<HTMLElement>('.forum-category-select')?.focus()");
	});

	test('the dock draws the same stamp as the byline: the picture when there is one', () => {
		expect(markup(composer)).toContain('{#if me?.profilePicture}<ProfileMedia src={mediaUrl(me.profilePicture)} alt="" />');
	});

	test('every post renders through the one prose style', () => {
		expect(markup(body)).toContain('class="forum-rich-body w-prose"');
		expect(body).not.toContain('markdown-content');
		expect(body).not.toContain('pre-wrap');
	});
});

describe('controls.css: the legacy buttons are drawn like the kit (§7.1, forum-wiki#11)', () => {
	const controlRules = rules(controlsCss);
	const get = (selector: string, property: string) =>
		controlRules
			.filter((rule) => rule.selectors.includes(selector) && rule.context.length === 0)
			.flatMap(declarations)
			.filter((d) => d.property === property)
			.map((d) => d.value)
			.at(-1);

	test('primary is ink on paper, never an accent fill', () => {
		expect(get('.ui-btn-primary', 'background')).toBe('var(--w-text)');
		expect(get('.ui-btn-primary', 'color')).toBe('var(--w-bg)');
		expect(withoutComments(controlsCss)).not.toContain('--accent-primary');
	});

	test('danger stays outlined until hover; focus is the accent outline', () => {
		expect(get('.ui-btn-danger', 'background')).toBe('transparent');
		expect(get('.ui-btn:focus-visible', 'outline')).toBe('2px solid var(--w-accent)');
		expect(withoutComments(controlsCss)).not.toContain('--focus-ring-color');
	});

	test('no raw colors', () => {
		const css = withoutComments(controlsCss);
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(css).not.toMatch(/\brgba?\(/);
	});
});
