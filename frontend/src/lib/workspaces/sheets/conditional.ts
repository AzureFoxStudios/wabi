/**
 * Conditional formatting: a rule colours the cells of a range whose value meets a
 * condition. Rules are shared by everyone on the sheet, stored by stable row and
 * column ids (so they follow the cells when rows or columns move), and evaluated
 * only for display - they never change a cell's value.
 */
export type CfOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'contains' | 'notcontains' | 'begins' | 'ends' | 'empty' | 'notempty' | 'error';

export interface CfRule {
    id: string;
    r0: string; c0: string; r1: string; c1: string;
    op: CfOp;
    a?: string; b?: string;
    fill?: string; color?: string; bold?: boolean;
    order: number;
}

export const CF_OPS: { op: CfOp; label: string; args: 0 | 1 | 2; numeric?: boolean }[] = [
    { op: 'gt', label: 'is greater than', args: 1, numeric: true },
    { op: 'gte', label: 'is greater than or equal to', args: 1, numeric: true },
    { op: 'lt', label: 'is less than', args: 1, numeric: true },
    { op: 'lte', label: 'is less than or equal to', args: 1, numeric: true },
    { op: 'eq', label: 'is equal to', args: 1 },
    { op: 'neq', label: 'is not equal to', args: 1 },
    { op: 'between', label: 'is between', args: 2, numeric: true },
    { op: 'contains', label: 'contains text', args: 1 },
    { op: 'notcontains', label: 'does not contain text', args: 1 },
    { op: 'begins', label: 'starts with', args: 1 },
    { op: 'ends', label: 'ends with', args: 1 },
    { op: 'empty', label: 'is empty', args: 0 },
    { op: 'notempty', label: 'is not empty', args: 0 },
    { op: 'error', label: 'is an error', args: 0 },
];

export const CF_MAX_RULES = 50;
const HEX = /^#[0-9a-f]{6}$/i;

const asNumber = (text: string | undefined): number | null => {
    if (text === undefined || text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
};

/** Throws a readable message when a rule could not be stored or evaluated safely. */
export function validateCfRule(rule: Pick<CfRule, 'op' | 'a' | 'b' | 'fill' | 'color' | 'bold'>): void {
    const spec = CF_OPS.find(item => item.op === rule.op);
    if (!spec) throw new Error('Choose a condition.');
    if (spec.args >= 1 && (rule.a === undefined || rule.a === '' || rule.a.length > 200)) throw new Error('Enter a value for the condition.');
    if (spec.args === 2 && (rule.b === undefined || rule.b === '' || rule.b.length > 200)) throw new Error('Enter both values for a between rule.');
    if (spec.numeric && (asNumber(rule.a) === null || (spec.args === 2 && asNumber(rule.b) === null))) throw new Error('This condition compares numbers - enter numeric values.');
    if (rule.fill && !HEX.test(rule.fill)) throw new Error('Use a six-digit hexadecimal fill color.');
    if (rule.color && !HEX.test(rule.color)) throw new Error('Use a six-digit hexadecimal text color.');
    if (!rule.fill && !rule.color && !rule.bold) throw new Error('Pick a fill color, a text color or bold for matching cells.');
}

/** Does `value` (a cell's calculated value) satisfy the rule? `error` marks a formula error. */
export function cfMatches(rule: Pick<CfRule, 'op' | 'a' | 'b'>, value: unknown, error = false): boolean {
    if (rule.op === 'error') return error;
    if (error) return false;
    const blank = value === null || value === undefined || value === '';
    if (rule.op === 'empty') return blank;
    if (rule.op === 'notempty') return !blank;
    const text = blank ? '' : String(value).toLowerCase(), needle = (rule.a ?? '').toLowerCase();
    switch (rule.op) {
        case 'contains': return needle !== '' && text.includes(needle);
        case 'notcontains': return needle !== '' && !text.includes(needle);
        case 'begins': return needle !== '' && text.startsWith(needle);
        case 'ends': return needle !== '' && text.endsWith(needle);
        case 'eq': case 'neq': {
            const a = asNumber(rule.a), same = typeof value === 'number' && a !== null ? value === a : text === needle;
            return rule.op === 'eq' ? same : !same;
        }
        default: {
            if (typeof value !== 'number' || !Number.isFinite(value)) return false;
            const a = asNumber(rule.a), b = asNumber(rule.b);
            if (a === null) return false;
            switch (rule.op) {
                case 'gt': return value > a;
                case 'gte': return value >= a;
                case 'lt': return value < a;
                case 'lte': return value <= a;
                case 'between': return b !== null && value >= Math.min(a, b) && value <= Math.max(a, b);
            }
            return false;
        }
    }
}

export interface CfResolved { rule: CfRule; r0: number; r1: number; c0: number; c1: number; }
export interface CfStyle { fill?: string; color?: string; bold?: boolean; }

/** Turn id-based ranges into grid positions; rules whose rows or columns were removed are skipped. */
export function cfResolve(rules: CfRule[], rowIndex: Map<string, number>, colIndex: Map<string, number>): CfResolved[] {
    const out: CfResolved[] = [];
    for (const rule of rules) {
        const a = rowIndex.get(rule.r0), b = rowIndex.get(rule.r1), c = colIndex.get(rule.c0), d = colIndex.get(rule.c1);
        if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
        out.push({ rule, r0: Math.min(a, b), r1: Math.max(a, b), c0: Math.min(c, d), c1: Math.max(c, d) });
    }
    return out;
}

/** The first matching rule that sets a property wins that property (rules run in their saved order). */
export function cfStyleAt(resolved: CfResolved[], ri: number, ci: number, value: unknown, error: boolean): CfStyle | undefined {
    let result: CfStyle | undefined;
    for (const item of resolved) {
        if (ri < item.r0 || ri > item.r1 || ci < item.c0 || ci > item.c1) continue;
        if (!cfMatches(item.rule, value, error)) continue;
        result ??= {};
        if (item.rule.fill && result.fill === undefined) result.fill = item.rule.fill;
        if (item.rule.color && result.color === undefined) result.color = item.rule.color;
        if (item.rule.bold && result.bold === undefined) result.bold = true;
    }
    return result;
}

export function cfSummary(rule: Pick<CfRule, 'op' | 'a' | 'b'>): string {
    const spec = CF_OPS.find(item => item.op === rule.op);
    if (!spec) return 'unknown condition';
    return spec.args === 0 ? `cell ${spec.label}` : spec.args === 1 ? `cell ${spec.label} “${rule.a}”` : `cell ${spec.label} ${rule.a} and ${rule.b}`;
}
