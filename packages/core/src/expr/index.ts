// CI expression parser (Pratt) + evaluator with GitLab/Ruby semantics.
// Reference: gitlab/lib/gitlab/ci/pipeline/expression/**.
import { ExprSyntaxError, tokenize, type Token } from './lexer.js';
import { parseSlashPattern, translateRegex, type Matcher } from './regex.js';

export { ExprSyntaxError } from './lexer.js';

type RegexVal = { kind: 'regex'; source: string; flags: string };
/** Ruby-ish runtime value. */
export type Value = string | null | boolean | RegexVal;

export interface EvalContext {
  vars: Record<string, string | undefined>;
  inputs: Record<string, unknown>;
  warnings: string[];
}

export type Node =
  | { k: 'var'; name: string }
  | { k: 'input'; name: string }
  | { k: 'str'; value: string }
  | { k: 're'; source: string; flags: string }
  | { k: 'null' }
  | { k: 'bool'; value: boolean }
  | { k: 'not'; operand: Node }
  | { k: 'paren'; inner: Node }
  | { k: 'bin'; op: '==' | '!=' | '=~' | '!~' | '&&' | '||'; left: Node; right: Node };

const BP: Record<string, number> = { or: 1, and: 2, eq: 3, ne: 3, match: 3, nomatch: 3 };
const OPS = { or: '||', and: '&&', eq: '==', ne: '!=', match: '=~', nomatch: '!~' } as const;

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}
  parse(): Node {
    if (this.toks.length === 0) throw new ExprSyntaxError('Empty expression');
    const n = this.expr(0);
    if (this.i < this.toks.length) throw new ExprSyntaxError('Unexpected token', this.toks[this.i]!.pos);
    return n;
  }
  private expr(minBp: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.toks[this.i];
      if (!t || !(t.t in BP)) break;
      const bp = BP[t.t]!;
      if (bp <= minBp) break;
      this.i++;
      const right = this.expr(bp);
      left = { k: 'bin', op: OPS[t.t as keyof typeof OPS], left, right };
    }
    return left;
  }
  private prefix(): Node {
    const t = this.toks[this.i++];
    if (!t) throw new ExprSyntaxError('Unexpected end of expression');
    switch (t.t) {
      case 'var': return { k: 'var', name: t.name };
      case 'input': return { k: 'input', name: t.name };
      case 'str': return { k: 'str', value: t.value };
      case 're': return { k: 're', source: t.source, flags: t.flags };
      case 'null': return { k: 'null' };
      case 'bool': return { k: 'bool', value: t.value };
      case 'not': return { k: 'not', operand: this.prefix() };
      case 'lparen': {
        const n = this.expr(0);
        if (this.toks[this.i]?.t !== 'rparen') throw new ExprSyntaxError('Unmatched parenthesis', t.pos);
        this.i++;
        return { k: 'paren', inner: n };
      }
      default: throw new ExprSyntaxError(`Unexpected token '${t.t}'`, t.pos);
    }
  }
}

/** Ruby Object#present? */
export function present(v: Value): boolean {
  if (v === null || v === false) return false;
  if (typeof v === 'string') return !/^\s*$/.test(v);
  return true;
}
const truthy = (v: Value) => v !== null && v !== false; // Ruby truthiness

