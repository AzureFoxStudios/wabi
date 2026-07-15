export interface EffectConfig {
	color: string;
	intensity: number;
	size: number;
	speed: number;
	[key: string]: unknown;
}

export interface AmbientEffect {
	id: string;
	name: string;
	description: string;
	init(canvas: HTMLCanvasElement, config: EffectConfig): void;
	render(deltaTime: number, config: EffectConfig): void;
	resize(width: number, height: number): void;
	destroy(): void;
	defaultConfig: EffectConfig;
}
