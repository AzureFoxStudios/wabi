/**
 * Results for the jump palette (Ctrl K), design contract §7.24 with the truth labels of §9.1–§9.3.
 *
 * Pure on purpose: `JumpPalette.svelte` maps the live stores (channels, people, office add-ons,
 * local office drafts) onto the plain inputs below, and this module turns them into ranked,
 * grouped rows with match ranges for the title underline. Nothing here imports the socket graph,
 * so the ranking is tested without a running app.
 *
 * Truth rules carried into the rows:
 * - Office tools are an integration candidate: Documents, Sheets, Present and "New document" carry
 *   the `PREVIEW` maturity tag, and Sheets/Present say "off on this device" while their add-on is
 *   off here (§9.1). Nothing says "Beta", "New" or "Available".
 * - A recent office document is a "Local draft" until it has server metadata; once shared it gets
 *   the seal chip "Server-readable" and its role in the subtitle ("Shared · Editor", §9.3).
 * - A DM or group carries its privacy state only when the room status is known; an unknown status
 *   is left unsaid rather than guessed (`privacyStateFor` owns the words, §9.2). Community channels
 *   are never labelled encrypted.
 */
import { isPaletteShortcut, type PaletteScope } from './jumpPalette';
import type { WorkspaceViewKey } from './components/chat/types';
import type { IconName } from './components/ui/icons';
import type { PrivacyState } from './privacy/privacyState';

// ------------------------------------------------------------------------------------- groups

export type JumpGroup = 'workspaces' | 'documents' | 'channels' | 'people' | 'actions';

/** Section order when nothing is typed (§7.24). With a query, sections follow their best match. */
export const JUMP_GROUPS: readonly JumpGroup[] = Object.freeze(['workspaces', 'documents', 'channels', 'people', 'actions']);

/** English kicker words; the palette renders the `jump.groups.*` locale keys when they resolve. */
export const JUMP_GROUP_LABEL: Readonly<Record<JumpGroup, string>> = Object.freeze({
	workspaces: 'Workspaces',
	documents: 'Recent documents',
	channels: 'Channels',
	people: 'People',
	actions: 'Actions'
});

export const JUMP_GROUP_KEY: Readonly<Record<JumpGroup, string>> = Object.freeze({
	workspaces: 'jump.groups.workspaces',
	documents: 'jump.groups.recent_documents',
	channels: 'jump.groups.channels',
	people: 'jump.groups.people',
	actions: 'jump.groups.actions'
});

/** Which sections each scope chip shows. Recent documents live with Workspaces. */
export const SCOPE_GROUPS: Readonly<Record<PaletteScope, readonly JumpGroup[]>> = Object.freeze({
	all: JUMP_GROUPS,
	channels: Object.freeze(['channels'] as JumpGroup[]),
	people: Object.freeze(['people'] as JumpGroup[]),
	workspaces: Object.freeze(['workspaces', 'documents'] as JumpGroup[]),
	actions: Object.freeze(['actions'] as JumpGroup[])
});

// ------------------------------------------------------------------------------------- truths

/** §9.1, verbatim. */
export const PREVIEW_TITLE = 'Integration candidate, not a deployed feature';
/** §9.2 office share wording: who can read a shared document. */
export const SHARED_DOCUMENT_TITLE = 'Published to this server. The server operator can read this document.';
export const LOCAL_DRAFT_TITLE = 'Only on this device until you share it';

export type JumpTruth =
	/** `.w-tag--mat` PREVIEW. */
	| { kind: 'maturity'; label: 'PREVIEW'; title: string }
	/** Lowercase micro hint: "off on this device". */
	| { kind: 'hint'; label: string }
	/** Locality tag: "Local draft". */
	| { kind: 'locality'; label: string; title: string }
	/** Seal chip for a shared office document: "Server-readable". */
	| { kind: 'seal'; label: 'Server-readable'; title: string }
	/** A DM or group's privacy state, rendered by `PrivacyBadge` (variant chip, conversation). */
	| { kind: 'privacy'; state: PrivacyState };

