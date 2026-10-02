/**
 * Safe arithmetic/boolean expression evaluator for configuration formulas.
 *
 * Used by measure templates (`pieces * length`) and workflow conditions
 * (`max_discount_pct > 10`). No `eval`, no property access, no calls except
 * a fixed whitelist. Unknown identifiers evaluate to 0 so partially filled
 * lines still compute.
 *
 * Grammar (precedence low → high):
 *   or      := and ( '||' and )*
 *   and     := cmp ( '&&' cmp )*
 *   cmp     := sum ( ('>'|'<'|'>='|'<='|'=='|'!=') sum )?
 *   sum     := term ( ('+'|'-') term )*
 *   term    := unary ( ('*'|'/'|'%') unary )*
 *   unary   := ('-'|'!') unary | primary
 *   primary := number | ident | ident '(' args ')' | '(' or ')'
 */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'end' };

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  ceil: (x) => Math.ceil(x),
  floor: (x) => Math.floor(x),
  abs: (x) => Math.abs(x),
  round: (x, d = 0) => {
    const f = 10 ** d;
    return Math.round(x * f) / f;
  },
};

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%()<>!,'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character '${c}' in formula`);
  }
  out.push({ t: 'end' });
  return out;
}

export class FormulaError extends Error {}

export type FormulaScope = Record<string, number | boolean | undefined | null>;

export function compileFormula(src: string): (scope: FormulaScope) => number {
  const toks = tokenize(src);
  // Validate syntax eagerly by parsing once against an empty scope.
  const run = (scope: FormulaScope) => {
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v: string) => {
      const k = toks[p];
      return k.t === 'op' && k.v === v;
    };
    const expect = (v: string) => {
      if (!isOp(v)) throw new FormulaError(`Expected '${v}'`);
      p++;
    };
    const num = (x: number | boolean | undefined | null): number =>
      typeof x === 'boolean' ? (x ? 1 : 0) : typeof x === 'number' && Number.isFinite(x) ? x : 0;

    const primary = (): number => {
      const k = peek();
      if (k.t === 'num') {
        p++;
        return k.v;
      }
      if (k.t === 'id') {
        p++;
        if (isOp('(')) {
          p++;
          const fn = FUNCS[k.v];
          if (!fn) throw new FormulaError(`Unknown function '${k.v}'`);
          const args: number[] = [];
          if (!isOp(')')) {
            args.push(or());
            while (isOp(',')) {
              p++;
              args.push(or());
            }
          }
          expect(')');
          return fn(...args);
        }
        if (k.v === 'true') return 1;
        if (k.v === 'false') return 0;
        return num(scope[k.v]);
      }
      if (isOp('(')) {
        p++;
        const v = or();
        expect(')');
        return v;
      }
      throw new FormulaError('Unexpected end of formula');
    };
    const unary = (): number => {
      if (isOp('-')) {
        p++;
        return -unary();
      }
      if (isOp('!')) {
        p++;
        return unary() ? 0 : 1;
      }
      return primary();
    };
    const term = (): number => {
      let v = unary();
      for (;;) {
        if (isOp('*')) {
          p++;
          v *= unary();
        } else if (isOp('/')) {
          p++;
          const d = unary();
          v = d === 0 ? 0 : v / d;
        } else if (isOp('%')) {
          p++;
          const d = unary();
          v = d === 0 ? 0 : v % d;
        } else return v;
      }
    };
    const sum = (): number => {
      let v = term();
      for (;;) {
        if (isOp('+')) {
          p++;
          v += term();
        } else if (isOp('-')) {
          p++;
          v -= term();
        } else return v;
      }
    };
    const cmp = (): number => {
      const a = sum();
      const k = peek();
      if (k.t === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(k.v)) {
        p++;
        const b = sum();
        switch (k.v) {
          case '>': return a > b ? 1 : 0;
          case '<': return a < b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          default: return a !== b ? 1 : 0;
        }
      }
      return a;
    };
    const and = (): number => {
      let v = cmp();
      while (isOp('&&')) {
        p++;
        const r = cmp();
        v = v && r ? 1 : 0;
      }
      return v;
    };
    function or(): number {
      let v = and();
      while (isOp('||')) {
        p++;
        const r = and();
        v = v || r ? 1 : 0;
      }
      return v;
    }
    const v = or();
    if (peek().t !== 'end') throw new FormulaError('Unexpected token after end of formula');
    return v;
  };
  run({});
  return run;
}

const cache = new Map<string, (scope: FormulaScope) => number>();

export function evaluate(src: string, scope: FormulaScope): number {
  let fn = cache.get(src);
  if (!fn) {
    fn = compileFormula(src);
    cache.set(src, fn);
  }
  return fn(scope);
}
