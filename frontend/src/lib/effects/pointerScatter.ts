import type { LittleWorldPattern } from './mouseFeelerConfig';

// Original, font-independent outline drawings. Coordinates use a 24px square.
// Shared motifs are composed into different worlds; hero drawings are deliberately rare.
export const SCATTER_MOTIFS = {
	cat: 'M-10 5Q-12-2-8-7L-8-12-2-8Q2-9 6-8L11-12 10-4Q14 5 5 9Q-4 12-10 5ZM-5-2h1m8 0h1M-1 2l2 1 2-1M-12 1l5 1m13 0 6-1',
	capybara: 'M-10 5Q-14-2-7-6L-6-10-2-9 0-6Q9-8 12-2L12 4Q9 8-8 8ZM5-2h1m5 3h1M-6 8v3m12-3v3',
	frog: 'M-10-3Q-14-12-7-11Q-3-11-4-5M4-5Q3-11 9-11Q14-11 11-3M-10-3Q0-8 10-3Q15 6 6 9H-6Q-15 6-10-3ZM-5 2Q0 6 5 2M-9-8h1m16 0h1',
	moth: 'M0-5Q-10-15-12-5Q-11 2-3 2Q-12 5-6 10L0 5 6 10Q12 5 3 2Q11 2 12-5Q10-15 0-5ZM0-6v13M0-6-3-10m3 4 3-4M-7-4h1m12 0h1',
	eyes: 'M-12 0Q-6-8 0 0Q-6 8-12 0ZM2 0Q8-8 14 0Q8 8 2 0ZM-6-3v6m14-6v6',
	leaf: 'M-9 10Q-16-7 10-11Q15 10-9 10ZM-11 12 7-7M-5 5-7-2m9 0 6 1',
	flower: 'M0-3C-10-14-15 0-4 2C-15 13 0 16 1 5C11 16 16 1 5 0C14-10 0-15 0-3ZM-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
	mushroom: 'M-12 1Q-9-15 1-12Q11-12 13 1ZM-3 1-5 12H6L4 1M-6-4h1m11-1h1',
	heart: 'M0 10-10 0C-20-12-3-16 0-5C3-16 20-12 10 0Z',
	spade: 'M0-13-10-2C-18 7-7 12-2 5L-4 13H4L2 5C7 12 18 7 10-2Z',
	diamond: 'M0-13 9 0 0 13-9 0Z',
	club: 'M-3 1C-16 7-16-9-5-5C-12-19 12-19 5-5C16-9 16 7 3 1L5 12H-5Z',
	die: 'M-10-10H10V10H-10ZM-6-6h1m10 0h1M0 0h1M-6 6h1m10 0h1',
	d20: 'M0-13 12-5 9 10-9 10-12-5ZM0-13-6 5 12-5-12-5 6 5 0-13M-9 10-6 5 6 5 9 10',
	sword: 'M-9 12 2 1M-5-2 7 10M-1 2 8-11 12-12 11-8 3 6',
	chest: 'M-12-2Q-10-10 0-10Q10-10 12-2V10H-12ZM-12 0H12M-2-2H2V4H-2Z',
	mimic: 'M-12-3Q0-14 12-3L9 11H-10ZM-11-1 11 0M-9 0-6 5-3 0 0 5 3 0 6 5 9 0M-7-5h1m10 0h1',
	castle: 'M-12 11V-8H-8V-4H-4V-12H0V-8H4V-12H8V-4H12V11ZM-3 11V4Q0-1 3 4V11',
	crystal: 'M0-14 8-4 4 11-4 11-8-4ZM0-14-2-3 0 11 3-3ZM-8-4-2-3 3-3 8-4',
	flame: 'M0-13Q5-5 1-1Q9-5 10 3Q12 13 0 13Q-13 11-10 2Q-9-3-4-6Q-5 2-2 3Q3-1 0-13Z',
	question: 'M-7-7C-6-16 10-15 9-5Q8 0 2 1V5M2 10v1',
	coin: 'M-11 0a11 11 0 1 0 22 0a11 11 0 1 0-22 0M-6 0a6 8 0 1 0 12 0a6 8 0 1 0-12 0M0-5v10',
	ghost: 'M-10 11V-2C-10-16 10-16 10-2V11L5 7 0 11-5 7ZM-4-3v4m8-4v4',
	gamepad: 'M-10-5Q-17 10-10 11L-4 6H4L10 11Q17 10 10-5ZM-8-1v6m-3-3h6M6 0h1m3 3h1',
	pawn: 'M-4-6a4 4 0 1 0 8 0a4 4 0 1 0-8 0M-4-1H4L3 5 8 10V12H-8V10L-3 5Z',
	crown: 'M-11-5-7 8H7L11-5 4 0 0-11-4 0ZM-7 11H7',
	scroll: 'M-9-10H8Q14-10 12-4H7V9H-8Q-14 9-12 3H-8V-7Q-12-7-9-10ZM-4-5H4M-4-1H3M-4 3H2',
	rune: 'M0-13V13M0-10 9-4 0 1M-9-6 0 0-8 6M0 4l7 5',
	sigil: 'M-11 0a11 11 0 1 0 22 0a11 11 0 1 0-22 0M0-10 9 6-9 6ZM-13 0H13M0-13V13',
	potion: 'M-4-12H4M-3-12V-4Q15 9 6 12H-6Q-15 9-3-4ZM-7 4H7M-3 7h1m5 2h1',
	star: 'M0-13 3-4 12-4 5 2 8 12 0 6-8 12-5 2-12-4-3-4Z',
	planet: 'M-8-6a10 10 0 1 0 16 12a10 10 0 1 0-16-12M-10 0Q-22 7-10 8Q5 7 16-6Q19-12 8-8',
	moon: 'M7-12C-15-15-17 13 4 13Q12 12 14 5C-5 13-9-6 7-12Z',
	rocket: 'M-4 5Q-12-3 5-13Q14-2 6 6ZM-3 5-7 12-9 5m15 0 7 4-5-9M0-5a3 3 0 1 0 6 0a3 3 0 1 0-6 0M-3 10-6 14',
	fish: 'M-11 0Q0-13 10 0L15-6V6L10 0Q0 13-11 0ZM-6-1h1M1-6-1 5',
	shell: 'M0 11Q-18-1-11-9Q-7-13-3-10Q0-16 3-10Q7-13 11-9Q18-1 0 11ZM0 11V-10M0 11-10-8m10 19L10-8',
	whale: 'M-12 1Q-11-9 1-6L9-1 14-8 16 0Q11 13-3 10Q-12 9-12 1ZM-7 0h1M-5 5Q0 8 4 4M-4-9v-4m0 2-4-2m4 2 4-2',
	tree: 'M0-14 9-4H5L13 5H4V12H-4V5H-13L-5-4H-9ZM0 5v7',
	house: 'M-12-1 0-12 12-1M-9-3V11H9V-3M-2 11V4H3V11M-6 0h3v3h-3Z',
	cloud: 'M-10 7C-19-2-10-9-5-5C-4-16 10-12 10-4C19-4 19 7 10 7ZM-6 11l-2 3m9-3-2 3m9-3-2 3',
	sun: 'M-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M0-14v4m0 20v4M-14 0h4m20 0h4M-10-10l3 3m14 14 3 3M-10 10l3-3m14-14 3-3',
	brush: 'M-3 2 7-13 11-11 1 5ZM-3 3Q-13 4-9 12Q1 15 2 5M-10 11q4 1 5-3',
	pencil: 'M-9 7 6-12 11-8-4 11-11 14ZM-9 7-4 11M3-8l5 4',
	palette: 'M-11-3C-5-18 18-10 12 0Q10 5 5 2Q-2 0 0 7Q5 16-5 11Q-16 7-11-3ZM-7-3h1m5-5h1m7 4h1m-15 7h1',
	monitor: 'M-12-10H12V6H-12ZM-12 2H12M0 6v6m-7 0H7M-7-5l4 2-4 2m7 0h5',
	keyboard: 'M-13-6H13V7H-13ZM-9-2h2m3 0h2m3 0h2m3 0h2M-9 3h2m3 0H6m3 0h2',
	floppy: 'M-11-12H8L12-8V12H-11ZM-6-12V-3H7V-12M-7 12V3H8V12M3-9v4',
	cd: 'M-12 0a12 12 0 1 0 24 0a12 12 0 1 0-24 0M-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M-8-5-5-8m10 16 3-3',
	robot: 'M-10-7H10V10H-10ZM0-7V-12m-3 0h6M-6-2h2m8 0h2M-5 5H5M-14-3v9m28-9v9',
	chip: 'M-8-8H8V8H-8ZM-3-3H3V3H-3ZM-12-5h4m-4 5h4m-4 5h4M8-5h4m-4 5h4m-4 5h4M-5-12v4m5-4v4m5-4v4M-5 8v4m5-4v4m5-4v4',
	note: 'M-4 7V-9L9-12V4M-4-5 9-8M-10 9a4 3 0 1 0 8 0a4 3 0 1 0-8 0M3 6a4 3 0 1 0 8 0a4 3 0 1 0-8 0',
	vinyl: 'M-12 0a12 12 0 1 0 24 0a12 12 0 1 0-24 0M-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M0-1v2M-9-3q2-5 6-6',
	book: 'M0-8Q-6-13-12-9V10Q-6 6 0 11Q6 6 12 10V-9Q6-13 0-8ZM0-8V11M-8-5l4 1m-4 4 4 1m8-6 4-1m-4 6 4-1',
	clip: 'M-5 4 4-7Q10-12 12-5Q12-3 8 2L-2 13Q-8 18-12 11Q-14 7-8 0L1-10Q5-13 7-9Q8-7 5-3L-4 7',
	cup: 'M-9-6H7V5Q7 12-1 12Q-9 12-9 5ZM7-4H12Q17 4 7 5M-5-10v-4m6 4v-4',
} as const;