const PREVIEW: JumpTruth = Object.freeze({ kind: 'maturity', label: 'PREVIEW', title: PREVIEW_TITLE });
const OFF_HERE: JumpTruth = Object.freeze({ kind: 'hint', label: 'off on this device' });
const LOCAL_DRAFT: JumpTruth = Object.freeze({ kind: 'locality', label: 'Local draft', title: LOCAL_DRAFT_TITLE });
const SERVER_READABLE_DOC: JumpTruth = Object.freeze({ kind: 'seal', label: 'Server-readable', title: SHARED_DOCUMENT_TITLE });

// ------------------------------------------------------------------------------------- items

export type OfficeTool = 'documents' | 'sheets' | 'present';
/**
 * A Sheets/Present add-on here: switched on, switched off on this device, not part of this build,
 * or not known yet (its setting has not been read). Only a known "off" says "off on this device".
 */
export type OfficeAddonState = 'on' | 'off' | 'unavailable' | 'unknown';
export type JumpActionId = 'new-document' | 'new-task' | 'mark-all-read' | 'open-settings';

export type JumpTarget =
	| { type: 'view'; view: WorkspaceViewKey }
	| { type: 'dms' }
	| { type: 'channel'; channelId: string }
	| { type: 'voice'; channelId: string }
	| { type: 'conversation'; channelId: string }
	| { type: 'person'; personId: string }
	| { type: 'document'; documentId: string; tool: OfficeTool }
	| { type: 'action'; action: JumpActionId };

export interface JumpPersonTile {
	/** The person's chosen color (user data; the palette passes it through identity ink). */
	color: string | null;
	picture: string | null;
	initial: string;
	/** Presence mark: active, away, busy or offline. */
	presence: 'active' | 'away' | 'busy' | 'offline';
}

export interface JumpItem {
	/** Unique across the index ("channel:general", "workspace:documents"). */
	id: string;
	group: JumpGroup;
	title: string;
	/** Mono `--w-faint` line under the title. */
	subtitle: string;
	/** Extra words that find this row (matched at word starts, never underlined). */
	keywords: readonly string[];
	icon: IconName;
	/** A typeset glyph in the tile instead of an icon: `#` for text channels (§6). */
	glyph?: string;
	/** People (and DMs) show their stamp instead of a glyph tile. */
	person?: JumpPersonTile;
	truths: readonly JumpTruth[];
	/** Unread count for channels and conversations (ink badge). */
	unread?: number;
	/** Where you are: the current channel or workspace (glyph in `--w-sig`). */
	current?: boolean;
	target: JumpTarget;
	/** Tie-breaker and the order when nothing is typed: unread, here now, recency. */
	boost: number;
}

export interface JumpChannelInput {
	id: string;
	name: string;
	type?: string | null;
	unread?: number;
	/** The channel center stage is anchored to. */
	current?: boolean;
	/** Thread parent channel id. */
	parentId?: string | null;
	/** Voice rooms: people in the room. */
	occupancy?: number;
	/** DMs: the other person. */
	person?: { name: string; color?: string | null; picture?: string | null; presence?: JumpPersonTile['presence'] } | null;
	/** Groups: "Theo, Nora +2 more". */
	members?: string | null;
	/** DMs and groups: the derived privacy state, or null while the room status is unknown. */
	privacy?: PrivacyState | null;
}

export interface JumpPersonInput {
	id: string;
	name: string;
	handle?: string | null;
	/** 'active' | 'away' | 'busy' | 'offline' (anything else is offline). */
	status?: string | null;
	color?: string | null;
	picture?: string | null;
	/** Voice room they are in. */
	room?: string | null;
}

export interface JumpDocumentInput {
	id: string;
	kind: 'document' | 'sheets' | 'present';
	title: string;
	updatedAt: number;
	/** The server holds a copy (the local record has server metadata). */
	shared: boolean;
	role?: string | null;
}

