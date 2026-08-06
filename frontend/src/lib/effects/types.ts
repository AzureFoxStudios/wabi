export interface EffectConfig {
	color: string;
	/** Secondary color for effects that blend multiple colors (e.g. Balatro). */
	color2?: string;
	/** Tertiary color for effects that blend multiple colors (e.g. Balatro). */
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
	/**
	 * True when the effect renders with WebGL (which locks the canvas to a
	 * WebGL context). The background host must skip its 2D context setup for
	 * these effects.
	 */
	usesWebGL?: boolean;
	init(canvas: HTMLCanvasElement, config: EffectConfig): void;
	render(deltaTime: number, config: EffectConfig): void;
	resize(width: number, height: number): void;
	destroy(): void;
	defaultConfig: EffectConfig;
}
