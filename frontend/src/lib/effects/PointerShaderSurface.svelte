<script lang="ts">
	import { onMount, untrack } from 'svelte';

	interface TrailSample { x: number; y: number; t: number; speed: number; breakBefore?: boolean }
	interface Props {
		source?: string;
		radius?: number;
		opacity?: number;
		onshadererror?: (message: string) => void;
	}
	let { source = '', radius = 190, opacity = 0.16, onshadererror }: Props = $props();
	let canvas: HTMLCanvasElement;
	let mounted = $state(false);
	let gl: WebGLRenderingContext | null = null;
	let program: WebGLProgram | null = null;
	let buffer: WebGLBuffer | null = null;
	let frame = 0;
	let startedAt = 0;
	let running = false;
	let contextLost = false;
	let viewportX = 0, viewportY = 0, velocityX = 0, velocityY = 0;
	let viewportWidth = 1, viewportHeight = 1;
	let accentColor: [number, number, number] = [0.5, 0.78, 0.76];
	const locations = new Map<string, WebGLUniformLocation | null>();
	const history: TrailSample[] = [];
	const trailUniforms = new Float32Array(48);

	const VERTEX_SHADER = `attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;
	const UNIFORMS = ['u_resolution', 'u_viewport', 'u_pointer', 'u_velocity', 'u_time',
		'u_active', 'u_accent', 'u_trail_count', 'u_trail[0]'];

	function fragmentShader(userSource: string): string {
		return `
