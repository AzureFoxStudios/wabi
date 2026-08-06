/**
 * Minimal WebGL1 renderer shared by the shader-based ambient effects.
 *
 * The shader renders into an INTERNAL offscreen WebGL canvas, then gets
 * blitted onto the shared ambient 2D canvas via drawImage. This avoids the
 * canvas context-type lock: a canvas is permanently bound to the first
 * context type requested (2D), so WebGL must never be requested on the
 * shared canvas itself.
 *
 * Falls back cleanly: `ready === false` when WebGL or the shader pipeline is
 * unavailable — callers then render a low-res CPU approximation instead.
 */

export interface WebGLRenderer {
	gl: WebGLRenderingContext | null;
	/** False when WebGL or the shader pipeline is unavailable. */
	ready: boolean;
	/** Binds the program + quad. Returns false when the pipeline is unavailable. */
	use(): boolean;
	uniform(name: string): WebGLUniformLocation | null;
	draw(): void;
	/** Resize the offscreen GL target (resets viewport). */
	setSize(width: number, height: number): void;
	/** Copy the GL frame onto the shared 2D canvas. */
	blit(target: CanvasRenderingContext2D | null, width: number, height: number, dpr: number): void;
	destroy(): void;
}

const VERT_SRC = `
attribute vec2 a_position;
void main() {
	gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string, label: string): WebGLShader | null {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, src);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		// Retry without highp — some drivers don't support it in fragment shaders.
		if (type === gl.FRAGMENT_SHADER) {
			const mediump = src.replace('precision highp float;', 'precision mediump float;');
			if (mediump !== src) {
				const retry = gl.createShader(type);
				if (retry) {
					gl.shaderSource(retry, mediump);
					gl.compileShader(retry);
					if (gl.getShaderParameter(retry, gl.COMPILE_STATUS)) {
						gl.deleteShader(shader);
						return retry;
					}
					gl.deleteShader(retry);
				}
			}
		}
		console.error(`[AmbientShader] ${label} compile failed:`, gl.getShaderInfoLog(shader));
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

export function createWebGLRenderer(fragSrc: string, label = 'shader'): WebGLRenderer {
	const target = document.createElement('canvas');
	target.width = 2;
	target.height = 2;
	const gl = target.getContext('webgl', {
		antialias: false,
		alpha: false,
		depth: false,
		stencil: false,
		powerPreference: 'low-power',
	});
	if (!gl) {
		return {
			gl: null,
			ready: false,
			use: () => false,
			uniform: () => null,
			draw: () => {},
			setSize: () => {},
			blit: () => {},
			destroy: () => {},
		};
	}

	let program: WebGLProgram | null = null;
	let buffer: WebGLBuffer | null = null;
	let attrPos = -1;
	const uniformCache = new Map<string, WebGLUniformLocation | null>();

	const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC, label);
	const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc, label);
	if (vert && frag) {
		const p = gl.createProgram();
		if (p) {
			gl.attachShader(p, vert);
			gl.attachShader(p, frag);
			gl.linkProgram(p);
			if (gl.getProgramParameter(p, gl.LINK_STATUS)) {
				program = p;
				attrPos = gl.getAttribLocation(p, 'a_position');
				buffer = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
				gl.bufferData(
					gl.ARRAY_BUFFER,
					new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
					gl.STATIC_DRAW
				);
			} else {
				console.error(`[AmbientShader] ${label} link failed:`, gl.getProgramInfoLog(p));
				gl.deleteProgram(p);
			}
		}
	}
	if (vert) gl.deleteShader(vert);
	if (frag) gl.deleteShader(frag);

	gl.viewport(0, 0, target.width, target.height);
	gl.clearColor(0, 0, 0, 1);

	return {
		gl,
		get ready() {
			return program !== null;
		},
		use() {
			if (!gl || !program) return false;
			gl.useProgram(program);
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.enableVertexAttribArray(attrPos);
			gl.vertexAttribPointer(attrPos, 2, gl.FLOAT, false, 0, 0);
			return true;
		},
		uniform(name) {
			if (!gl || !program) return null;
			if (uniformCache.has(name)) return uniformCache.get(name) ?? null;
			const loc = gl.getUniformLocation(program, name);
			uniformCache.set(name, loc);
			return loc;
		},
		draw() {
			if (!gl || !program) return;
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		},
		setSize(width, height) {
			if (!gl) return;
			target.width = width;
			target.height = height;
			gl.viewport(0, 0, width, height);
		},
		blit(targetCtx, width, height, dpr) {
			if (!targetCtx) return;
			targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
			targetCtx.imageSmoothingEnabled = false;
			targetCtx.drawImage(target, 0, 0, width, height);
		},
		destroy() {
			if (!gl) return;
			if (buffer) gl.deleteBuffer(buffer);
			if (program) gl.deleteProgram(program);
			buffer = null;
			program = null;
			uniformCache.clear();
			// Release the context immediately so rapid effect switching never
			// accumulates contexts toward the browser's per-page limit.
			const ext = gl.getExtension('WEBGL_lose_context');
			if (ext) ext.loseContext();
		},
	};
}
