// Variable layering + `$VAR` / `${VAR}` expansion (unknown variables expand to "").
import type { VarDef } from '../model.js';

export type VarLayer = Record<string, string | VarDef | undefined> | undefined;

const REF = /\$(?:\{(\w+)\}|(\w+))/g;
const MAX_DEPTH = 10;

function mergeLayers(layers: VarLayer[]): Record<string, VarDef> {
  const defs: Record<string, VarDef> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      defs[k] = typeof v === 'string' ? { value: v, expand: true } : v;
    }
  }
  return defs;
}

/** Merge layers (later wins) without expansion — what rules:if sees (LazyHash#fetch → item.value). */
export function rawVariables(...layers: VarLayer[]): Record<string, string> {
  return Object.fromEntries(Object.entries(mergeLayers(layers)).map(([k, d]) => [k, d.value]));
}

/** Merge layers (later wins) and expand references (what the job / runner sees). */
export function resolveVariables(...layers: VarLayer[]): Record<string, string> {
  const defs = mergeLayers(layers);
  const out: Record<string, string> = {};
  const expand = (name: string, depth: number): string => {
    if (name in out) return out[name]!;
    const d = defs[name];
    if (!d) return '';
    if (!d.expand || depth > MAX_DEPTH) return d.value;
    return d.value.replace(REF, (_m, a: string | undefined, b: string | undefined) => {
      const ref = (a ?? b)!;
      return ref === name ? '' : expand(ref, depth + 1);
    });
  };
  for (const k of Object.keys(defs)) out[k] = expand(k, 0);
  return out;
}

/** Expand `$VAR` inside an arbitrary string. Unknown variables are kept as written (expand_existing). */
export function expandString(s: string, vars: Record<string, string>): string {
  return s.replace(REF, (m, a: string | undefined, b: string | undefined) => vars[(a ?? b)!] ?? m);
}