export interface JumpIndexInput {
	channels?: readonly JumpChannelInput[];
	people?: readonly JumpPersonInput[];
	documents?: readonly JumpDocumentInput[];
	/** Sheets and Present add-ons on this device. Unknown says nothing; unavailable hides the row. */
	office?: Partial<Record<'sheets' | 'present', OfficeAddonState>>;
	activeView?: WorkspaceViewKey | null;
	/** Name of the channel center stage is anchored to (Chat's subtitle). */
	currentChannelName?: string | null;
	/** Whiteboard needs a channel. */
	canOpenWhiteboard?: boolean;
	/** Channels with unread messages (Mark all read's subtitle). */
	unreadChannels?: number;
	/** For "edited 09:42"; defaults to Date.now(). */
	now?: number;
	/** BCP 47 locale for times; defaults to the runtime's. */
	locale?: string;
}

interface WorkspaceDef {
	key: WorkspaceViewKey | 'dms';
	title: string;
	subtitle: string;
	icon: IconName;
	keywords: string[];
	/** Order when nothing is typed (higher first); folio order breaks ties. */
	rank: number;
	office?: OfficeTool;
}

/**
 * Every workspace, in folio order (§7.10: this channel, community, yours, office, then More), with
 * one name per place (§9.6). DMs is a sidebar place, not a folio tab, but it is a destination too.
 */
const WORKSPACES: readonly WorkspaceDef[] = [
	{ key: 'messages', title: 'Chat', subtitle: 'This channel', icon: 'chat', keywords: ['messages', 'conversation', 'channel'], rank: 0 },
	{ key: 'files', title: 'Files', subtitle: 'This channel · files and transfers', icon: 'folder', keywords: ['uploads', 'attachments', 'transfers'], rank: 0 },
	{ key: 'whiteboard', title: 'Whiteboard', subtitle: 'This channel · a shared canvas', icon: 'whiteboard', keywords: ['canvas', 'draw', 'sketch'], rank: 0 },
	{ key: 'voice', title: 'Calls', subtitle: 'Community · voice rooms and calls', icon: 'voice', keywords: ['voice', 'call', 'audio', 'video', 'rooms'], rank: 4 },
	{ key: 'notifications', title: 'Activity', subtitle: 'Community · mentions, follows and requests', icon: 'bell', keywords: ['notifications', 'mentions', 'inbox', 'alerts'], rank: 4 },
	{ key: 'lore', title: 'Project', subtitle: 'Community · shared plan, wiki and files', icon: 'layers', keywords: ['lore', 'plan', 'repository'], rank: 0 },
	{ key: 'dms', title: 'DMs', subtitle: 'Direct messages and friends', icon: 'dm', keywords: ['direct', 'messages', 'friends', 'conversations'], rank: 3 },
	{ key: 'planner', title: 'My Planner', subtitle: 'Yours · tasks, journal and calendar', icon: 'calendarCheck', keywords: ['tasks', 'todo', 'calendar', 'journal', 'board', 'kanban'], rank: 3 },
	{ key: 'notes', title: 'Notes', subtitle: 'Yours · personal notes', icon: 'note', keywords: ['notebook', 'scratchpad', 'memo'], rank: 2 },
	{ key: 'documents', title: 'Documents', subtitle: 'Office · private drafts and shared documents', icon: 'pages', keywords: ['docs', 'writing', 'office', 'text'], rank: 2, office: 'documents' },
	{ key: 'sheets', title: 'Sheets', subtitle: 'Office add-on · spreadsheets', icon: 'sheet', keywords: ['spreadsheets', 'tables', 'office', 'cells'], rank: 0, office: 'sheets' },
	{ key: 'present', title: 'Present', subtitle: 'Office add-on · slides and presenting', icon: 'present', keywords: ['slides', 'presentation', 'deck', 'office'], rank: 0, office: 'present' },
	{ key: 'media', title: 'Media', subtitle: 'Photos and albums', icon: 'image', keywords: ['photos', 'albums', 'pictures', 'gallery'], rank: 0 },
	{ key: 'reader', title: 'Reader', subtitle: 'Reading and annotation', icon: 'bookOpen', keywords: ['read', 'pdf', 'books', 'annotate'], rank: 0 },
	{ key: 'model', title: '3D viewer', subtitle: 'Models and scenes', icon: 'box', keywords: ['3d', 'model', 'cad', 'stl', 'step', 'models'], rank: 0 },
	{ key: 'map', title: 'Map', subtitle: 'Places and directions', icon: 'map', keywords: ['places', 'directions', 'location'], rank: 0 }
];

