import type { BackendPlugin, JsonValue, PluginContext } from '@wabi/plugin-types';

type LookupKind = 'item' | 'job' | 'action' | 'quest' | 'status' | 'zone' | 'map' | 'market' | 'profile';

interface LookupRequest {
	channelId?: string;
	kind?: LookupKind;
	query?: string;
	world?: string;
	dataCenter?: string;
	itemId?: number | string;
	characterId?: number | string;
	freeCompanyId?: number | string;
}

interface LookupCard {
	id: string;
	kind: LookupKind;
	title: string;
	subtitle?: string;
	detail?: string;
	iconUrl?: string;
	link?: string;
	source: 'xivapi' | 'universalis' | 'fallback';
	pinKey?: string;
}

interface RaidNote {
	id: string;
	title: string;
	body: string;
	phase?: string;
	createdAt: number;
	createdBy?: string;
}

interface WipeLogEntry {
	id: string;
	encounter: string;
	phase?: string;
	reason: string;
	createdAt: number;
	createdBy?: string;
}

interface PrepBoardTemplate {
	id: string;
	name: string;
	description?: string;
	notes: RaidNote[];
	createdAt: number;
	createdBy?: string;
}

interface FfxivChannelState {
	channelId: string;
	pinnedCards: LookupCard[];
	raidNotes: RaidNote[];
	wipeLogs: WipeLogEntry[];
	templates: PrepBoardTemplate[];
	updatedAt: number;
}

const STORAGE_KEY = 'ffxiv-super-addon:channels';
const XIVAPI_BASE = 'https://xivapi.com';
const UNIVERSALIS_BASE = 'https://universalis.app';
const MAX_PINS = 60;
const MAX_NOTES = 120;
const MAX_WIPES = 60;
const MAX_TEMPLATES = 20;

let ctxRef: PluginContext | null = null;
const channels = new Map<string, FfxivChannelState>();

function sanitizeString(input: unknown, maxLen = 240): string {
	if (typeof input !== 'string') return '';
	return input.trim().slice(0, maxLen);
}

function sanitizeChannelId(input: unknown): string {
	return sanitizeString(input, 128);
}

function getChannelState(channelId: string): FfxivChannelState {
	const existing = channels.get(channelId);
	if (existing) return existing;
	const created: FfxivChannelState = {
		channelId,
		pinnedCards: [],
		raidNotes: [],
		wipeLogs: [],
		templates: [],
		updatedAt: Date.now()
	};
	channels.set(channelId, created);
	return created;
}

function touchState(state: FfxivChannelState): void {
	state.updatedAt = Date.now();
	state.raidNotes = state.raidNotes.slice(0, MAX_NOTES);
	state.wipeLogs = state.wipeLogs.slice(0, MAX_WIPES);
	state.pinnedCards = state.pinnedCards.slice(0, MAX_PINS);
	state.templates = state.templates.slice(0, MAX_TEMPLATES);
}

async function persist(): Promise<void> {
	if (!ctxRef) return;
	await ctxRef.storage.set(STORAGE_KEY, [...channels.values()] as unknown as JsonValue);
}

async function loadState(ctx: PluginContext): Promise<void> {
	const stored = await ctx.storage.get(STORAGE_KEY);
	if (!Array.isArray(stored)) return;
	for (const candidate of stored) {
		if (!candidate || typeof candidate !== 'object') continue;
		const channelId = sanitizeChannelId((candidate as any).channelId);
		if (!channelId) continue;
		channels.set(channelId, {
			channelId,
			pinnedCards: Array.isArray((candidate as any).pinnedCards) ? (candidate as any).pinnedCards.slice(0, MAX_PINS) : [],
			raidNotes: Array.isArray((candidate as any).raidNotes) ? (candidate as any).raidNotes.slice(0, MAX_NOTES) : [],
			wipeLogs: Array.isArray((candidate as any).wipeLogs) ? (candidate as any).wipeLogs.slice(0, MAX_WIPES) : [],
			templates: Array.isArray((candidate as any).templates) ? (candidate as any).templates.slice(0, MAX_TEMPLATES) : [],
			updatedAt: Number.isFinite((candidate as any).updatedAt) ? Number((candidate as any).updatedAt) : Date.now()
		});
	}
}

