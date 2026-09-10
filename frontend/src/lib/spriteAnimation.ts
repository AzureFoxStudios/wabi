export interface SpriteAnimationConfig {
	/** Number of playable frames in the sheet. */
	frameCount: number;
	/** Number of frame columns in the sheet. Defaults to frameCount (horizontal strip). */
	columns?: number;
	/** Playback rate in frames per second. */
	fps?: number;
	/** Loop after the last frame. Defaults to true. */
	loop?: boolean;
}

export interface NormalizedSpriteAnimationConfig {
	frameCount: number;
	columns: number;
	rows: number;
	fps: number;
	loop: boolean;
}

export interface SpriteFramePosition {
	column: number;
	row: number;
	backgroundSizeX: number;
	backgroundSizeY: number;
	backgroundPositionX: number;
	backgroundPositionY: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
	return Math.max(1, Math.floor(value));
}

export function normalizeSpriteAnimation(config: SpriteAnimationConfig): NormalizedSpriteAnimationConfig {
	const frameCount = positiveInteger(config.frameCount, 1);
	const columns = Math.min(positiveInteger(config.columns, frameCount), frameCount);
	const rows = Math.ceil(frameCount / columns);
	const fps = Math.min(60, positiveInteger(config.fps, 8));

	return {
		frameCount,
		columns,
		rows,
		fps,
		loop: config.loop ?? true
	};
}

/**
 * Resolve a logical frame to CSS background sizing/positioning percentages.
 * The percentages use CSS background-position semantics, where 100% aligns
 * the far edge of the sprite sheet with the far edge of the viewport.
 */
export function getSpriteFramePosition(
	frame: number,
	config: NormalizedSpriteAnimationConfig
): SpriteFramePosition {
	const safeFrame = Math.min(Math.max(0, Math.floor(frame)), config.frameCount - 1);
	const column = safeFrame % config.columns;
	const row = Math.floor(safeFrame / config.columns);

	return {
		column,
		row,
		backgroundSizeX: config.columns * 100,
		backgroundSizeY: config.rows * 100,
		backgroundPositionX: config.columns <= 1 ? 0 : (column / (config.columns - 1)) * 100,
		backgroundPositionY: config.rows <= 1 ? 0 : (row / (config.rows - 1)) * 100
	};
}

export function getNextSpriteFrame(
	currentFrame: number,
	config: NormalizedSpriteAnimationConfig
): number {
	const current = Math.min(Math.max(0, Math.floor(currentFrame)), config.frameCount - 1);
	if (current < config.frameCount - 1) return current + 1;
	return config.loop ? 0 : current;
}
