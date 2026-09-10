<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';

	export let source = '';
	export let radius = 190;
	export let opacity = 0.16;

	const dispatch = createEventDispatcher<{ shadererror: string }>();

	let canvas: HTMLCanvasElement;
	let gl: WebGLRenderingContext | null = null;
	let program: WebGLProgram | null = null;
	let buffer: WebGLBuffer | null = null;
	let frame = 0;
	let startedAt = 0;
	let running = false;
	let compiledSource = '';
	let viewportX = 0;
	let viewportY = 0;
	let velocityX = 0;
	let velocityY = 0;
	let viewportWidth = 1;
	let viewportHeight = 1;

	const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
	gl_Position = vec4(a_position, 0.0, 1.0);
}`;

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

${userSource}

void main() {
	vec4 color = vec4(0.0);
	mainImage(color, gl_FragCoord.xy);
	gl_FragColor = color;
}`;
	}

	function compileShader(type: number, code: string): WebGLShader {
		if (!gl) throw new Error('WebGL is unavailable');
		const shader = gl.createShader(type);
		if (!shader) throw new Error('Could not create shader');
		gl.shaderSource(shader, code);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const message = gl.getShaderInfoLog(shader) || 'Shader compile failed';
			gl.deleteShader(shader);
			throw new Error(message);
		}
		return shader;
	}

	function clearProgram(): void {
		if (!gl) return;
		if (program) gl.deleteProgram(program);
		if (buffer) gl.deleteBuffer(buffer);
		program = null;
		buffer = null;
		compiledSource = '';
	}

	function compileProgram(): void {
		if (!gl || !source.trim()) {
			clearProgram();
			return;
		}
		if (compiledSource === source && program) return;

		clearProgram();
		try {
			const vertex = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
			const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentShader(source));
			const next = gl.createProgram();
			if (!next) throw new Error('Could not create WebGL program');
			gl.attachShader(next, vertex);
			gl.attachShader(next, fragment);
			gl.linkProgram(next);
			gl.deleteShader(vertex);
			gl.deleteShader(fragment);
			if (!gl.getProgramParameter(next, gl.LINK_STATUS)) {
				const message = gl.getProgramInfoLog(next) || 'Shader link failed';
				gl.deleteProgram(next);
				throw new Error(message);
			}

			const nextBuffer = gl.createBuffer();
			if (!nextBuffer) {
				gl.deleteProgram(next);
				throw new Error('Could not allocate shader geometry');
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, nextBuffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
				gl.STATIC_DRAW
			);

			program = next;
			buffer = nextBuffer;
			compiledSource = source;
			startedAt = performance.now();
			render(performance.now());
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Shader compile failed';
			dispatch('shadererror', message);
		}
	}

	function parseAccent(): [number, number, number] {
		const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
		const short = raw.match(/^#([0-9a-f]{3})$/i);
		if (short) {
			return short[1].split('').map((value) => parseInt(value + value, 16) / 255) as [number, number, number];
		}
		const long = raw.match(/^#([0-9a-f]{6})$/i);
		if (long) {
			return [
				parseInt(long[1].slice(0, 2), 16) / 255,
				parseInt(long[1].slice(2, 4), 16) / 255,
				parseInt(long[1].slice(4, 6), 16) / 255
			];
		}
		const rgb = raw.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i);
		if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
		return [0.5, 0.78, 0.76];
	}

	function resize(): void {
		if (!canvas || !gl) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
		const diameter = Math.max(1, Math.round(radius * 2));
		const width = Math.max(1, Math.round(diameter * dpr));
		if (canvas.width !== width || canvas.height !== width) {
			canvas.width = width;
			canvas.height = width;
		}
		gl.viewport(0, 0, canvas.width, canvas.height);
		viewportWidth = Math.max(1, window.innerWidth);
		viewportHeight = Math.max(1, window.innerHeight);
	}

	function uniform2(name: string, x: number, y: number): void {
		if (!gl || !program) return;
		const location = gl.getUniformLocation(program, name);
		if (location) gl.uniform2f(location, x, y);
	}

	function render(now: number): void {
		if (!gl || !program || !buffer) return;
		resize();
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(program);
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

		const position = gl.getAttribLocation(program, 'a_position');
		if (position >= 0) {
			gl.enableVertexAttribArray(position);
			gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
		}

		uniform2('u_resolution', canvas.width, canvas.height);
		uniform2('u_viewport', viewportWidth, viewportHeight);
		uniform2('u_pointer', viewportX, viewportHeight - viewportY);
		uniform2('u_velocity', velocityX, -velocityY);

		const time = gl.getUniformLocation(program, 'u_time');
		if (time) gl.uniform1f(time, Math.max(0, now - startedAt) / 1000);
		const active = gl.getUniformLocation(program, 'u_active');
		if (active) gl.uniform1f(active, running ? 1 : 0);
		const accent = gl.getUniformLocation(program, 'u_accent');
		if (accent) gl.uniform3fv(accent, parseAccent());

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function loop(now: number): void {
		frame = 0;
		if (!running) return;
		render(now);
		frame = requestAnimationFrame(loop);
	}

	export function setPointerState(x: number, y: number, vx: number, vy: number): void {
		viewportX = x;
		viewportY = y;
		velocityX = vx;
		velocityY = vy;
		if (!running) {
			running = true;
			if (!frame) frame = requestAnimationFrame(loop);
		}
	}

	export function pause(): void {
		running = false;
		if (frame) {
			cancelAnimationFrame(frame);
			frame = 0;
		}
		render(performance.now());
	}

	onMount(() => {
		gl = canvas.getContext('webgl', {
			alpha: true,
			antialias: false,
			depth: false,
			stencil: false,
			premultipliedAlpha: true,
			preserveDrawingBuffer: false,
			powerPreference: 'low-power'
		});
		if (!gl) {
			dispatch('shadererror', 'WebGL is unavailable on this device');
			return;
		}
		resize();
		compileProgram();
	});

	$: if (gl && source !== compiledSource) compileProgram();
	$: if (gl && radius) resize();

	onDestroy(() => {
		if (frame) cancelAnimationFrame(frame);
		clearProgram();
		gl = null;
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
