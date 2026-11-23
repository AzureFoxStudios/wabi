import { describe, expect, test } from 'bun:test';
import { cfMatches, cfResolve, cfStyleAt, cfSummary, validateCfRule, type CfRule } from './conditional';

const rule = (patch: Partial<CfRule>): CfRule => ({ id: 'x', r0: 'r1', c0: 'c1', r1: 'r3', c1: 'c1', op: 'gt', a: '10', fill: '#ffc7ce', order: 0, ...patch });

describe('conditional formatting conditions', () => {
    test('numeric comparisons only match numbers', () => {
        expect(cfMatches({ op: 'gt', a: '10' }, 11)).toBe(true);
        expect(cfMatches({ op: 'gt', a: '10' }, 10)).toBe(false);
        expect(cfMatches({ op: 'gte', a: '10' }, 10)).toBe(true);
        expect(cfMatches({ op: 'lt', a: '10' }, '9')).toBe(false);
        expect(cfMatches({ op: 'lte', a: '10' }, 10)).toBe(true);
        expect(cfMatches({ op: 'between', a: '5', b: '1' }, 3)).toBe(true);
        expect(cfMatches({ op: 'between', a: '1', b: '5' }, 6)).toBe(false);
        expect(cfMatches({ op: 'gt', a: '0' }, null)).toBe(false);
    });
    test('equality compares numbers as numbers and text without case', () => {
        expect(cfMatches({ op: 'eq', a: '7' }, 7)).toBe(true);
        expect(cfMatches({ op: 'eq', a: 'Overdue' }, 'overdue')).toBe(true);
        expect(cfMatches({ op: 'neq', a: 'Paid' }, 'Open')).toBe(true);
        expect(cfMatches({ op: 'eq', a: '007' }, '007')).toBe(true);
    });
    test('text conditions', () => {
        expect(cfMatches({ op: 'contains', a: 'ver' }, '🔴 Overdue')).toBe(true);
        expect(cfMatches({ op: 'notcontains', a: 'paid' }, 'Open')).toBe(true);
        expect(cfMatches({ op: 'begins', a: 'inv' }, 'INV-0001')).toBe(true);
        expect(cfMatches({ op: 'ends', a: '01' }, 'INV-0001')).toBe(true);
        expect(cfMatches({ op: 'contains', a: '' }, 'anything')).toBe(false);
    });
    test('empty, not empty and error', () => {
        expect(cfMatches({ op: 'empty' }, null)).toBe(true);
        expect(cfMatches({ op: 'empty' }, '')).toBe(true);
        expect(cfMatches({ op: 'empty' }, 0)).toBe(false);
        expect(cfMatches({ op: 'notempty' }, 0)).toBe(true);
        expect(cfMatches({ op: 'error' }, null, true)).toBe(true);
        expect(cfMatches({ op: 'error' }, 5, false)).toBe(false);
        expect(cfMatches({ op: 'gt', a: '1' }, 5, true)).toBe(false);
    });
});

describe('conditional formatting ranges and precedence', () => {
    const rows = new Map([['r1', 0], ['r2', 1], ['r3', 2], ['r4', 3]]), cols = new Map([['c1', 0], ['c2', 1]]);
    test('a rule only styles cells inside its range', () => {
        const resolved = cfResolve([rule({})], rows, cols);
        expect(cfStyleAt(resolved, 1, 0, 50, false)).toEqual({ fill: '#ffc7ce' });
        expect(cfStyleAt(resolved, 3, 0, 50, false)).toBeUndefined();
        expect(cfStyleAt(resolved, 1, 1, 50, false)).toBeUndefined();
        expect(cfStyleAt(resolved, 1, 0, 5, false)).toBeUndefined();
    });
    test('reversed corners still resolve, and removed rows drop the rule', () => {
        expect(cfResolve([rule({ r0: 'r3', r1: 'r1' })], rows, cols)[0]).toMatchObject({ r0: 0, r1: 2 });
        expect(cfResolve([rule({ r1: 'gone' })], rows, cols)).toEqual([]);
    });
    test('the first matching rule wins each property; later rules fill the gaps', () => {
        const resolved = cfResolve([rule({ id: 'a', order: 0, fill: '#ffc7ce' }), rule({ id: 'b', order: 1, fill: '#c6efce', color: '#006100', bold: true })], rows, cols);
        expect(cfStyleAt(resolved, 0, 0, 99, false)).toEqual({ fill: '#ffc7ce', color: '#006100', bold: true });
    });
});