const CHANNEL_KIND: Readonly<Record<string, { word: string; icon: IconName; glyph?: string }>> = {
	text: { word: 'Channel', icon: 'hash', glyph: '#' },
	public: { word: 'Channel', icon: 'hash', glyph: '#' },
	forum: { word: 'Forum', icon: 'forum' },
	wiki: { word: 'Wiki', icon: 'book' },
	gallery: { word: 'Gallery', icon: 'image' },
	voice: { word: 'Voice room', icon: 'voice' },
	stage: { word: 'Stage', icon: 'voice' },
	lore: { word: 'Project', icon: 'layers' },
	planning: { word: 'Planning', icon: 'columns' },
	reception: { word: 'Reception', icon: 'inbox' },
	thread_public: { word: 'Thread', icon: 'reply' },
	thread_private: { word: 'Thread', icon: 'reply' },
	dm: { word: 'DM', icon: 'dm' },
	group: { word: 'Group', icon: 'users' }
};

const DOCUMENT_KIND: Readonly<Record<JumpDocumentInput['kind'], { tool: OfficeTool; word: string; icon: IconName }>> = {
	document: { tool: 'documents', word: 'Documents', icon: 'pages' },
	sheets: { tool: 'sheets', word: 'Sheets', icon: 'sheet' },
	present: { tool: 'present', word: 'Present', icon: 'present' }
};

const PRESENCE_WORD: Readonly<Record<JumpPersonTile['presence'], string>> = {
	active: 'Here now',
	away: 'Away',
	busy: 'Busy',
	offline: 'Offline'
};

const ROLE_WORD: Readonly<Record<string, string>> = { owner: 'Owner', editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' };

export function presenceOf(status: string | null | undefined): JumpPersonTile['presence'] {
	return status === 'active' || status === 'online' ? 'active' : status === 'away' || status === 'idle' ? 'away' : status === 'busy' || status === 'dnd' ? 'busy' : 'offline';
}

function initialOf(name: string): string {
	const first = Array.from(name.trim())[0] ?? '?';
	return first.toLocaleUpperCase();
}

function joinParts(...parts: (string | null | undefined | false)[]): string {
	return parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' · ');
}

function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * "edited 09:42" today, "edited Sat 19" this week, "edited 19 Sep" this year, else with the year.
 * Time follows the locale (§3: 24-hour in the reference only because its locale is).
 */
export function formatEdited(updatedAt: number, now: number = Date.now(), locale?: string): string {
	if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
	const at = new Date(updatedAt);
	const today = new Date(now);
	let when: string;
	if (sameDay(at, today)) {
		when = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
	} else if (now - updatedAt < 6 * 86400000 && now > updatedAt) {
		when = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' }).format(at);
	} else if (at.getFullYear() === today.getFullYear()) {
		when = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
	} else {
		when = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
	}
	return `edited ${when}`;
}

