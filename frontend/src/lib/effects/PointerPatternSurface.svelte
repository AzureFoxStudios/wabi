<script lang="ts">
	import { onMount } from 'svelte';
	import { isLittleWorldPattern, type FeelerSettings } from './mouseFeelerConfig';
	import { generateScatter, SCATTER_MOTIFS, type ScatterItem } from './pointerScatter';
	import { pointerTrailBounds, type PointerSample, type PointerTrail } from './pointerTrail';

	let { options, trail, imageUrl = '', tileWidth = 96, tileHeight = 96, onerror = () => {} }: {
		options: FeelerSettings; trail: PointerTrail; imageUrl?: string;
		tileWidth?: number; tileHeight?: number; onerror?: (message: string) => void;
	} = $props();
	let canvas: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D | null = null;
	let mask: HTMLCanvasElement;
	let image: HTMLImageElement | null = null;
	let tile: CanvasPattern | null = null;
	let tileKey = '';
	let scatterKey = '';
	let items: ScatterItem[] = [];
	const points: PointerSample[] = [];
	const paths = new Map<string, Path2D>();

	$effect(() => {
		const url = imageUrl;
		image = null;
		tile = null;
		tileKey = '';
		if (!url) return;
		const next = new Image();
		next.onload = () => { image = next; tileKey = ''; };
		next.onerror = () => onerror('This local image could not be decoded. Import it again or choose another effect.');
		next.src = url;
		return () => { next.onload = next.onerror = null; next.src = ''; };
	});

	onMount(() => {
		ctx = canvas.getContext('2d');
		mask = document.createElement('canvas');
		if (!ctx) onerror('Pointer patterns need Canvas rendering on this device.');
		return () => { ctx = null; paths.clear(); };
	});

	function pattern(): CanvasPattern | null {
		if (!ctx) return null;
		const key = `${options.pattern}:${options.patternScale}:${imageUrl}:${!!image}:${tileWidth}:${tileHeight}`;
		if (key === tileKey) return tile;
		tileKey = key;
		const source = document.createElement('canvas');
		const kind = options.pattern;
		const scale = options.patternScale;
		let width = kind === 'triangles' ? 52 : kind === 'dots' ? 18 : kind === 'grid' ? 28 : 126;
		let height = kind === 'triangles' ? 45 : width;
		if (kind === 'local') { width = tileWidth; height = tileHeight; }
		source.width = Math.max(1, Math.round(width * scale));
		source.height = Math.max(1, Math.round(height * scale));
		const c = source.getContext('2d');
		if (!c) return null;
		c.scale(source.width / width, source.height / height);
		c.strokeStyle = 'rgba(255,255,255,.24)';
		c.fillStyle = 'rgba(255,255,255,.55)';
		if (kind === 'local' && image) c.drawImage(image, 0, 0, width, height);
		else if (kind === 'triangles') {
			c.beginPath(); c.moveTo(26, 4); c.lineTo(48, 41); c.lineTo(4, 41); c.closePath(); c.stroke();
		} else if (kind === 'dots') {
			c.beginPath(); c.arc(9, 9, 1, 0, Math.PI * 2); c.fill();
		} else if (kind === 'grid') {
			c.beginPath(); c.moveTo(.5, 28); c.lineTo(.5, .5); c.lineTo(28, .5); c.stroke();
		} else if (kind === 'sparkles') {
			for (const [x, y, r] of [[9, 14, 1], [44, 41, 1], [35, 67, .8], [77, 20, .8], [100, 98, 1], [14, 106, .8], [114, 50, .8]]) {
				c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
			}
		}
		tile = ctx.createPattern(source, 'repeat');
		return tile;
	}

	export function clear(): void { if (canvas) canvas.style.display = 'none'; }

	export function draw(now: number): boolean {
		if (!ctx || !mask || !options.enabled || options.pattern === 'none' || options.textureOpacity <= 0) { clear(); return false; }
		const lifetime = Math.max(options.idleDelayMs + options.fadeMs, options.trailMs);
		if (!trail.read(now, lifetime, points)) { clear(); return false; }
		const headAge = Math.max(0, now - trail.current.t);
		const headAlpha = Math.max(0, 1 - Math.max(0, headAge - options.idleDelayMs) / options.fadeMs);
		const bounds = pointerTrailBounds(options.trailMs > 0 && options.trailStrength > 0 ? points : [trail.current], options.radius);
		const dpr = Math.min(window.devicePixelRatio || 1, 1.25, 1024 / Math.max(bounds.width, bounds.height));
		const w = Math.max(1, Math.round(bounds.width * dpr)), h = Math.max(1, Math.round(bounds.height * dpr));
		if (canvas.width !== w || canvas.height !== h) { canvas.width = mask.width = w; canvas.height = mask.height = h; }
		canvas.style.cssText = `display:block;width:${bounds.width}px;height:${bounds.height}px;transform:translate3d(${bounds.left}px,${bounds.top}px,0);opacity:${options.textureOpacity}`;
		ctx.setTransform(dpr, 0, 0, dpr, -bounds.left * dpr, -bounds.top * dpr);
		ctx.globalCompositeOperation = 'source-over';
		ctx.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
		if (isLittleWorldPattern(options.pattern)) {
			const step = 66 * options.patternScale;
			const key = `${options.pattern}:${options.seed}:${step}:${Math.floor(bounds.left / step)}:${Math.floor(bounds.top / step)}:${Math.ceil((bounds.left + bounds.width) / step)}:${Math.ceil((bounds.top + bounds.height) / step)}`;
			if (key !== scatterKey) { scatterKey = key; items = generateScatter(options.pattern, options.seed, options.patternScale, bounds); }
			ctx.strokeStyle = 'rgba(235,243,255,.85)'; ctx.lineWidth = 1.3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
			for (const item of items) {
				let path = paths.get(item.motif);
				if (!path) { path = new Path2D(SCATTER_MOTIFS[item.motif]); paths.set(item.motif, path); }
				ctx.save(); ctx.translate(item.x, item.y); ctx.rotate(item.rotation); ctx.scale(item.scale, item.scale); ctx.stroke(path); ctx.restore();
			}
		} else {
			const fill = pattern();
			if (fill) { ctx.fillStyle = fill; ctx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height); }
		}
		const m = mask.getContext('2d');
		if (!m) { clear(); return false; }
		m.setTransform(dpr, 0, 0, dpr, -bounds.left * dpr, -bounds.top * dpr);
		m.clearRect(bounds.left, bounds.top, bounds.width, bounds.height);
		for (const point of points) {
			const isHead = point === trail.current;
			const fade = isHead ? headAlpha : options.trailStrength * Math.max(0, 1 - Math.max(0, now - point.t) / Math.max(1, options.trailMs)) ** 2;
			if (fade <= 0 || (!isHead && options.trailMs <= 0)) continue;
			const radius = options.radius * (isHead ? 1 : .75);
			const gradient = m.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
			gradient.addColorStop(0, `rgba(255,255,255,${fade})`);
			gradient.addColorStop(.42, `rgba(255,255,255,${fade * .7})`);
			gradient.addColorStop(.86, 'transparent');
			m.fillStyle = gradient; m.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0);
		ctx.globalCompositeOperation = 'source-over';
		return true;
	}
</script>

<canvas class="pointer-pattern-surface" bind:this={canvas} aria-hidden="true"></canvas>

<style>
	canvas { position: fixed; left: 0; top: 0; display: none; pointer-events: none; mix-blend-mode: screen; }
</style>
