export interface EffectConfig {
	color: string;
	/** Secondary color for effects that blend multiple colors (e.g. Joker). */
	color2?: string;
	/** Tertiary color for effects that blend multiple colors (e.g. Joker). */
	color3?: string;
	intensity: number;
	size: number;
	speed: number;
	[key: string]: unknown;
}

export interface AmbientEffect {
	id: string;
	name: string;
	description: string;
	/** True when the effect primarily renders through WebGL. */
	usesWebGL?: boolean;
	/**
	 * Optional minimum interval between rendered frames. Effects that can use
	 * GPU acceleration may lower this after init; CPU-heavy fallbacks can keep
	 * the host's conservative default cadence.
	 */
	frameIntervalMs?: number;
	init(canvas: HTMLCanvasElement, config: EffectConfig): void;
	render(deltaTime: number, config: EffectConfig): void;
	resize(width: number, height: number): void;
	destroy(): void;
	defaultConfig: EffectConfig;
}