/** Build every palette row from plain inputs. Pure; the order within each group is meaningful. */
export function buildJumpIndex(input: JumpIndexInput = {}): JumpItem[] {
	const items: JumpItem[] = [];
	const office = (tool: OfficeTool): OfficeAddonState => (tool === 'documents' ? 'on' : input.office?.[tool] ?? 'unknown');
	const now = input.now ?? Date.now();

	// Workspaces.
	for (const def of WORKSPACES) {
		if (def.key === 'whiteboard' && input.canOpenWhiteboard === false) continue;
		const current = def.key !== 'dms' && input.activeView === def.key;
		const addon = def.office ? office(def.office) : 'on';
		if (addon === 'unavailable') continue;
		const truths: JumpTruth[] = [];
		if (addon === 'off') truths.push(OFF_HERE);
		if (def.office) truths.push(PREVIEW);
		const subtitle =
			def.key === 'messages' && input.currentChannelName ? `This channel · #${input.currentChannelName.replace(/^#/, '')}` : def.subtitle;
		items.push({
			id: `workspace:${def.key}`,
			group: 'workspaces',
			title: def.title,
			subtitle,
			keywords: def.keywords,
			icon: def.icon,
			truths,
			current,
			target: def.key === 'dms' ? { type: 'dms' } : { type: 'view', view: def.key },
			// Where you already are sinks to the end of an empty listing.
			boost: current ? -1 : def.rank / 10
		});
	}

	// Recent office documents, newest first. Sheets and Present drafts only while their add-on is on.
	const documents = [...(input.documents ?? [])]
		.filter((doc) => Boolean(DOCUMENT_KIND[doc.kind]) && office(DOCUMENT_KIND[doc.kind].tool) === 'on')
		.sort((a, b) => b.updatedAt - a.updatedAt);
	documents.forEach((doc, index) => {
		const kind = DOCUMENT_KIND[doc.kind];
		const role = doc.role ? ROLE_WORD[doc.role] ?? null : null;
		items.push({
			id: `document:${doc.kind}:${doc.id}`,
			group: 'documents',
			title: doc.title.trim() || 'Untitled',
			subtitle: joinParts(kind.word, doc.shared && (role ? `Shared · ${role}` : 'Shared'), formatEdited(doc.updatedAt, now, input.locale)),
			keywords: [kind.word.toLowerCase(), doc.kind === 'document' ? 'doc' : doc.kind],
			icon: kind.icon,
			truths: [doc.shared ? SERVER_READABLE_DOC : LOCAL_DRAFT],
			target: { type: 'document', documentId: doc.id, tool: kind.tool },
			boost: 1 - index / Math.max(1, documents.length)
		});
	});

	// Channels and conversations, in the order given (sidebar order).
	const channels = input.channels ?? [];
	const names = new Map(channels.map((channel) => [channel.id, channel.name]));
	for (const channel of channels) {
		const type = channel.type || 'text';
		if (type === 'category') continue;
		const kind = CHANNEL_KIND[type] ?? CHANNEL_KIND.text;
		const unread = Math.max(0, Math.floor(channel.unread ?? 0));
		const conversation = type === 'dm' || type === 'group';
		const voice = type === 'voice' || type === 'stage';
		const title = (type === 'dm' && channel.person?.name) || channel.name || 'Untitled';
		const truths: JumpTruth[] = [];
		if (conversation && channel.privacy && channel.privacy !== 'checking') truths.push({ kind: 'privacy', state: channel.privacy });
		const parent = channel.parentId ? names.get(channel.parentId) : null;
		const occupancy = voice && channel.occupancy ? `${channel.occupancy} in the room` : null;
		// Short index meta only (kind, room size, parent): topics are prose, not mono meta.
		const detail = type === 'group' ? channel.members : parent ? `in #${parent}` : voice ? occupancy : null;
		items.push({
			id: `channel:${channel.id}`,
			group: 'channels',
			title,
			subtitle: joinParts(kind.word, detail),
			keywords: [kind.word.toLowerCase(), ...(type === 'dm' && channel.name && channel.name !== title ? [channel.name] : [])],
			icon: kind.icon,
			glyph: kind.glyph,
			person:
				type === 'dm' && channel.person
					? {
							color: channel.person.color ?? null,
							picture: channel.person.picture ?? null,
							initial: initialOf(channel.person.name || title),
							presence: channel.person.presence ?? 'offline'
						}
					: undefined,
			truths,
			unread: unread || undefined,
			current: Boolean(channel.current),
			target: conversation
				? { type: 'conversation', channelId: channel.id }
				: voice
					? { type: 'voice', channelId: channel.id }
					: { type: 'channel', channelId: channel.id },
			boost: channel.current ? -1 : unread > 0 ? 0.6 : voice && channel.occupancy ? 0.2 : 0
		});
	}

	// People: here now first, then away, then offline; the input order breaks ties.
	for (const person of input.people ?? []) {
		const presence = presenceOf(person.status);
		const handle = person.handle?.trim() ? `@${person.handle.trim().replace(/^@/, '')}` : null;
		const where = person.room ? `In ${person.room}` : PRESENCE_WORD[presence];
		items.push({
			id: `person:${person.id}`,
			group: 'people',
			title: person.name.trim() || handle || 'Someone',
			subtitle: joinParts(handle, where),
			keywords: handle ? [handle.slice(1)] : [],
			icon: 'user',
			person: { color: person.color ?? null, picture: person.picture ?? null, initial: initialOf(person.name || handle || '?'), presence },
			truths: [],
			target: { type: 'person', personId: person.id },
			boost: person.room ? 0.7 : presence === 'active' ? 0.6 : presence === 'away' || presence === 'busy' ? 0.3 : 0
		});
	}

	// Actions.
	const unreadChannels = Math.max(0, Math.floor(input.unreadChannels ?? 0));
	const actions: { id: JumpActionId; title: string; subtitle: string; icon: IconName; keywords: string[]; truths?: JumpTruth[] }[] = [
		{ id: 'new-document', title: 'New document', subtitle: 'Starts as a local draft on this device', icon: 'plus', keywords: ['create', 'write', 'doc', 'draft'], truths: [PREVIEW] },
		{ id: 'new-task', title: 'New task', subtitle: 'Opens My Planner', icon: 'checkSquare', keywords: ['create', 'todo', 'planner', 'add'] },
		{
			id: 'mark-all-read',
			title: 'Mark all read',
			subtitle: unreadChannels === 0 ? 'Nothing is unread' : unreadChannels === 1 ? '1 channel unread' : `${unreadChannels} channels unread`,
			icon: 'check',
			keywords: ['unread', 'clear', 'read', 'badges']
		},
		{ id: 'open-settings', title: 'Open settings', subtitle: 'Profile, appearance, notifications and privacy', icon: 'gear', keywords: ['preferences', 'settings', 'theme', 'appearance', 'profile', 'privacy'] }
	];
	for (const action of actions) {
		items.push({
			id: `action:${action.id}`,
			group: 'actions',
			title: action.title,
			subtitle: action.subtitle,
			keywords: action.keywords,
			icon: action.icon,
			truths: action.truths ?? [],
			target: { type: 'action', action: action.id },
			boost: 0
		});
	}

	return items;
}

