// `!reference` resolution (gitlab/lib/gitlab/ci/config/yaml/tags/resolver.rb). Runs after extends.
import { isReference, type ReferenceTag } from '../yaml/load.js';
import { isPlainObject } from '../util/merge.js';

const MAX_DEPTH = 10;

export function resolveReferences(config: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const lookup = (ref: ReferenceTag, depth: number): unknown => {
    if (depth > MAX_DEPTH) { errors.push(`${ref}: too many nested references (max ${MAX_DEPTH})`); return null; }
    let cur: unknown = config;
    for (const seg of ref.path) {
      if (!isPlainObject(cur) || !(seg in cur)) { errors.push(`${ref} could not be found`); return null; }
      cur = cur[seg];
    }
    return walk(cur, depth + 1);
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (isReference(v)) return lookup(v, depth);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth));
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth)]));
    return v;
  };
  return walk(config, 0) as Record<string, unknown>;
}

/** script/rules accept nested arrays (from !reference) and flatten them, up to 10 levels. */
export function flattenNested(v: unknown): unknown {
  return Array.isArray(v) ? v.flat(MAX_DEPTH) : v;
}