async function fetchJson(url: string): Promise<any | null> {
	try {
		const response = await fetch(url, {
			headers: {
				Accept: 'application/json'
			}
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

async function fetchXivApiResource(resource: string, id: number | string): Promise<any | null> {
	const encodedId = encodeURIComponent(String(id));
	const candidates = [
		`${XIVAPI_BASE}/${resource}/${encodedId}`,
		`${XIVAPI_BASE}/${resource.toLowerCase()}/${encodedId}`
	];
	for (const url of candidates) {
		const payload = await fetchJson(url);
		if (payload) return payload;
	}
	return null;
}

async function searchXivApi(index: string, query: string): Promise<any[]> {
	const cleaned = sanitizeString(query, 240);
	if (!cleaned) return [];
	const candidates = [
		`${XIVAPI_BASE}/search?string=${encodeURIComponent(cleaned)}&indexes=${encodeURIComponent(index)}`,
		`${XIVAPI_BASE}/search?string=${encodeURIComponent(cleaned)}&indexes=${encodeURIComponent(index.toLowerCase())}`
	];
	for (const url of candidates) {
		const payload = await fetchJson(url);
		if (payload && Array.isArray(payload.Results)) {
			return payload.Results;
		}
	}
	return [];
}

function makeFallbackCard(kind: LookupKind, title: string, detail: string, pinKey?: string): LookupCard {
	return {
		id: `${kind}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
		kind,
		title,
		detail,
		source: 'fallback',
		pinKey
	};
}

function pickSummary(value: any, keys: string[]): string {
	for (const key of keys) {
		const raw = value?.[key];
		if (typeof raw === 'string' && raw.trim()) return raw.trim();
	}
	return '';
}

function toLookupCard(kind: LookupKind, value: any, detailFallback: string, link?: string): LookupCard {
	const title =
		pickSummary(value, ['Name', 'name', 'Title', 'title']) ||
		pickSummary(value, ['Singular', 'Plural']) ||
		detailFallback;
	const subtitle =
		pickSummary(value, ['Description', 'description', 'Text', 'text']) ||
		pickSummary(value, ['ClassJobCategoryName', 'CategoryName', 'Role']) ||
		'';
	const iconId = pickSummary(value, ['Icon', 'icon']);
	const iconUrl = iconId ? `${XIVAPI_BASE}/i/${iconId.replace(/^\/+/, '')}` : undefined;
	const pinKey = String(value?.ID || value?.id || title).trim();
	return {
		id: `${kind}-${pinKey || detailFallback}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
		kind,
		title,
		subtitle: subtitle || undefined,
		detail: pickSummary(value, ['Description', 'description', 'Help', 'help']) || undefined,
		iconUrl,
		link,
		source: 'xivapi',
		pinKey
	};
}

async function lookupItem(query: string): Promise<LookupCard[]> {
	const cleaned = sanitizeString(query);
	if (!cleaned) return [makeFallbackCard('item', 'Item lookup unavailable', 'Provide an item name or item ID.')];
	const id = Number(cleaned);
	if (Number.isFinite(id) && id > 0) {
		const payload = await fetchXivApiResource('item', id);
		if (payload) return [toLookupCard('item', payload, cleaned, `${XIVAPI_BASE}/item/${id}`)];
	}
	const results = await searchXivApi('Item', cleaned);
	if (results.length > 0) {
		return results.slice(0, 5).map((result) => toLookupCard('item', result, cleaned, `${XIVAPI_BASE}/item/${result.ID}`));
	}
	return [makeFallbackCard('item', cleaned, 'No XIVAPI item result was found.')];
}

async function lookupGeneric(kind: LookupKind, index: string, resource: string, query: string): Promise<LookupCard[]> {
	const cleaned = sanitizeString(query);
	if (!cleaned) return [makeFallbackCard(kind, `${kind} lookup unavailable`, 'Provide a search term.')];
	const id = Number(cleaned);
	if (Number.isFinite(id) && id > 0) {
		const payload = await fetchXivApiResource(resource, id);
		if (payload) return [toLookupCard(kind, payload, cleaned, `${XIVAPI_BASE}/${resource}/${id}`)];
	}
	const results = await searchXivApi(index, cleaned);
	if (results.length > 0) {
		return results.slice(0, 5).map((result) => toLookupCard(kind, result, cleaned, `${XIVAPI_BASE}/${resource}/${result.ID}`));
	}
	return [makeFallbackCard(kind, cleaned, `No XIVAPI ${kind} result was found.`)];
}

async function lookupMarket(itemQuery: string, world?: string, dataCenter?: string): Promise<LookupCard[]> {
	const itemCards = await lookupItem(itemQuery);
	const best = itemCards[0];
	const pinKey = best?.pinKey || sanitizeString(itemQuery);
	if (!pinKey) {
		return [makeFallbackCard('market', 'Market lookup unavailable', 'Provide an item name or ID.')];
	}

	const itemId = Number(pinKey.replace(/[^0-9]/g, ''));
	if (!Number.isFinite(itemId) || itemId <= 0) {
		return [makeFallbackCard('market', best?.title || itemQuery, 'Could not resolve the item ID for market lookup.')];
	}

	const location = sanitizeString(world) || sanitizeString(dataCenter);
	const locationHint = location || 'world or data center';
	const candidates = location
		? [
				`${UNIVERSALIS_BASE}/api/v2/${encodeURIComponent(location)}/${itemId}`,
				`${UNIVERSALIS_BASE}/api/${encodeURIComponent(location)}/${itemId}`
			]
		: [];

	for (const url of candidates) {
		const payload = await fetchJson(url);
		if (payload) {
			const minPrice = Number(payload.minPrice || payload.minPriceNq || payload.minPriceHQ);
			const avgPrice = Number(payload.averagePrice || payload.avgPrice || payload.averagePriceNq);
			const listings = Number(payload.listings || payload.listingCount || 0);
			return [
				{
					id: `market-${itemId}-${location || 'unknown'}`,
					kind: 'market',
					title: best?.title || `Item ${itemId}`,
					subtitle: location ? `Market on ${location}` : 'Market board summary',
					detail: [
						Number.isFinite(minPrice) ? `Min price: ${minPrice}` : 'Min price unavailable',
						Number.isFinite(avgPrice) ? `Average price: ${avgPrice.toFixed(0)}` : 'Average price unavailable',
						`Listings: ${listings}`,
						`Source: Universalis`
					].join(' | '),
					link: url,
					source: 'universalis',
					pinKey: String(itemId)
				}
			];
		}
	}

	return [
		makeFallbackCard(
			'market',
			best?.title || `Item ${itemId}`,
			`Universalis did not return a market snapshot for ${locationHint}.`
		)
	];
}

async function lookupProfile(request: LookupRequest): Promise<LookupCard[]> {
	const characterId = Number(request.characterId || request.query || 0);
	if (Number.isFinite(characterId) && characterId > 0) {
		const payload = await fetchXivApiResource('character', characterId);
		if (payload) {
			return [
				{
					id: `character-${characterId}`,
					kind: 'profile',
					title: pickSummary(payload.Character, ['Name']) || `Character ${characterId}`,
					subtitle: pickSummary(payload.Character, ['Server']) || undefined,
					detail: 'Character profile card sourced from XIVAPI.',
					link: `${XIVAPI_BASE}/character/${characterId}`,
					source: 'xivapi',
					pinKey: `character:${characterId}`
				}
			];
		}
	}

	const freeCompanyId = Number(request.freeCompanyId || 0);
	if (Number.isFinite(freeCompanyId) && freeCompanyId > 0) {
		const payload = await fetchXivApiResource('freecompany', freeCompanyId);
		if (payload) {
			return [
				{
					id: `freecompany-${freeCompanyId}`,
					kind: 'profile',
					title: pickSummary(payload.FreeCompany, ['Name']) || `Free Company ${freeCompanyId}`,
					subtitle: pickSummary(payload.FreeCompany, ['Server']) || undefined,
					detail: 'Free Company profile card sourced from XIVAPI.',
					link: `${XIVAPI_BASE}/freecompany/${freeCompanyId}`,
					source: 'xivapi',
					pinKey: `freecompany:${freeCompanyId}`
				}
			];
		}
	}

	return [
		makeFallbackCard(
			'profile',
			'Runtime profile unavailable',
			'XIVAPI can back static cards, but live character / free-company runtime state is not guaranteed here.'
		)
	];
}

function emitState(ctx: PluginContext, channelId: string): void {
	ctx.emitToChannel(channelId, 'ffxiv:state', getChannelState(channelId) as unknown as JsonValue);
}

const plugin: BackendPlugin = {
	name: 'ffxiv-super-addon',

	async onLoad(ctx: PluginContext) {
		ctxRef = ctx;
		await loadState(ctx);
		ctx.logger.info('FFXIV Super Addon loaded', { channels: channels.size });
	},

	routes: [
		{
			method: 'get',
			path: '/state',
				handler: async (req, res) => {
					const channelId = sanitizeChannelId(req.query?.channelId);
					if (!channelId) {
						res.status(400).json({ success: false, error: 'channelId is required' } as unknown as JsonValue);
						return;
					}
					res.json({ success: true, state: getChannelState(channelId) } as unknown as JsonValue);
				}
			},
		{
			method: 'post',
			path: '/lookup',
			handler: async (req, res) => {
				const body = (await req.json()) as LookupRequest;
				const kind = body?.kind || 'item';
				const rawQuery =
					typeof body?.query === 'string'
						? body.query
						: body?.itemId != null
							? String(body.itemId)
							: body?.characterId != null
								? String(body.characterId)
								: body?.freeCompanyId != null
									? String(body.freeCompanyId)
									: '';
				const query = sanitizeString(rawQuery, 240);
				let cards: LookupCard[] = [];

				switch (kind) {
					case 'item':
						cards = await lookupItem(query);
						break;
					case 'job':
						cards = await lookupGeneric('job', 'ClassJob', 'classjob', query);
						break;
					case 'action':
						cards = await lookupGeneric('action', 'Action', 'action', query);
						break;
					case 'quest':
						cards = await lookupGeneric('quest', 'Quest', 'quest', query);
						break;
					case 'status':
						cards = await lookupGeneric('status', 'Status', 'status', query);
						break;
					case 'zone':
						cards = await lookupGeneric('zone', 'TerritoryType', 'territorytype', query);
						break;
					case 'map':
						cards = await lookupGeneric('map', 'Map', 'map', query);
						break;
					case 'market':
						cards = await lookupMarket(query, body?.world, body?.dataCenter);
						break;
					case 'profile':
						cards = await lookupProfile(body);
						break;
					default:
						cards = [makeFallbackCard('item', 'Unsupported lookup kind', `Kind "${kind}" is not supported.`)];
				}

					res.json({ success: true, cards } as unknown as JsonValue);
				}
			},
		{
			method: 'post',
			path: '/pin',
			handler: async (req, res) => {
				const body = (await req.json()) as { channelId?: string; card?: LookupCard };
				const channelId = sanitizeChannelId(body?.channelId);
					const card = body?.card;
					if (!channelId || !card?.id) {
						res.status(400).json({ success: false, error: 'channelId and card are required' } as unknown as JsonValue);
						return;
					}

				const state = getChannelState(channelId);
				const nextCards = [
					...state.pinnedCards.filter((existing) => existing.id !== card.id),
					card
				].slice(-MAX_PINS);
				state.pinnedCards = nextCards;
				touchState(state);
				await persist();
					res.json({ success: true, state } as unknown as JsonValue);
				}
			},
		{
			method: 'post',
			path: '/unpin',
			handler: async (req, res) => {
				const body = (await req.json()) as { channelId?: string; cardId?: string };
				const channelId = sanitizeChannelId(body?.channelId);
					const cardId = sanitizeString(body?.cardId, 180);
					if (!channelId || !cardId) {
						res.status(400).json({ success: false, error: 'channelId and cardId are required' } as unknown as JsonValue);
						return;
					}

				const state = getChannelState(channelId);
				state.pinnedCards = state.pinnedCards.filter((card) => card.id !== cardId);
				touchState(state);
				await persist();
					res.json({ success: true, state } as unknown as JsonValue);
				}
			},
		{
			method: 'post',
			path: '/note',
			handler: async (req, res) => {
				const body = (await req.json()) as { channelId?: string; title?: string; body?: string; phase?: string };
				const channelId = sanitizeChannelId(body?.channelId);
				const title = sanitizeString(body?.title, 120);
					const noteBody = sanitizeString(body?.body, 2000);
					if (!channelId || !title || !noteBody) {
						res.status(400).json({ success: false, error: 'channelId, title, and body are required' } as unknown as JsonValue);
						return;
					}

				const state = getChannelState(channelId);
				const note: RaidNote = {
					id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					title,
					body: noteBody,
					phase: sanitizeString(body?.phase, 80) || undefined,
					createdAt: Date.now(),
					createdBy: 'api'
				};
				state.raidNotes = [...state.raidNotes, note].slice(-MAX_NOTES);
				touchState(state);
				await persist();
					res.json({ success: true, state, note } as unknown as JsonValue);
				}
			},
		{
			method: 'post',
			path: '/wipe',
			handler: async (req, res) => {
				const body = (await req.json()) as { channelId?: string; encounter?: string; phase?: string; reason?: string };
				const channelId = sanitizeChannelId(body?.channelId);
				const encounter = sanitizeString(body?.encounter, 120);
					const reason = sanitizeString(body?.reason, 2000);
					if (!channelId || !encounter || !reason) {
						res.status(400).json({ success: false, error: 'channelId, encounter, and reason are required' } as unknown as JsonValue);
						return;
					}

				const state = getChannelState(channelId);
				const wipe: WipeLogEntry = {
					id: `wipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					encounter,
					phase: sanitizeString(body?.phase, 80) || undefined,
					reason,
					createdAt: Date.now(),
					createdBy: 'api'
				};
				state.wipeLogs = [...state.wipeLogs, wipe].slice(-MAX_WIPES);
				touchState(state);
				await persist();
					res.json({ success: true, state, wipe } as unknown as JsonValue);
				}
			},
		{
			method: 'post',
			path: '/template',
			handler: async (req, res) => {
				const body = (await req.json()) as { channelId?: string; name?: string; description?: string; notes?: RaidNote[] };
				const channelId = sanitizeChannelId(body?.channelId);
					const name = sanitizeString(body?.name, 120);
					if (!channelId || !name) {
						res.status(400).json({ success: false, error: 'channelId and name are required' } as unknown as JsonValue);
						return;
					}

				const state = getChannelState(channelId);
				const template: PrepBoardTemplate = {
					id: `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					name,
					description: sanitizeString(body?.description, 500) || undefined,
					notes: Array.isArray(body?.notes) ? body.notes.slice(0, MAX_NOTES) : [],
					createdAt: Date.now(),
					createdBy: 'api'
				};
				state.templates = [...state.templates, template].slice(-MAX_TEMPLATES);
				touchState(state);
				await persist();
					res.json({ success: true, state, template } as unknown as JsonValue);
				}
			}
		],

	socketHandlers: {
		'ffxiv:get-state': (socket: { emit: (event: string, payload: unknown) => void }, data: unknown) => {
			const channelId = sanitizeChannelId((data as LookupRequest)?.channelId);
			if (!channelId) {
				socket.emit('ffxiv:error', { message: 'channelId is required' } as unknown as JsonValue);
				return;
			}
			socket.emit('ffxiv:state', getChannelState(channelId) as unknown as JsonValue);
		}
	},

	onMessage(channelId: string, message: any, ctx: PluginContext) {
		const text = typeof message?.text === 'string' ? message.text.trim() : '';
		if (!text.startsWith('/ffxiv') && !text.startsWith('/xiv') && !text.startsWith('/raid') && !text.startsWith('/market')) {
			return;
		}

		const state = getChannelState(channelId);
		state.raidNotes = [
			...state.raidNotes,
			{
				id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				title: text.slice(1).split(/\s+/)[0] || 'ffxiv',
				body: text,
				createdAt: Date.now(),
				createdBy: ctx.users.values().next().value?.username || 'unknown'
			}
		].slice(-MAX_NOTES);
		touchState(state);
		void persist();
		emitState(ctx, channelId);
	}
};

export default plugin;