// ------------------------------------------------------------------------------------- matching

export type MatchRange = readonly [start: number, end: number];

export interface JumpMatch {
	score: number;
	/** Ranges in the original title (UTF-16 offsets, end exclusive), sorted and merged. */
	ranges: MatchRange[];
}

interface Folded {
	text: string;
	/** Original offset where each folded unit's source character starts / ends. */
	from: number[];
	to: number[];
	/** Folded unit starts a word. */
	wordStart: boolean[];
}

const COMBINING_MARK = /\p{M}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lower-case, accent-free text with a map back to the original offsets, so ranges survive folding. */
function fold(source: string): Folded {
	let text = '';
	const from: number[] = [];
	const to: number[] = [];
	const wordStart: boolean[] = [];
	let offset = 0;
	let previousIsWord = false;
	for (const char of source) {
		const folded = char.normalize('NFD').replace(COMBINING_MARK, '').toLocaleLowerCase();
		const isWord = WORD_CHAR.test(char);
		for (let unit = 0; unit < folded.length; unit++) {
			text += folded[unit];
			from.push(offset);
			to.push(offset + char.length);
			wordStart.push(unit === 0 && isWord && !previousIsWord);
		}
		previousIsWord = isWord;
		offset += char.length;
	}
	return { text, from, to, wordStart };
}

