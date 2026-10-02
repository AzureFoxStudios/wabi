import { generatePointerField } from './pointerFields';
import { pointerTrailBounds, type PointerBounds, type PointerSample, type PointerTrail } from './pointerTrail';
import { POINTER_MATERIAL_VERTEX, WATER_POINTER_SHADER, SAND_POINTER_SHADER, isPointerFieldPattern, pointerTrailLifetime, pointerHistoryLifetime, pointerHeadOpacity, resolvePointerWorldOptions, type PointerWorldOptions, type ResolvedPointerWorldOptions } from './pointerWorlds';
/** Bounded screen-space renderer. No event listeners or RAF: the host owns the clock.
 * At most 1024 x 1024 backing pixels. Old distant tail samples are culled explicitly.
 * Fields cache their geometry; only masks and material pixels change with motion. */
export class PointerWorldRenderer {
    target: HTMLElement;
    onError: (message: string) => void;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D | null = null;
    gl: WebGLRenderingContext | null = null;
    program: WebGLProgram | null = null;
    buffer: WebGLBuffer | null = null;
    locations = new Map<string, WebGLUniformLocation | null>();
    options: ResolvedPointerWorldOptions;
    fieldKey = '';
    basePattern: CanvasPattern | null = null;
    hotPattern: CanvasPattern | null = null;
    mask = document.createElement('canvas');
    points: PointerSample[] = [];
    uniforms = new Float32Array(48);
    accent = [0.55, 0.8, 0.85];
    inkColor = 'rgb(210,230,235)';
    lost = false;
    disposed = false;
    frameCount = 0;
    layoutCount = 0;
    usingFallback = false;
    constructor(target: HTMLElement, options: PointerWorldOptions, onError: (message: string) => void = () => { }) {
        this.target = target;
        this.onError = onError;
        this.options = resolvePointerWorldOptions(options);
        this.canvas = document.createElement('canvas');
        this.mountCanvas();
        try { this.prepare(); }
        catch (error) { this.destroy(); throw error; }
    }
    mountCanvas() {
        this.canvas.setAttribute('aria-hidden', 'true');
        this.canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;display:none;';
        this.target.append(this.canvas);
    }
    get diagnostics() {
        return { frames: this.frameCount, layouts: this.layoutCount,
            pixels: this.canvas.width * this.canvas.height, samples: this.points.length,
            backend: this.gl ? 'webgl' : 'canvas2d', fallback: this.usingFallback };
    }
    refreshColors() {
        const style = getComputedStyle(document.documentElement);
        const color = style.getPropertyValue('--accent-primary-color').trim() ||
            style.getPropertyValue('--accent-primary').trim() || '#8cccd9';
        // Resolve modern CSS colors/variables through a scratch 2D pixel, outside the frame loop.
        const scratch = document.createElement('canvas');
        scratch.width = scratch.height = 1;
        const ctx = scratch.getContext('2d', { willReadFrequently: true });
        if (ctx) {
            ctx.fillStyle = '#8cccd9';
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const rgb = ctx.getImageData(0, 0, 1, 1).data;
            this.accent = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
        }
        this.inkColor = style.getPropertyValue('--text-heading').trim() || 'rgb(210,230,235)';
    }
    configure(options: PointerWorldOptions) {
        if (this.disposed)
            return;
        const changed = this.options.pattern !== options.pattern;
        this.options = resolvePointerWorldOptions(options);
        if (changed) {
            this.releaseGL();
            this.basePattern = this.hotPattern = null;
            this.mask.width = this.mask.height = this.fieldPass.width = this.fieldPass.height = 1;
            this.canvas.remove();
            this.canvas = document.createElement('canvas');
            this.mountCanvas();
            this.context = null;
            this.fieldKey = '';
            this.prepare();
        }
        else if (this.context && !this.usingFallback)
            this.prepareField();
    }
    prepare() {
        this.lost = false;
        this.usingFallback = false;
        this.refreshColors();
        if (this.options.pattern === 'water' || this.options.pattern === 'sand') {
            try {
                this.prepareMaterial();
                return;
            }
            catch (error) {
                this.releaseGL();
                this.canvas.remove();
                this.canvas = document.createElement('canvas');
                this.mountCanvas();
                this.usingFallback = true;
                this.onError((error instanceof Error ? error.message : 'WebGL unavailable') + '. Using a lightweight 2D wake.');
            }
        }
        this.context = this.canvas.getContext('2d');
        if (!this.context)
            throw new Error('Canvas drawing is unavailable');
        if (!this.usingFallback)
            this.prepareField();
    }
    prepareField() {
        if (!this.context)
            return;
        const o = this.options;
        if (!isPointerFieldPattern(o.pattern)) return;
        const key = [o.pattern, o.seed, o.fieldDensity, o.mazeCurve, o.patternScale].join(':');
        if (key === this.fieldKey)
            return;
        const field = generatePointerField(o.pattern, o.seed, o.fieldDensity, o.mazeCurve);
        const makeTile = (hot: boolean) => {
            const tile = document.createElement('canvas');
            tile.width = field.width;
            tile.height = field.height;
            const ctx = tile.getContext('2d');
            if (!ctx) throw new Error('Canvas drawing is unavailable');
            ctx.strokeStyle = 'white';
            ctx.lineCap = ctx.lineJoin = 'round';
            ctx.lineWidth = hot ? 1.7 : 1.2;
            if (o.pattern === 'climb-route')
                ctx.setLineDash([3, 5]);
            if (!hot || o.pattern !== 'maze')
                ctx.stroke(new Path2D(field.ink));
            ctx.setLineDash([]);
            if (hot || o.pattern !== 'maze')
                ctx.stroke(new Path2D(field.fineInk));
            const pattern = this.context!.createPattern(tile, 'repeat');
            pattern?.setTransform(new DOMMatrix().scale(o.patternScale));
            return pattern;
        };
        this.basePattern = makeTile(false);
        this.hotPattern = makeTile(true);
        this.fieldKey = key;
        this.layoutCount++;
    }
    onContextLost = (event: Event) => {
        event.preventDefault();
        if (this.disposed)
            return;
        this.lost = true;
        this.clear();
        this.onError('Graphics context lost. Waiting for recovery.');
    };
    onContextRestored = () => {
        if (this.disposed) return;
        // Old GPU objects are invalid after loss. Rebuild once, then let the host's next input draw.
        this.releaseGL(false);
        try {
            this.prepareMaterial();
            this.lost = false;
            this.onError('');
        } catch (error) {
            this.useFallback(error);
        }
    };
    useFallback(error: unknown) {
        this.releaseGL();
        this.canvas.remove();
        this.canvas = document.createElement('canvas');
        this.mountCanvas();
        this.context = this.canvas.getContext('2d');
        this.lost = false;
        this.usingFallback = true;
        this.onError((error instanceof Error ? error.message : 'WebGL unavailable') + '. Using a lightweight 2D wake.');
    }
    prepareMaterial() {
        const gl = this.canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power' });
        if (!gl)
            throw new Error('WebGL is unavailable');
        this.gl = gl;
        this.canvas.addEventListener('webglcontextlost', this.onContextLost);
        this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
        // Queries happen at setup, never per frame. Link errors still report the actual hardware limit.
        if (gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) < 28)
            throw new Error('Not enough shader uniforms');
        const shaders: WebGLShader[] = [];
        try {
            for (const [type, source] of [[gl.VERTEX_SHADER, POINTER_MATERIAL_VERTEX],
                [gl.FRAGMENT_SHADER, this.options.pattern === 'sand' ? SAND_POINTER_SHADER : WATER_POINTER_SHADER]] as const) {
                const shader = gl.createShader(type);
                if (!shader)
                    throw new Error('Shader allocation failed');
                shaders.push(shader);
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                    throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed');
            }
            this.program = gl.createProgram();
            if (!this.program)
                throw new Error('Program allocation failed');
            for (const shader of shaders)
                gl.attachShader(this.program, shader);
            gl.linkProgram(this.program);
            if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(this.program) || 'Shader link failed');
            this.buffer = gl.createBuffer();
            if (!this.buffer)
                throw new Error('Geometry allocation failed');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            gl.useProgram(this.program);
            const position = gl.getAttribLocation(this.program, 'a_position');
            if (position >= 0) {
                gl.enableVertexAttribArray(position);
                gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
            }
            for (const name of ['u_resolution', 'u_origin', 'u_scale', 'u_lifetime', 'u_radius', 'u_response', 'u_detail', 'u_seed', 'u_strength', 'u_trail_strength', 'u_head_alpha', 'u_accent', 'u_time', 'u_trail_count', 'u_trail[0]'])
                this.locations.set(name, gl.getUniformLocation(this.program, name));
        }
        finally {
            for (const shader of shaders)
                gl.deleteShader(shader);
        }
    }
    draw(trail: PointerTrail, now: number): boolean {
        if (this.disposed || this.lost || !Number.isFinite(now)) return false;
        if (this.options.textureOpacity === 0) { this.clear(); return false; }
        // A frame timestamp can precede a just-delivered input event. Never clear
        // a fresh stroke or compute negative ages on that account.
        now = Math.max(now, trail.current.t);
        const lifetime = pointerTrailLifetime(this.options);
        if (!trail.read(now, lifetime, this.points)) {
            this.clear();
            return false;
        }
        const historyLifetime = pointerHistoryLifetime(this.options);
        const headAlpha = pointerHeadOpacity(now - trail.current.t, this.options);
        // Keep the head last even once transparent: shaders identify it by index.
        let kept = 0;
        for (const point of this.points) {
            if (point === trail.current || (this.options.trailStrength > 0 && now - point.t < historyLifetime))
                this.points[kept++] = point;
        }
        this.points.length = kept;
        if (headAlpha === 0 && this.points.length === 1) { this.clear(); return false; }
        const bounds = pointerTrailBounds(this.points, this.options.radius);
        const dpr = Math.min(window.devicePixelRatio || 1, 1.25, 1024 / Math.max(bounds.width, bounds.height));
        const w = Math.round(bounds.width * dpr), h = Math.round(bounds.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.canvas.style.width = `${bounds.width}px`;
        this.canvas.style.height = `${bounds.height}px`;
        this.canvas.style.transform = `translate3d(${bounds.left}px,${bounds.top}px,0)`;
        this.canvas.style.display = 'block';
        if (this.gl)
            this.drawMaterial(bounds, dpr, now, historyLifetime);
        else if (this.usingFallback)
            this.drawFallback(bounds, dpr, now, historyLifetime);
        else
            this.drawField(bounds, dpr, now, historyLifetime);
        this.frameCount++;
        return true;
    }
    drawMaterial(b: PointerBounds, dpr: number, now: number, lifetime: number) {
        const gl = this.gl!, o = this.options, location = (key: string) => this.locations.get(key) ?? null;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(location('u_resolution'), this.canvas.width, this.canvas.height);
        gl.uniform2f(location('u_origin'), b.left, b.top);
        gl.uniform1f(location('u_scale'), dpr);
        gl.uniform1f(location('u_lifetime'), Math.max(1, lifetime) / 1000);
        gl.uniform1f(location('u_head_alpha'), pointerHeadOpacity(now - this.points[this.points.length - 1].t, o));
        gl.uniform1f(location('u_radius'), o.radius);
        gl.uniform1f(location('u_response'), o.response);
        gl.uniform1f(location('u_detail'), o.materialDetail / o.patternScale);
        gl.uniform1f(location('u_seed'), o.seed % 4096);
        gl.uniform1f(location('u_strength'), o.textureOpacity);
        gl.uniform1f(location('u_trail_strength'), o.trailStrength);
        gl.uniform3fv(location('u_accent'), this.accent);
        gl.uniform1f(location('u_time'), (now / 1000) % 600);
        this.uniforms.fill(0);
        let count = 0;
        for (let i = b.first; i < this.points.length; i++) {
            const p = this.points[i];
            this.uniforms[count * 4] = p.x;
            this.uniforms[count * 4 + 1] = p.y;
            this.uniforms[count * 4 + 2] = Math.max(0, now - p.t) / 1000;
            this.uniforms[count * 4 + 3] = p.breakBefore ? -(1 + p.speed) : p.speed;
            count++;
        }
        gl.uniform1i(location('u_trail_count'), count);
        gl.uniform4fv(location('u_trail[0]'), this.uniforms);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    drawMask(b: PointerBounds, dpr: number, now: number, lifetime: number, hot: boolean) {
        if (this.mask.width !== this.canvas.width || this.mask.height !== this.canvas.height) {
            this.mask.width = this.canvas.width;
            this.mask.height = this.canvas.height;
        }
        const ctx = this.mask.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.mask.width, this.mask.height);
        ctx.setTransform(dpr, 0, 0, dpr, -b.left * dpr, -b.top * dpr);
        const radius = hot ? Math.min(45, this.options.radius * .22) : this.options.radius;
        const stamp = (x: number, y: number, alpha: number) => {
            const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
            g.addColorStop(0, `rgba(255,255,255,${alpha})`);
            g.addColorStop(.35, `rgba(255,255,255,${alpha * .65})`);
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        };
        for (let i = b.first; i < this.points.length; i++) {
            const p = this.points[i];
            const fade = i === this.points.length - 1 ? pointerHeadOpacity(now - p.t, this.options)
                : this.options.trailStrength * Math.pow(Math.max(0, 1 - (now - p.t) / Math.max(1, lifetime)), 2);
            stamp(p.x, p.y, fade * (hot ? .72 : .55));
            if (i > b.first && !p.breakBefore) {
                const a = this.points[i - 1], n = Math.min(8, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / Math.max(10, radius * .6)));
                for (let j = 1; j < n; j++) {
                    const t = j / n, f = Math.pow(Math.max(0, 1 - (now - (a.t + (p.t - a.t) * t)) / Math.max(1, lifetime)), 2);
                    stamp(a.x + (p.x - a.x) * t, a.y + (p.y - a.y) * t, f * (hot ? .5 : .275) * this.options.trailStrength);
                }
            }
        }
    }
    drawField(b: PointerBounds, dpr: number, now: number, lifetime: number) {
        const ctx = this.context, o = this.options;
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        // Apply masks to separate reusable scratch content so the highlight pass cannot erase the base pass.
        this.paintFieldPass(ctx, this.basePattern, b, dpr, now, lifetime, false, o.textureOpacity * .85);
        this.paintFieldPass(ctx, this.hotPattern, b, dpr, now, lifetime, true, o.textureOpacity * 1.4 * o.response);
        ctx.globalAlpha = 1;
    }
    fieldPass = document.createElement('canvas');
    paintFieldPass(destination: CanvasRenderingContext2D, pattern: CanvasPattern | null, b: PointerBounds, dpr: number, now: number, lifetime: number, hot: boolean, alpha: number) {
        if (!pattern)
            return;
        if (this.fieldPass.width !== this.canvas.width || this.fieldPass.height !== this.canvas.height) {
            this.fieldPass.width = this.canvas.width;
            this.fieldPass.height = this.canvas.height;
        }
        const ctx = this.fieldPass.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, -b.left * dpr, -b.top * dpr);
        ctx.fillStyle = pattern;
        ctx.fillRect(b.left, b.top, b.width, b.height);
        this.drawMask(b, dpr, now, lifetime, hot);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(this.mask, 0, 0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = this.inkColor;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        destination.globalAlpha = Math.max(0, Math.min(1, alpha));
        destination.drawImage(this.fieldPass, 0, 0);
    }
    drawFallback(b: PointerBounds, dpr: number, now: number, lifetime: number) {
        const ctx = this.context, o = this.options;
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, -b.left * dpr, -b.top * dpr);
        ctx.lineCap = 'round';
        ctx.strokeStyle = this.inkColor;
        for (let i = b.first; i < this.points.length; i++) {
            const p = this.points[i], age = now - p.t;
            const f = i === this.points.length - 1 ? pointerHeadOpacity(age, o)
                : o.trailStrength * Math.pow(Math.max(0, 1 - age / Math.max(1, lifetime)), 2);
            // Preserve a soft material reveal when response is zero, as the shaders do.
            const reveal = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, o.radius);
            reveal.addColorStop(0, 'rgba(210,230,235,.12)');
            reveal.addColorStop(1, 'rgba(210,230,235,0)');
            ctx.fillStyle = reveal;
            ctx.globalAlpha = o.textureOpacity * f;
            ctx.fillRect(p.x - o.radius, p.y - o.radius, o.radius * 2, o.radius * 2);
            ctx.globalAlpha = o.textureOpacity * f * .7 * o.response;
            if (o.pattern === 'water') {
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                const ringRadius = 5 + age * .11;
                ctx.globalAlpha *= Math.max(0, Math.min(1, (o.radius - ringRadius) / Math.max(1, o.radius * .25)));
                ctx.arc(p.x, p.y, ringRadius, 0, Math.PI * 2);
                ctx.stroke();
            }
            else if (i > b.first && !p.breakBefore) {
                const a = this.points[i - 1];
                ctx.lineWidth = 8;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
            } else {
                ctx.fillStyle = this.inkColor;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }
    clear() { this.canvas.style.display = 'none'; }
    releaseGL(loseContext = true) {
        if (!this.gl)
            return;
        this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
        if (this.buffer)
            this.gl.deleteBuffer(this.buffer);
        if (this.program)
            this.gl.deleteProgram(this.program);
        if (loseContext) this.gl.getExtension('WEBGL_lose_context')?.loseContext();
        this.gl = null;
        this.program = null;
        this.buffer = null;
        this.locations.clear();
    }
    destroy() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.releaseGL();
        this.canvas.remove();
        this.mask.width = this.mask.height = this.fieldPass.width = this.fieldPass.height = 1;
        this.basePattern = this.hotPattern = null;
        this.points.length = 0;
    }
}
