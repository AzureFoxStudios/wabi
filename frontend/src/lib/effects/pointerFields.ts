export type PointerFieldKind = 'lattice' | 'climb-route' | 'arcane-circle' | 'rune-wall' | 'maze';
export interface FieldNode { id: number; x: number; y: number; row?: number; room?: string; }
export interface FieldEdge { a: number; b: number; }
export interface PointerField { width: number; height: number; ink: string; fineInk: string; nodes: FieldNode[]; edges: FieldEdge[]; entrance?: number; exit?: number; }
export function fieldRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let n = Math.imul(state ^ state >>> 15, 1 | state);
        n ^= n + Math.imul(n ^ n >>> 7, 61 | n);
        return ((n ^ n >>> 14) >>> 0) / 4294967296;
    };
}
const fp = (n: number) => String(Math.round(n * 100) / 100);
const moveLine = (x: number, y: number, xx: number, yy: number) => `M${fp(x)} ${fp(y)}L${fp(xx)} ${fp(yy)}`;
function fieldCircle(x: number, y: number, r: number) {
    return `M${fp(x - r)} ${fp(y)}a${fp(r)} ${fp(r)} 0 1 0 ${fp(r * 2)} 0a${fp(r)} ${fp(r)} 0 1 0 ${fp(-r * 2)} 0`;
}
function runePath(x: number, y: number, size: number, glyph: number, angle = 0) {
    // Invented angular script, with a shared stem and varied branches; no font dependency.
    const lines = [[0, -.46, 0, .46], [-.32, -.30, 0, -.46], [0, -.46, .32, -.22]];
    if (glyph & 1)
        lines.push([0, -.1, .32, .12]);
    if (glyph & 2)
        lines.push([-.32, .26, 0, .06]);
    if (glyph & 4)
        lines.push([-.30, .32, .3, .32]);
    if (glyph & 8)
        lines.push([0, .46, .30, .22]);
    if (!(glyph & 3))
        lines.push([-.30, 0, 0, .2], [0, .2, .3, 0]);
    const c = Math.cos(angle), s = Math.sin(angle);
    return lines.map(([a, b, d, e]) => moveLine(x + size * (a * c - b * s), y + size * (a * s + b * c), x + size * (d * c - e * s), y + size * (d * s + e * c))).join('');
}
function roomPath(kind: string, x: number, y: number) {
    if (kind === '?')
        return `M${x - 5} ${y - 4}c0-9 13-9 12 0c-1 5-7 4-7 10` + fieldCircle(x, y + 11, 1);
    if (kind === 'shop')
        return `M${x - 10} ${y - 2}l3-8h14l3 8zM${x - 8} ${y - 2}v13h16v-13M${x - 2} ${y + 11}v-8h5v8`;
    if (kind === 'campfire')
        return `M${x - 8} ${y + 7}Q${x - 12} ${y} ${x + 1} ${y - 12}Q${x - 1} ${y - 2} ${x + 7} ${y - 4}Q${x + 14} ${y + 6} ${x + 2} ${y + 8}Z` + moveLine(x - 11, y + 13, x + 11, y + 10) + moveLine(x - 11, y + 10, x + 11, y + 13);
    if (kind === 'chest')
        return `M${x - 11} ${y - 3}q0-8 8-8h6q8 0 8 8v14h-22zM${x - 11} ${y}h22M${x - 2} ${y - 2}h4v6h-4z`;
    const skull = `M${x - 9} ${y - 6}q9-10 18 0v12l-5 0v5h-8v-5h-5z` + fieldCircle(x - 4, y - 2, 1.6) + fieldCircle(x + 4, y - 2, 1.6);
    return kind === 'elite' ? skull + `M${x - 10} ${y - 9}l-5-8 10 5M${x + 10} ${y - 9}l5-8-10 5` : skull;
}
export function generateLattice(seed: number, density = 1): PointerField {
    const random = fieldRandom(seed), width = 672, height = 672;
    const n = Math.max(5, Math.min(13, Math.round(8 * density))), step = width / n;
    const nodes: FieldNode[] = [], edges: FieldEdge[] = [];
    for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
            nodes.push({ id: y * n + x, x: (x + .18 + (random() - .5) * .48) * step, y: (y + .18 + (random() - .5) * .48) * step });
    let ink = '', fineInk = '';
    for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
            const a = nodes[y * n + x];
            for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) {
                const b = nodes[((y + dy) % n) * n + (x + dx) % n];
                const xx = b.x + (x + dx >= n ? width : 0), yy = b.y + (y + dy >= n ? height : 0);
                edges.push({ a: a.id, b: b.id });
                // Duplicate crossing segments at the opposite tile boundary for seamless tiling.
                for (const ox of [0, -width])
                    for (const oy of [0, -height])
                        ink += moveLine(a.x + ox, a.y + oy, xx + ox, yy + oy);
            }
            fineInk += fieldCircle(a.x, a.y, 2.2);
        }
    return { width, height, ink, fineInk, nodes, edges };
}
export function generateClimbRoute(seed: number, density = 1): PointerField {
    const random = fieldRandom(seed), width = 720, height = 896, levels = 8;
    const nodes: FieldNode[] = [], rows: FieldNode[][] = [], edges: FieldEdge[] = [];
    const rooms = ['?', 'monster', '?', 'shop', 'elite', 'campfire', 'chest'];
    const boundary = [125, 360, 595];
    for (let row = 0; row <= levels; row++) {
        const count = row === 0 || row === levels ? boundary.length : Math.max(2, Math.min(5, Math.round(2 + random() * 2 * density)));
        const items: FieldNode[] = [];
        for (let j = 0; j < count; j++) {
            const edge = row === 0 || row === levels;
            const p = { id: nodes.length, x: edge ? boundary[j] : 75 + (j + .5) * (width - 150) / count + (random() - .5) * 55,
                y: edge ? row * height / levels : row * height / levels + (random() - .5) * 44, row,
                room: edge ? '?' : rooms[Math.floor(random() * rooms.length)] };
            nodes.push(p);
            items.push(p);
        }
        rows.push(items);
    }
    let ink = '', fineInk = '';
    const connect = (a: FieldNode, b: FieldNode) => {
        edges.push({ a: a.id, b: b.id });
        const dy = b.y - a.y, bend = (random() - .5) * 36;
        ink += `M${fp(a.x)} ${fp(a.y + 18)}C${fp(a.x + bend)} ${fp(a.y + dy * .45)} ${fp(b.x - bend)} ${fp(b.y - dy * .45)} ${fp(b.x)} ${fp(b.y - 18)}`;
    };
    // A monotone staircase of links covers *every* room on both sides of each rank.
    // Split/merge naturally when adjacent ranks have different room counts.
    for (let row = 0; row < levels; row++) {
        const lower = rows[row], upper = rows[row + 1];
        let i = 0, j = 0;
        connect(lower[i], upper[j]);
        while (i < lower.length - 1 || j < upper.length - 1) {
            const advanceLower = j === upper.length - 1 || (i < lower.length - 1 && (i + 1) / lower.length < (j + 1) / upper.length);
            if (advanceLower)
                i++;
            else
                j++;
            connect(lower[i], upper[j]);
        }
    }
    for (const node of nodes)
        fineInk += roomPath(node.room || '?', node.x, node.y);
    return { width, height, ink, fineInk, nodes, edges };
}
export function generateArcaneCircle(seed: number, density = 1): PointerField {
    const random = fieldRandom(seed), width = 768, height = 768, c = 384;
    let ink = '', fineInk = '';
    for (const r of [76, 88, 166, 180, 232, 266, 286, 310, 334])
        ink += fieldCircle(c, c, r);
    for (const [r, count] of [[248, 44], [320, Math.round(60 * density)], [108, 20]]) {
        for (let j = 0; j < count; j++) {
            const a = j / count * Math.PI * 2;
            fineInk += runePath(c + Math.cos(a) * r, c + Math.sin(a) * r, 15, Math.floor(random() * 16), a + Math.PI / 2);
        }
    }
    for (let j = 0; j < 12; j++) {
        const a = j / 12 * Math.PI * 2, b = (j + 5) / 12 * Math.PI * 2;
        ink += moveLine(c + Math.cos(a) * 180, c + Math.sin(a) * 180, c + Math.cos(b) * 180, c + Math.sin(b) * 180);
        ink += moveLine(c + Math.cos(a) * 286, c + Math.sin(a) * 286, c + Math.cos(a) * 310, c + Math.sin(a) * 310);
        fineInk += fieldCircle(c + Math.cos(a) * 220, c + Math.sin(a) * 220, 6);
    }
    for (let j = 0; j < 96; j++) {
        const a = j / 96 * Math.PI * 2, r = j % 4 ? 329 : 322;
        ink += moveLine(c + Math.cos(a) * r, c + Math.sin(a) * r, c + Math.cos(a) * 334, c + Math.sin(a) * 334);
    }
    for (const [x, y] of [[0, c], [width, c], [c, 0], [c, height]])
        ink += moveLine(c, c, x, y);
    fineInk += runePath(c, c, 72, 11);
    return { width, height, ink, fineInk, nodes: [], edges: [] };
}
export function generateRuneWall(seed: number, density = 1): PointerField {
    const random = fieldRandom(seed), width = 672, height = 768;
    const columns = Math.round(20 * density), rows = Math.round(22 * density), cellW = width / columns, cellH = height / rows;
    let ink = '', fineInk = '';
    for (let column = 0; column < columns; column++) {
        const x = (column + .5) * cellW;
        if (column % 4 === 0)
            ink += moveLine(column * cellW, 0, column * cellW, height);
        for (let row = 0; row < rows; row++) {
            if (random() < .045)
                continue;
            const y = (row + .5) * cellH + (random() - .5) * 3;
            fineInk += runePath(x, y, Math.min(cellW * .64, cellH * .72), Math.floor(random() * 16));
            if (row % 6 === 5)
                ink += moveLine(x - cellW * .36, y + cellH * .46, x + cellW * .36, y + cellH * .46);
        }
    }
    return { width, height, ink, fineInk, nodes: [], edges: [] };
}
export function generateMaze(seed: number, density = 1, curve = .7): PointerField {
    const random = fieldRandom(seed), columns = Math.max(10, Math.min(28, Math.round(18 * density))), rows = columns;
    const width = 720, height = 720, cell = width / columns;
    const nodes = Array.from({ length: columns * rows }, (_, id) => ({ id, x: (id % columns + .5) * cell, y: (Math.floor(id / columns) + .5) * cell }));
    const edges: FieldEdge[] = [], passages = new Set<string>(), seen = new Set([0]), stack = [0];
    const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
    while (stack.length) {
        const a = stack[stack.length - 1], x = a % columns, y = Math.floor(a / columns);
        const candidates = [x > 0 ? a - 1 : -1, x < columns - 1 ? a + 1 : -1, y > 0 ? a - columns : -1, y < rows - 1 ? a + columns : -1].filter(b => b >= 0 && !seen.has(b));
        if (!candidates.length) {
            stack.pop();
            continue;
        }
        const b = candidates[Math.floor(random() * candidates.length)];
        seen.add(b);
        stack.push(b);
        edges.push({ a, b });
        passages.add(key(a, b));
    }
    // Shared, low-amplitude warp preserves junctions and corridor connectivity.
    const warp = (x: number, y: number) => [x + Math.sin(y / cell * .8) * Math.sin(Math.PI * x / width) * cell * .24 * curve, y + Math.sin(x / cell * .65) * Math.sin(Math.PI * y / height) * cell * .24 * curve];
    const wall = (x: number, y: number, xx: number, yy: number) => {
        let d = '';
        for (let i = 0; i <= 6; i++) {
            const p = warp(x + (xx - x) * i / 6, y + (yy - y) * i / 6);
            d += (i ? 'L' : 'M') + fp(p[0]) + ' ' + fp(p[1]);
        }
        return d;
    };
    let ink = wall(0, 0, width, 0) + wall(width, 0, width, height) + wall(width, height, 0, height) + wall(0, height, 0, 0), fineInk = '';
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < columns; x++) {
            const id = y * columns + x;
            if (x < columns - 1 && !passages.has(key(id, id + 1)))
                ink += wall((x + 1) * cell, y * cell, (x + 1) * cell, (y + 1) * cell);
            if (y < rows - 1 && !passages.has(key(id, id + columns)))
                ink += wall(x * cell, (y + 1) * cell, (x + 1) * cell, (y + 1) * cell);
        }
    for (const edge of edges) {
        const a = nodes[edge.a], b = nodes[edge.b];
        fineInk += wall(a.x, a.y, b.x, b.y);
    }
    // Start/goal markers, not collision controls: moving never steals clicks from Wabi.
    const entrance = 0, exit = nodes.length - 1, a = warp(nodes[entrance].x, nodes[entrance].y), b = warp(nodes[exit].x, nodes[exit].y);
    ink += fieldCircle(a[0], a[1], cell * .18) + fieldCircle(b[0], b[1], cell * .22);
    for (const n of nodes) {
        const p = warp(n.x, n.y);
        n.x = p[0];
        n.y = p[1];
    }
    return { width, height, ink, fineInk, nodes, edges, entrance, exit };
}
export function generatePointerField(kind: PointerFieldKind, seed: number, density = 1, curve = .7): PointerField {
    const d = Math.max(.6, Math.min(1.5, Number.isFinite(density) ? density : 1));
    switch (kind) {
        case 'lattice': return generateLattice(seed, d);
        case 'climb-route': return generateClimbRoute(seed, d);
        case 'arcane-circle': return generateArcaneCircle(seed, d);
        case 'rune-wall': return generateRuneWall(seed, d);
        case 'maze': return generateMaze(seed, d, Math.max(0, Math.min(1, curve)));
    }
}