type Motif = keyof typeof SCATTER_MOTIFS;
type World = { motifs: readonly Motif[]; hero: Motif; density?: number; rotation?: number };
export const SCATTER_WORLDS: Record<LittleWorldPattern, World> = {
	creatures: { motifs: ['cat', 'frog', 'moth', 'leaf', 'capybara'], hero: 'cat' },
	'cat-nap': { motifs: ['cat', 'moon', 'star', 'cup'], hero: 'cat', density: .72, rotation: .22 },
	'capybara-bath': { motifs: ['capybara', 'leaf', 'flower', 'cloud'], hero: 'capybara', rotation: .18 },
	'frog-pond': { motifs: ['frog', 'leaf', 'flower', 'fish'], hero: 'frog' },
	'moth-garden': { motifs: ['moth', 'flower', 'leaf', 'moon'], hero: 'moth' },
	'peeking-eyes': { motifs: ['eyes', 'cat', 'ghost'], hero: 'eyes', density: .65, rotation: .14 },
	suits: { motifs: ['spade', 'heart', 'diamond', 'club'], hero: 'crown' },
	tabletop: { motifs: ['die', 'd20', 'sword', 'coin', 'potion'], hero: 'd20' },
	'tiny-dungeon': { motifs: ['sword', 'chest', 'potion', 'castle'], hero: 'castle' },
	'dungeon-mimics': { motifs: ['chest', 'mimic', 'eyes', 'coin'], hero: 'mimic' },
	'climb-icons': { motifs: ['question', 'sword', 'coin', 'flame', 'chest'], hero: 'crown' },
	'crystal-quest': { motifs: ['crystal', 'star', 'potion', 'sword'], hero: 'crystal' },
	arcade: { motifs: ['ghost', 'gamepad', 'coin', 'star'], hero: 'gamepad' },
	chess: { motifs: ['pawn', 'crown', 'castle', 'diamond'], hero: 'crown', rotation: .16 },
	'ancient-scroll': { motifs: ['scroll', 'rune', 'book', 'sigil'], hero: 'scroll' },
	arcane: { motifs: ['sigil', 'rune', 'moon', 'star'], hero: 'sigil' },
	alchemy: { motifs: ['potion', 'crystal', 'sigil', 'leaf'], hero: 'potion' },
	space: { motifs: ['planet', 'star', 'moon', 'rocket'], hero: 'rocket', density: .75 },
	ocean: { motifs: ['fish', 'shell', 'whale', 'star'], hero: 'whale' },
	forest: { motifs: ['tree', 'leaf', 'mushroom', 'moth'], hero: 'tree' },
	'tiny-worlds': { motifs: ['planet', 'house', 'tree', 'moon'], hero: 'planet', density: .7 },
	weather: { motifs: ['cloud', 'sun', 'moon', 'star'], hero: 'sun' },
	'artist-desk': { motifs: ['brush', 'pencil', 'palette', 'book'], hero: 'palette' },
	computer: { motifs: ['monitor', 'keyboard', 'chip', 'floppy'], hero: 'monitor' },
	'desktop-archaeology': { motifs: ['floppy', 'cd', 'monitor', 'clip', 'cup'], hero: 'floppy' },
	'robot-lab': { motifs: ['robot', 'chip', 'potion', 'monitor'], hero: 'robot' },
	music: { motifs: ['note', 'vinyl', 'star'], hero: 'vinyl' },
	notebook: { motifs: ['book', 'pencil', 'clip', 'cup'], hero: 'book' }
};