function normalizeQuery(query: string): string {
	return fold(query.trim().replace(/\s+/g, ' ')).text;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

function toOriginal(folded: Folded, start: number, end: number): MatchRange {
	return [folded.from[start], folded.to[end - 1]];
}

/**
 * Runs of the query that each begin at a word start, in order ("mypl" → **My** **Pl**anner).
 * Returns folded [start, end) runs, or null. Bounded backtracking: titles are short.
 */
function wordStartRuns(folded: Folded, query: string): [number, number][] | null {
	let budget = 4000;
	const search = (qi: number, from: number): [number, number][] | null => {
		if (qi === query.length) return [];
		for (let pos = from; pos < folded.text.length; pos++) {
			if (--budget < 0) return null;
			if (!folded.wordStart[pos] || folded.text[pos] !== query[qi]) continue;
			let length = 0;
			while (qi + length < query.length && pos + length < folded.text.length && folded.text[pos + length] === query[qi + length]) length++;
			for (let take = length; take >= 1; take--) {
				const rest = search(qi + take, pos + take);
				if (rest) return [[pos, pos + take], ...rest];
			}
		}
		return null;
	};
	return search(0, 0);
}

/** Score one folded query against one text; null when it does not match. */
function scoreText(folded: Folded, query: string): JumpMatch | null {
	const text = folded.text;
	if (!query || !text) return null;
	if (text === query) return { score: 1000, ranges: [toOriginal(folded, 0, text.length)] };
	if (text.startsWith(query)) {
		return { score: 900 - Math.min(40, text.length - query.length), ranges: [toOriginal(folded, 0, query.length)] };
	}
	// A word inside the title starts with the query: "doc" in "New document".
	for (let pos = 1; pos <= text.length - query.length; pos++) {
		if (folded.wordStart[pos] && text.startsWith(query, pos)) {
			return { score: 800 - Math.min(60, pos), ranges: [toOriginal(folded, pos, pos + query.length)] };
		}
	}
	if (query.length >= 2 && !query.includes(' ')) {
		const runs = wordStartRuns(folded, query);
		if (runs && runs.length > 1) {
			return { score: 650 - runs.length * 10 - Math.min(40, runs[0][0]), ranges: runs.map(([s, e]) => toOriginal(folded, s, e)) };
		}
	}
	// Plain substring, for scripts without spaces and mid-word fragments (two characters or more).
	if (query.length >= 2) {
		const pos = text.indexOf(query);
		if (pos >= 0) return { score: 550 - Math.min(80, pos), ranges: [toOriginal(folded, pos, pos + query.length)] };
	}
	return null;
}

/** Keywords count only at word starts and never outrank a title match. */
function scoreKeywords(keywords: readonly string[], query: string): number {
	let best = 0;
	for (const keyword of keywords) {
		const folded = fold(keyword);
		if (folded.text === query) best = Math.max(best, 520);
		else if (folded.text.startsWith(query)) best = Math.max(best, 500);
		else {
			for (let pos = 1; pos <= folded.text.length - query.length; pos++) {
				if (folded.wordStart[pos] && folded.text.startsWith(query, pos)) {
					best = Math.max(best, 450);
					break;
				}
			}
		}
	}
	return best;
}

/**
 * Match a query against a title (and optional keywords). Every whitespace-separated word must match;
 * the title ranges are what the palette underlines.
 */
export function matchJump(title: string, query: string, keywords: readonly string[] = []): JumpMatch | null {
	const q = normalizeQuery(query);
	if (!q) return { score: 0, ranges: [] };
	const folded = fold(title);
	const whole = scoreText(folded, q);
	if (whole) return { score: whole.score, ranges: mergeRanges(whole.ranges) };
	const words = q.split(' ');
	let total = 0;
	const ranges: MatchRange[] = [];
	for (const word of words) {
		const hit = scoreText(folded, word);
		const keyword = scoreKeywords(keywords, word);
		if (!hit && !keyword) return null;
		if (hit && hit.score >= keyword) {
			total += hit.score;
			ranges.push(...hit.ranges);
		} else total += keyword;
	}
	// Words matched separately rank under the same words matched together.
	const score = total / words.length - (words.length > 1 ? 60 : 0);
	return { score: Math.max(1, score), ranges: mergeRanges(ranges) };
}

/** Split a title into plain and matched parts for rendering (`<mark>` the hits). */
export function highlightParts(text: string, ranges: readonly MatchRange[]): { text: string; hit: boolean }[] {
	const parts: { text: string; hit: boolean }[] = [];
	let cursor = 0;
	for (const [start, end] of mergeRanges([...ranges])) {
		const from = Math.max(cursor, Math.min(start, text.length));
		const to = Math.min(text.length, end);
		if (to <= from) continue;
		if (from > cursor) parts.push({ text: text.slice(cursor, from), hit: false });
		parts.push({ text: text.slice(from, to), hit: true });
		cursor = to;
	}
	if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor), hit: false });
	return parts;
}

// ------------------------------------------------------------------------------------- search

export interface JumpResult {
	item: JumpItem;
	score: number;
	ranges: MatchRange[];
}

export interface JumpSection {
	group: JumpGroup;
	results: JumpResult[];
}

