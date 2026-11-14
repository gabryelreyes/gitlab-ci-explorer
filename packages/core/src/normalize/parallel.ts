// parallel: N / parallel:matrix expansion (Gitlab::Ci::Config::Normalizer + Entry::Product::{Parallel,Matrix}).
// Runs after jobs are normalized: each parallel job is replaced by its instances, then needs/dependencies
// naming a parallel job are rewritten to instance names.
import type { Job, Need, NormalizedConfig, ParallelInfo, VarDef } from '../model.js';
import { isPlainObject } from '../util/merge.js';

const LIMIT = 200;

interface Instance { name: string; vars?: Record<string, string> }

const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'number';

/** Product of one matrix entry, in key order (MatrixStrategy.expand). */
function product(entry: Record<string, string[]>): Record<string, string>[] {
  return Object.entries(entry).reduce<Record<string, string>[]>(
    (acc, [k, vals]) => acc.flatMap((a) => vals.map((v) => ({ ...a, [k]: v }))), [{}],
  );
}

/** Instances for a `parallel:` value; undefined (with errors) when invalid. */
export function parallelInstances(
  name: string, v: unknown, where: string, errors: string[], numberAllowed = true,
): Instance[] | undefined {
  if (typeof v === 'number') {
    if (!numberAllowed) { errors.push(`${where} config cannot use "parallel: <number>".`); return undefined; }
    if (!Number.isInteger(v)) { errors.push(`${where} config must be an integer`); return undefined; }
    if (v < 1) { errors.push(`${where} config must be greater than or equal to 1`); return undefined; }
    if (v > LIMIT) { errors.push(`${where} config must be less than or equal to ${LIMIT}`); return undefined; }
    return Array.from({ length: v }, (_, i) => ({ name: `${name} ${i + 1}/${v}` }));
  }
  if (!isPlainObject(v)) { errors.push(`${where} should be an integer or a hash`); return undefined; }
  const n = errors.length;
  const unknown = Object.keys(v).filter((k) => k !== 'matrix');
  if (unknown.length) errors.push(`${where} config contains unknown keys: ${unknown.join(', ')}`);
  if (!('matrix' in v)) errors.push(`${where} config missing required keys: matrix`);
  const m = v.matrix;
  if (!Array.isArray(m) || !m.every(isPlainObject)) {
    if ('matrix' in v) errors.push(`${where}:matrix config should be an array of hashes`);
    return undefined;
  }
  const entries = m.map((e) => {
    if (!Object.keys(e).length) errors.push(`${where}:matrix:variables config requires at least 1 items`);
    if (!Object.values(e).every((x) => isScalar(x) || (Array.isArray(x) && x.every(isScalar)))) {
      errors.push(`${where}:matrix:variables config should be a hash of key value pairs, value can be an array`);
    }
    return Object.fromEntries(Object.entries(e).map(([k, x]) => [k, ([] as unknown[]).concat(x).map(String)]));
  });
  const count = entries.reduce((s, e) => s + Object.values(e).reduce((p, x) => p * x.length, 1), 0);
  if (count > LIMIT) errors.push(`${where}:matrix config generates too many jobs (maximum is ${LIMIT})`);
  if (errors.length > n) return undefined;
  return entries.flatMap(product).map((vars) => ({ name: `${name}: [${Object.values(vars).join(', ')}]`, vars }));
}

const MATRIX_EXPR = /\$\[\[\s*matrix\.([a-zA-Z0-9_-]+)\s*\]\]/g;

/** Interpolation::MatrixInterpolator over a needs value. */
function interpolate(v: unknown, vars: Record<string, string>, errs: string[]): unknown {
  if (typeof v === 'string') {
    return v.replace(MATRIX_EXPR, (m, k: string) => {
      if (k in vars) return vars[k]!;
      errs.push(`'${k}' does not exist in matrix configuration`);
      return m;
    });
  }
  if (Array.isArray(v)) return v.map((x) => interpolate(x, vars, errs));
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, vars, errs)]));
  return v;
}

export function expandParallel(cfg: NormalizedConfig, errors: string[]): void {
  const groups = new Map<string, Instance[]>();
  for (const j of cfg.jobs) {
    if (j.raw.parallel === undefined || j.raw.parallel === null) continue;
    const inst = parallelInstances(j.name, j.raw.parallel, `jobs:${j.name}:parallel`, errors, !j.trigger);
    if (inst) groups.set(j.name, inst);
  }

  const expandNeeds = (job: Job, needs: Need[] | undefined): Need[] | undefined => {
    if (!needs) return needs;
    let list = needs;
    if (job.parallel?.matrix && needs.some((n) => JSON.stringify(n).includes('$[['))) {
      const errs: string[] = [];
      const out = interpolate(needs, job.parallel.matrix, errs) as Need[];
      if (errs.length) for (const e of new Set(errs)) errors.push(`${job.name} job: ${e}`);
      else list = out;
    }
    return list.flatMap((n) => {
      const all = !n.pipeline && !n.project ? groups.get(n.job) : undefined;
      if (!all) return [n];
      const picked = n.parallel !== undefined ? parallelInstances(n.job, n.parallel, `${job.name} job: needs:${n.job}:parallel`, errors) ?? [] : all;
      const { parallel: _drop, ...rest } = n;
      return picked.map((i) => ({ ...rest, job: i.name }));
    });
  };
  const expandDeps = (deps: string[] | undefined) => deps?.flatMap((d) => groups.get(d)?.map((i) => i.name) ?? [d]);

  const jobs: Job[] = [];
  for (const j of cfg.jobs) {
    const inst = groups.get(j.name);
    if (!inst) { jobs.push(j); continue; }
    inst.forEach((i, ix) => {
      const parallel: ParallelInfo = { group: j.name, instance: ix + 1, total: inst.length, ...(i.vars && { matrix: i.vars }) };
      const extra: Record<string, VarDef> = Object.fromEntries(Object.entries(i.vars ?? {}).map(([k, v]) => [k, { value: v, expand: true }]));
      jobs.push({
        ...j, name: i.name, parallel,
        variables: { ...j.variables, ...extra, CI_NODE_INDEX: { value: String(ix + 1), expand: false }, CI_NODE_TOTAL: { value: String(inst.length), expand: false } },
      });
    });
  }
  for (const j of jobs) {
    j.needs = expandNeeds(j, j.needs);
    if (j.rules) j.rules = j.rules.map((r) => (r.needs ? { ...r, needs: expandNeeds(j, r.needs) } : r));
    j.dependencies = expandDeps(j.dependencies);
    if (j.needs === undefined) delete j.needs;
    if (j.dependencies === undefined) delete j.dependencies;
  }
  cfg.jobs = jobs;
}