export type ScatterItem = { id: string; x: number; y: number; scale: number; rotation: number; motif: Motif; hero: boolean };
export type ScatterBounds = { left: number; top: number; width: number; height: number };

function randomCell(x: number, y: number, seed: number): () => number {
	let s = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed) >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ s >>> 15, s | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

/** World coordinates, independent cells: moving/resizing the reveal never reshuffles a scene. */
export function generateScatter(pattern: LittleWorldPattern, seed: number, patternScale: number, bounds: ScatterBounds): ScatterItem[] {
	const rule = SCATTER_WORLDS[pattern];
	if (!rule || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return [];
	const scale = Number.isFinite(patternScale) ? Math.min(2, Math.max(.5, patternScale)) : 1;
	const spacing = 66 * scale;
	let salt = seed >>> 0;
	for (const char of pattern) salt = (Math.imul(salt, 31) + char.charCodeAt(0)) >>> 0;
	const result: ScatterItem[] = [];
	const x0 = Math.floor(bounds.left / spacing) - 1, y0 = Math.floor(bounds.top / spacing) - 1;
	const x1 = Math.min(x0 + 40, Math.ceil((bounds.left + bounds.width) / spacing) + 1);
	const y1 = Math.min(y0 + 40, Math.ceil((bounds.top + bounds.height) / spacing) + 1);
	for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
		const random = randomCell(x, y, salt);
		// Macro cells make sparse clearings and busy pockets, without a repeated image tile.
		const pocket = randomCell(Math.floor(x / 4), Math.floor(y / 4), salt ^ 0x9e3779b9)();
		if (random() > (.22 + pocket * .73) * (rule.density ?? 1)) continue;
		const px = (x + .5 + (random() - .5) * .68) * spacing;
		const py = (y + .5 + (random() - .5) * .68) * spacing;
		const hero = random() < .045;
		result.push({ id: `${x}:${y}`, x: px, y: py, scale: scale * (hero ? 1.5 + random() * .3 : .58 + random() * .48), rotation: (random() - .5) * 2 * (rule.rotation ?? .48), motif: hero ? rule.hero : rule.motifs[Math.floor(random() * rule.motifs.length)], hero });
		if (!hero && pocket > .55 && random() < .22) {
			result.push({ id: `${x}:${y}:companion`, x: px + spacing * .36, y: py + spacing * .28, scale: scale * .45, rotation: (random() - .5) * 1.2, motif: rule.motifs[Math.floor(random() * rule.motifs.length)], hero: false });
		}
	}
	return result;
}