function eq(a: Value, b: Value): boolean {
  const bool = (x: Value) => typeof x === 'boolean';
  if ((bool(a) && typeof b === 'string') || (typeof a === 'string' && bool(b))) return String(a) === String(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') return a.source === b.source && a.flags === b.flags;
  return a === b;
}

function toRegex(v: Value, ctx: EvalContext): Matcher | 'substring' | null {
  let src: string, flags: string;
  if (v && typeof v === 'object') ({ source: src, flags } = v);
  else if (typeof v === 'string') {
    // Pattern.build: unescape \/ then RubySyntax (greedy).
    const p = parseSlashPattern(v.replace(/\\\//g, '/'));
    if (!p) {
      ctx.warnings.push(`right side "${v}" is not a /regex/; GitLab does a substring scan`);
      return 'substring';
    }
    [src, flags] = p;
  } else return null;
  const t = translateRegex(src, flags);
  ctx.warnings.push(...t.warnings);
  if (t.error) throw new ExprSyntaxError(t.error);
  return t.re!;
}

function matches(text: Value, rv: Value, ctx: EvalContext): boolean {
  const re = toRegex(rv, ctx);
  const s = text === null ? '' : typeof text === 'object' ? '' : String(text);
  if (re === 'substring') return (rv as string).includes(s);
  return re!.test(s);
}

export function evaluateNode(n: Node, ctx: EvalContext): Value {
  switch (n.k) {
    case 'var': return ctx.vars[n.name] ?? null;
    case 'input': {
      const v = ctx.inputs[n.name];
      return v === undefined || v === null ? null : typeof v === 'boolean' ? v : String(v);
    }
    case 'str': return n.value;
    case 're': return { kind: 'regex', source: n.source, flags: n.flags };
    case 'null': return null;
    case 'bool': return n.value;
    case 'not': return !present(evaluateNode(n.operand, ctx));
    case 'paren': return evaluateNode(n.inner, ctx);
    case 'bin': {
      if (n.op === '&&') { const l = evaluateNode(n.left, ctx); return truthy(l) ? evaluateNode(n.right, ctx) : l; }
      if (n.op === '||') { const l = evaluateNode(n.left, ctx); return truthy(l) ? l : evaluateNode(n.right, ctx); }
      const l = evaluateNode(n.left, ctx);
      const r = evaluateNode(n.right, ctx);
      if (n.op === '==') return eq(l, r);
      if (n.op === '!=') return !eq(l, r);
      if (r === null || r === false) return n.op === '!~';
      return n.op === '=~' ? matches(l, r, ctx) : !matches(l, r, ctx);
    }
  }
}

const quote = (s: string) => JSON.stringify(s);

export function nodeToString(n: Node, show?: (n: Node) => string | undefined): string {
  const o = show?.(n);
  if (o !== undefined) return o;
  switch (n.k) {
    case 'var': return `$${n.name}`;
    case 'input': return `$[[ inputs.${n.name} ]]`;
    case 'str': return quote(n.value);
    case 're': return `/${n.source.replace(/\//g, '\\/')}/${n.flags}`;
    case 'null': return 'null';
    case 'bool': return String(n.value);
    case 'not': return `!${nodeToString(n.operand, show)}`;
    case 'paren': return `(${nodeToString(n.inner, show)})`;
    case 'bin': return `${nodeToString(n.left, show)} ${n.op} ${nodeToString(n.right, show)}`;
  }
}

function collectVars(n: Node, acc: Set<string>): Set<string> {
  if (n.k === 'paren') collectVars(n.inner, acc);
  else if (n.k === 'var') acc.add(n.name);
  else if (n.k === 'not') collectVars(n.operand, acc);
  else if (n.k === 'bin') { collectVars(n.left, acc); collectVars(n.right, acc); }
  return acc;
}

export interface ParsedExpression {
  readonly source: string;
  readonly root: Node;
  toString(): string;
  variables(): string[];
}

export function parseExpression(source: string): ParsedExpression {
  const root = new Parser(tokenize(source)).parse();
  return {
    source,
    root,
    toString: () => nodeToString(root),
    variables: () => [...collectVars(root, new Set())],
  };
}

export interface ExpressionResult {
  /** Statement#truthful? */
  result: boolean;
  value: Value;
  /** Expression with variables replaced by their values, for the trace. */
  expanded: string;
  warnings: string[];
  error?: string;
}

export function evaluateExpression(
  source: string,
  vars: Record<string, string | undefined>,
  inputs: Record<string, unknown> = {},
): ExpressionResult {
  const ctx: EvalContext = { vars, inputs, warnings: [] };
  let parsed: ParsedExpression;
  try {
    parsed = parseExpression(source);
  } catch (e) {
    return { result: false, value: null, expanded: source, warnings: [], error: (e as Error).message };
  }
  const expanded = nodeToString(parsed.root, (n) => {
    if (n.k === 'var') { const v = vars[n.name]; return v === undefined ? 'null' : quote(v); }
    if (n.k === 'input') { const v = inputs[n.name]; return v === undefined ? 'null' : quote(String(v)); }
    return undefined;
  });
  try {
    const value = evaluateNode(parsed.root, ctx);
    return { result: present(value), value, expanded, warnings: [...new Set(ctx.warnings)] };
  } catch (e) {
    return { result: false, value: null, expanded, warnings: ctx.warnings, error: (e as Error).message };
  }
}