export interface JumpSearchOptions {
	/** Rows per section; defaults depend on the scope and whether something is typed. */
	limits?: Partial<Record<JumpGroup, number>>;
}

/** Everything, nothing typed: a short taste of each section. */
const BROWSE_LIMITS: Readonly<Record<JumpGroup, number>> = { workspaces: 4, documents: 3, channels: 5, people: 3, actions: 4 };
/** Everything, something typed: room for the best few of each. */
const QUERY_LIMITS: Readonly<Record<JumpGroup, number>> = { workspaces: 4, documents: 4, channels: 6, people: 5, actions: 4 };
/** A single scope lists all of it. */
const SCOPED_LIMIT = 60;

/**
 * Rank `items` for `query` in `scope` and group them. With nothing typed, sections keep the
 * contract order and rows their `boost` order. With a query, rows rank by match score, then boost,
 * then input order, and sections follow their best row (fixed order breaks ties), so the first row
 * is always the best match.
 */
export function searchJump(items: readonly JumpItem[], query: string, scope: PaletteScope = 'all', options: JumpSearchOptions = {}): JumpSection[] {
	const groups = SCOPE_GROUPS[scope] ?? JUMP_GROUPS;
	const typed = normalizeQuery(query) !== '';
	const sections: JumpSection[] = [];
	for (const group of groups) {
		const limit = options.limits?.[group] ?? (scope !== 'all' ? SCOPED_LIMIT : typed ? QUERY_LIMITS[group] : BROWSE_LIMITS[group]);
		const ranked: (JumpResult & { order: number })[] = [];
		items.forEach((item, order) => {
			if (item.group !== group) return;
			const match = typed ? matchJump(item.title, query, item.keywords) : { score: 0, ranges: [] };
			if (match) ranked.push({ item, score: match.score, ranges: match.ranges, order });
		});
		ranked.sort((a, b) => b.score - a.score || b.item.boost - a.item.boost || a.order - b.order);
		const results = ranked.slice(0, Math.max(0, limit)).map(({ item, score, ranges }) => ({ item, score, ranges }));
		if (results.length) sections.push({ group, results });
	}
	if (typed) {
		const rank = (group: JumpGroup) => JUMP_GROUPS.indexOf(group);
		sections.sort((a, b) => b.results[0].score - a.results[0].score || rank(a.group) - rank(b.group));
	}
	return sections;
}

/** The rows in the order arrow keys walk them. */
export function flattenSections(sections: readonly JumpSection[]): JumpResult[] {
	return sections.flatMap((section) => section.results);
}

// ------------------------------------------------------------------------------------- shortcut

export interface PaletteKeyContext {
	/** The palette is open (Ctrl K closes it). */
	open: boolean;
	/** The app shell is mounted, so a result has somewhere to go. */
	appReady: boolean;
	/** Another modal dialog is open; the palette does not open over it. */
	modalOpen?: boolean;
}

type ShortcutEvent = Parameters<typeof isPaletteShortcut>[0] & {
	defaultPrevented?: boolean;
	target?: EventTarget | null;
};

/** An editor that binds Ctrl K itself marks its root with this attribute and keeps the key. */
export const KEEPS_PALETTE_SHORTCUT = 'data-keeps-ctrl-k';

function keepsShortcut(target: EventTarget | null | undefined): boolean {
	const element = target as { closest?: (selector: string) => unknown } | null | undefined;
	return Boolean(element && typeof element.closest === 'function' && element.closest(`[${KEEPS_PALETTE_SHORTCUT}]`));
}

/**
 * What a keydown means for the palette: 'toggle' or null. Ctrl K works everywhere, text fields
 * included, and gives way only where the key is already taken: a focused editor that handled it
 * (`defaultPrevented`) or declares it (`data-keeps-ctrl-k`).
 */
export function paletteKeyAction(event: ShortcutEvent, context: PaletteKeyContext): 'toggle' | null {
	if (!isPaletteShortcut(event)) return null;
	if (event.defaultPrevented || keepsShortcut(event.target)) return null;
	if (context.open) return 'toggle';
	if (!context.appReady || context.modalOpen) return null;
	return 'toggle';
}
