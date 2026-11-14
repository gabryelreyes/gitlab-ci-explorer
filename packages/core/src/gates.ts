// Gate variables: every $VAR used in workflow/job rules and only/except:variables,
// with the literals/regexes it is compared against (UI suggestions).
import { nodeToString, parseExpression, type Node } from './expr/index.js';
import type { NormalizedConfig } from './model.js';

export interface Gate {
  name: string;
  /** CI_* / GITLAB_* — normally filled by the scenario preset. */
  predefined: boolean;
  /** Value from top-level `variables:` if defined there. */
  yamlValue?: string;
  /** String literals compared with == / !=. */
  values: string[];
  /** Regexes used with =~ / !~. */
  patterns: string[];
  /** Other variables it is compared with ($A == $B). */
  comparedWith: string[];
  /** Compared against null. */
  nullCompared: boolean;
  /** Used bare ($VAR, !$VAR) — only its presence matters. */
  truthiness: boolean;
  /** 'workflow' and/or job names. */
  usedBy: string[];
}

const isPredefined = (n: string) => n === 'CI' || n.startsWith('CI_') || n.startsWith('GITLAB_');

export function extractGates(cfg: NormalizedConfig): Gate[] {
  const gates = new Map<string, Gate>();
  const get = (name: string, user: string): Gate => {
    let g = gates.get(name);
    if (!g) {
      g = { name, predefined: isPredefined(name), values: [], patterns: [], comparedWith: [], nullCompared: false, truthiness: false, usedBy: [] };
      const y = cfg.variables[name];
      if (y) g.yamlValue = y.value;
      gates.set(name, g);
    }
    if (!g.usedBy.includes(user)) g.usedBy.push(user);
    return g;
  };
  const push = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };

  const visit = (n: Node, user: string, bare: boolean): void => {
    switch (n.k) {
      case 'var': { const g = get(n.name, user); if (bare) g.truthiness = true; return; }
      case 'paren': return visit(n.inner, user, bare);
      case 'not': return visit(n.operand, user, true);
      case 'bin': {
        if (n.op === '&&' || n.op === '||') { visit(n.left, user, true); visit(n.right, user, true); return; }
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]] as const) {
          if (a.k !== 'var') continue;
          const g = get(a.name, user);
          if (b.k === 'str') push(g.values, b.value);
          else if (b.k === 're') push(g.patterns, nodeToString(b));
          else if (b.k === 'null') g.nullCompared = true;
          else if (b.k === 'var') push(g.comparedWith, b.name);
        }
        return;
      }
      default: return;
    }
  };
  const scan = (expr: string | undefined, user: string) => {
    if (!expr) return;
    try { visit(parseExpression(expr).root, user, true); } catch { /* invalid expressions are reported elsewhere */ }
  };

  for (const r of cfg.workflow.rules ?? []) scan(r.if, 'workflow');
  for (const j of cfg.jobs) {
    for (const r of j.rules ?? []) scan(r.if, j.name);
    for (const e of [...(j.only?.variables ?? []), ...(j.except?.variables ?? [])]) scan(e, j.name);
  }
  const all = [...gates.values()];
  return [...all.filter((g) => !g.predefined), ...all.filter((g) => g.predefined)];
}