describe('conditional formatting validation', () => {
    test('rejects incomplete or unsafe rules', () => {
        expect(() => validateCfRule({ op: 'gt', a: 'abc', fill: '#ffc7ce' })).toThrow(/numeric/);
        expect(() => validateCfRule({ op: 'between', a: '1', fill: '#ffc7ce' })).toThrow(/both/);
        expect(() => validateCfRule({ op: 'contains', a: '', fill: '#ffc7ce' })).toThrow(/value/);
        expect(() => validateCfRule({ op: 'empty', fill: 'red' })).toThrow(/hexadecimal/);
        expect(() => validateCfRule({ op: 'empty' })).toThrow(/fill color/);
        expect(() => validateCfRule({ op: 'bogus' as never, fill: '#ffc7ce' })).toThrow(/condition/);
        expect(() => validateCfRule({ op: 'gt', a: '1', color: '#9c0006' })).not.toThrow();
    });
    test('summaries read naturally', () => {
        expect(cfSummary({ op: 'gt', a: '100' })).toBe('cell is greater than “100”');
        expect(cfSummary({ op: 'between', a: '1', b: '5' })).toBe('cell is between 1 and 5');
        expect(cfSummary({ op: 'empty' })).toBe('cell is empty');
    });
});

import * as Y from 'yjs';
import { addCfRule, axes, cfRules, initialize, orderedSheets, removeCfRule, setStyle } from './model';

describe('conditional formatting storage', () => {
    function book() {
        const doc = new Y.Doc(), data = doc.getMap('data'); initialize(data);
        const { id, value } = orderedSheets(data)[0];
        return { doc, data, id, rows: axes(value, 'rows'), columns: axes(value, 'columns'), sheet: value };
    }
    test('rules are stored per sheet, ordered, shared through sync, and removable', () => {
        const b = book(), range = { r0: b.rows[1].id, r1: b.rows[9].id, c0: b.columns[2].id, c1: b.columns[2].id };
        const first = addCfRule(b.data, b.id, { ...range, op: 'gt', a: '100', fill: '#ffc7ce', color: '#9c0006' }, 'test');
        const second = addCfRule(b.data, b.id, { ...range, op: 'empty', fill: '#ffeb9c' }, 'test');
        expect(cfRules(b.sheet).map(rule => rule.id)).toEqual([first.id, second.id]);
        const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(b.doc));
        const copied = orderedSheets(copy.getMap('data'))[0].value;
        expect(cfRules(copied)).toHaveLength(2);
        removeCfRule(b.data, b.id, first.id, 'test');
        expect(cfRules(b.sheet).map(rule => rule.id)).toEqual([second.id]);
    });
    test('invalid rules, missing rows and the rule cap are refused', () => {
        const b = book(), range = { r0: b.rows[0].id, r1: b.rows[0].id, c0: b.columns[0].id, c1: b.columns[0].id };
        expect(() => addCfRule(b.data, b.id, { ...range, op: 'gt', a: 'x', fill: '#ffc7ce' }, 'test')).toThrow(/numeric/);
        expect(() => addCfRule(b.data, b.id, { ...range, r1: 'missing', op: 'empty', fill: '#ffc7ce' }, 'test')).toThrow(/removed/);
        for (let i = 0; i < 50; i++) addCfRule(b.data, b.id, { ...range, op: 'empty', fill: '#ffc7ce' }, 'test');
        expect(() => addCfRule(b.data, b.id, { ...range, op: 'empty', fill: '#ffc7ce' }, 'test')).toThrow(/up to 50/);
    });
    test('text color is validated like fill color', () => {
        const b = book(), cell = [{ row: b.rows[0].id, column: b.columns[0].id }];
        setStyle(b.data, b.id, cell, { color: '#9c0006' }, 'test');
        expect(() => setStyle(b.data, b.id, cell, { color: 'red' }, 'test')).toThrow(/hexadecimal/);
    });
});