precision mediump float;
uniform vec2 u_resolution;
uniform vec2 u_viewport;
uniform vec2 u_pointer;
uniform vec2 u_velocity;
uniform float u_time;
uniform float u_active;
uniform vec3 u_accent;
uniform int u_trail_count;
uniform vec4 u_trail[12];
${userSource}
void main() {
	vec4 color = vec4(0.0);
	mainImage(color, gl_FragCoord.xy);
	float alpha = clamp(color.a, 0.0, 1.0);
	gl_FragColor = vec4(clamp(color.rgb, 0.0, 1.0) * alpha, alpha);
}`;
	}

	function compileShader(type: number, code: string): WebGLShader {
		if (!gl) throw new Error('WebGL is unavailable');
		const shader = gl.createShader(type);
		if (!shader) throw new Error('Could not create shader');
		try {
			gl.shaderSource(shader, code);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				throw new Error(gl.getShaderInfoLog(shader) || 'Shader compile failed');
			}
			return shader;
		} catch (error) {
			gl.deleteShader(shader);
			throw error;
		}
	}

	function stopFrame(): void {
		running = false;
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	}

	function clearProgram(): void {
		stopFrame();
		if (program) gl?.deleteProgram(program);
		if (buffer) gl?.deleteBuffer(buffer);
		program = null;
		buffer = null;
		locations.clear();
		history.length = 0;
	}

	function compileProgram(nextSource: string): void {
		clearProgram();
		if (!gl || contextLost) return;
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (!nextSource.trim()) return;
		let vertex: WebGLShader | null = null;
		let fragment: WebGLShader | null = null;
		let next: WebGLProgram | null = null;
		let nextBuffer: WebGLBuffer | null = null;
		try {
			vertex = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
			fragment = compileShader(gl.FRAGMENT_SHADER, fragmentShader(nextSource));
			next = gl.createProgram();
			if (!next) throw new Error('Could not create WebGL program');
			gl.attachShader(next, vertex);
			gl.attachShader(next, fragment);
			gl.linkProgram(next);
			if (!gl.getProgramParameter(next, gl.LINK_STATUS)) {
				throw new Error(gl.getProgramInfoLog(next) || 'Shader link failed');
			}
			nextBuffer = gl.createBuffer();
			if (!nextBuffer) throw new Error('Could not allocate shader geometry');
			gl.bindBuffer(gl.ARRAY_BUFFER, nextBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
			gl.useProgram(next);
			const position = gl.getAttribLocation(next, 'a_position');
			if (position >= 0) {
				gl.enableVertexAttribArray(position);
				gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
			}
			for (const name of UNIFORMS) locations.set(name, gl.getUniformLocation(next, name));
			program = next;
			buffer = nextBuffer;
			next = null;
			nextBuffer = null;
			startedAt = performance.now();
			accentColor = parseAccent();
			onshadererror?.('');
			// Compilation alone must not activate an idle effect.
		} catch (error) {
			clearProgram();
			onshadererror?.(error instanceof Error ? error.message : 'Shader compile failed');
		} finally {
			if (vertex) gl.deleteShader(vertex);
			if (fragment) gl.deleteShader(fragment);
			if (next) gl.deleteProgram(next);
			if (nextBuffer) gl.deleteBuffer(nextBuffer);
		}
	}

	function parseAccent(): [number, number, number] {
		const style = getComputedStyle(document.documentElement);
		const color = style.getPropertyValue('--accent-primary-color').trim() ||
			style.getPropertyValue('--accent-primary').trim() || '#80c7c2';
		const scratch = document.createElement('canvas');
		scratch.width = scratch.height = 1;
		const ctx = scratch.getContext('2d', { willReadFrequently: true });
		if (!ctx) return [0.5, 0.78, 0.76];
		ctx.fillStyle = '#80c7c2';
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		const rgb = ctx.getImageData(0, 0, 1, 1).data;
		return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
	}

	function resize(nextRadius = radius): void {
		if (!canvas || !gl || contextLost) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
		const diameter = Math.max(1, Math.round(nextRadius * 2));
		const width = Math.max(1, Math.min(1024, Math.round(diameter * dpr)));
		if (canvas.width !== width || canvas.height !== width) {
			canvas.width = width;
			canvas.height = width;
		}
		gl.viewport(0, 0, canvas.width, canvas.height);
		viewportWidth = Math.max(1, window.innerWidth);
		viewportHeight = Math.max(1, window.innerHeight);
		if (running) render(performance.now());
	}

	function render(now: number): void {
		if (!gl || !program || !buffer || contextLost) return;
		const location = (name: string) => locations.get(name) ?? null;
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(program);
		gl.uniform2f(location('u_resolution'), canvas.width, canvas.height);
		gl.uniform2f(location('u_viewport'), viewportWidth, viewportHeight);
		gl.uniform2f(location('u_pointer'), viewportX, viewportHeight - viewportY);
		gl.uniform2f(location('u_velocity'), velocityX, -velocityY);
		gl.uniform1f(location('u_time'), Math.max(0, now - startedAt) / 1000);
		gl.uniform1f(location('u_active'), running ? 1 : 0);
		gl.uniform3fv(location('u_accent'), accentColor);
		trailUniforms.fill(0);
		for (let i = 0; i < history.length; i++) {
			const point = history[i];
			trailUniforms[i * 4] = point.x;
			trailUniforms[i * 4 + 1] = viewportHeight - point.y;
			trailUniforms[i * 4 + 2] = Math.max(0, now - point.t) / 1000;
			trailUniforms[i * 4 + 3] = point.breakBefore ? -(1 + point.speed) : point.speed;
		}
		gl.uniform1i(location('u_trail_count'), history.length);
		gl.uniform4fv(location('u_trail[0]'), trailUniforms);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function loop(): void {
		frame = 0;
		if (!running || !program || contextLost) return;
		render(performance.now());
		frame = requestAnimationFrame(loop);
	}

	export function setPointerState(x: number, y: number, vx: number, vy: number, trail: readonly TrailSample[] = []): void {
		if (!mounted || !gl || !program || contextLost || ![x, y, vx, vy].every(Number.isFinite)) return;
		viewportX = x; viewportY = y; velocityX = vx; velocityY = vy;
		history.length = 0;
		for (const point of trail.slice(-12)) history.push({ ...point });
		if (!running) accentColor = parseAccent();
		running = true;
		// Input is drawn immediately; RAF only advances an already active shader.
		render(performance.now());
		if (!frame) frame = requestAnimationFrame(loop);
	}

	export function pause(): void {
		stopFrame();
		// Keep the last visible pixels for the host's CSS fade. Rendering with
		// u_active=0 here would erase shaders that make inactive pixels transparent.
	}

	function onContextLost(event: Event): void {
		event.preventDefault();
		contextLost = true;
		clearProgram();
		onshadererror?.('Graphics context lost. Select another effect and return to retry.');
	}

	onMount(() => {
		gl = canvas.getContext('webgl', {
			alpha: true, antialias: false, depth: false, stencil: false,
			premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power'
		});
		mounted = true;
		if (!gl) onshadererror?.('WebGL is unavailable on this device');
		const onResize = () => resize();
		canvas.addEventListener('webglcontextlost', onContextLost);
		window.addEventListener('resize', onResize, { passive: true });
		return () => {
			mounted = false;
			window.removeEventListener('resize', onResize);
			canvas.removeEventListener('webglcontextlost', onContextLost);
			clearProgram();
			gl?.getExtension('WEBGL_lose_context')?.loseContext();
			gl = null;
		};
	});

	$effect(() => {
		if (mounted) {
			const nextSource = source;
			untrack(() => compileProgram(nextSource));
		}
	});
	$effect(() => {
		if (mounted) {
			const nextRadius = radius;
			untrack(() => resize(nextRadius));
		}
	});
</script>

<canvas bind:this={canvas} aria-hidden="true" style:opacity></canvas>

<style>
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		mix-blend-mode: screen;
		-webkit-mask-image: radial-gradient(circle at 50% 50%, #000 0%, rgb(0 0 0 / 0.72) 48%, transparent 86%);
		mask-image: radial-gradient(circle at 50% 50%, #000 0%, rgb(0 0 0 / 0.72) 48%, transparent 86%);
	}
</style>
