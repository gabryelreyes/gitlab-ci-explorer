// `extends:` resolution (gitlab/lib/gitlab/ci/config/extendable).
import { deepMerge, isPlainObject } from '../util/merge.js';

const MAX_NESTING = 11;

export function resolveExtends(body: Record<string, unknown>, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const done = new Set<string>();

  const resolve = (key: string, stack: string[]): void => {
    if (done.has(key)) return;
    const entry = out[key];
    if (!isPlainObject(entry) || !('extends' in entry)) { done.add(key); return; }
    if (stack.includes(key)) {
      errors.push(`${key}: circular dependency detected in \`extends\` (${[...stack, key].join(' → ')})`);
      done.add(key);
      return;
    }
    if (stack.length >= MAX_NESTING) {
      errors.push(`${key}: nesting too deep in \`extends\` (max ${MAX_NESTING})`);
      done.add(key);
      return;
    }
    const raw = entry.extends;
    const parents = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    let merged: unknown = {};
    for (const p of parents) {
      if (!(p in out)) { errors.push(`${key}: unknown key in \`extends\` (${p})`); continue; }
      resolve(p, [...stack, key]);
      const base = out[p];
      if (!isPlainObject(base)) { errors.push(`${key}: invalid base hash in \`extends\` (${p})`); continue; }
      const { extends: _drop, ...rest } = base;
      merged = deepMerge(merged, rest);
    }
    const { extends: _self, ...own } = entry;
    out[key] = deepMerge(merged, own);
    done.add(key);
  };

  for (const key of Object.keys(out)) resolve(key, []);
  return out;
}
