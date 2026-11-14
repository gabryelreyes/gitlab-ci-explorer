// Raw YAML body → NormalizedConfig. Single-file stage of the pipeline:
// extends → !reference → default/inherit → hidden jobs/stages → typed model.
import { resolveConfig, type ResolvedYaml } from '../include/resolve.js';
import type { LoadedYaml } from '../yaml/load.js';
import {
  WHEN_VALUES, type Job, type Need, type NormalizedConfig, type PathsClause,
  type Policy, type Rule, type Trigger, type VarDef, type When,
} from '../model.js';
import { parseExpression } from '../expr/index.js';
import { isPlainObject } from '../util/merge.js';
import { resolveExtends } from './extends.js';
import { flattenNested, resolveReferences } from './reference.js';

const GLOBAL_KEYS = new Set([
  'default', 'include', 'stages', 'types', 'variables', 'workflow', 'spec',
  'image', 'services', 'cache', 'before_script', 'after_script',
]);
const LEGACY_GLOBAL_DEFAULTS = ['image', 'services', 'cache', 'before_script', 'after_script'];
const DEFAULT_KEYS = [
  'after_script', 'artifacts', 'before_script', 'cache', 'hooks', 'id_tokens', 'image',
  'interruptible', 'retry', 'services', 'tags', 'timeout',
];
const FLATTEN_KEYS = ['script', 'before_script', 'after_script', 'rules'];
const DEFAULT_STAGES = ['build', 'test', 'deploy'];
const RULE_KEYS = new Set(['if', 'changes', 'exists', 'when', 'allow_failure', 'variables', 'needs', 'start_in', 'interruptible']);

export function normalizeConfig(input: LoadedYaml): NormalizedConfig {
  // Unresolved input (no file store / scenario): includes are only listed (standalone mode).
  const doc: ResolvedYaml = 'includes' in input ? (input as ResolvedYaml) : resolveConfig(input);
  const errors = [...doc.errors];
  const warnings = [...doc.warnings];
  const cfg: NormalizedConfig = { includes: doc.includes, stages: [], variables: {}, workflow: {}, jobs: [], header: doc.header, errors, warnings };
  if (doc.errors.length) return cfg;


  const body = resolveReferences(resolveExtends(doc.body, errors), errors);

  // stages
  const rawStages = body.stages ?? body.types;
  if ('types' in body) warnings.push('`types` is deprecated; use `stages`');
  const userStages = Array.isArray(rawStages) ? rawStages.map(String) : DEFAULT_STAGES;
  cfg.stages = ['.pre', ...userStages.filter((s) => s !== '.pre' && s !== '.post'), '.post'];

  cfg.variables = normalizeVariables(body.variables, 'variables', errors, true);

  // workflow
  if (isPlainObject(body.workflow)) {
    const wf = body.workflow;
    if (wf.name !== undefined && wf.name !== null) cfg.workflow.name = String(wf.name);
    if (wf.rules !== undefined) cfg.workflow.rules = normalizeRules(flattenNested(wf.rules), 'workflow', errors, warnings, true);
  }

  // default (+ deprecated global keywords)
  const defaults: Record<string, unknown> = isPlainObject(body.default) ? { ...body.default } : {};
  for (const k of LEGACY_GLOBAL_DEFAULTS) {
    if (k in body) {
      warnings.push(`global \`${k}\` is deprecated; use default:${k}`);
      if (k in defaults) errors.push(`${k} is defined in top-level and \`default:\` entry`);
      else defaults[k] = body[k];
    }
  }

  for (const [name, value] of Object.entries(body)) {
    if (GLOBAL_KEYS.has(name) || name.startsWith('.')) continue;
    if (!isPlainObject(value)) {
      errors.push(`jobs:${name} config should be a hash`);
      continue;
    }
    const job = normalizeJob(name, value, defaults, cfg, errors, warnings);
    job.line = doc.lines[name];
    cfg.jobs.push(job);
  }
  if (cfg.jobs.length === 0 && errors.length === 0) errors.push('jobs config should contain at least one visible job');
  validateDependencies(cfg, errors);
  return cfg;
}

/** Static needs/dependencies checks (YamlProcessor#validate_job_dependency!, validate_needs_specification!). */
function validateDependencies(cfg: NormalizedConfig, errors: string[]): void {
  const stageOf = new Map(cfg.jobs.map((j) => [j.name, cfg.stages.indexOf(j.stage)]));
  const check = (job: Job, dep: string, type: 'need' | 'dependency', optional = false) => {
    if (!stageOf.has(dep)) {
      if (!optional) errors.push(`${job.name} job: undefined ${type}: ${dep}`);
      return;
    }
    if (stageOf.get(dep)! > cfg.stages.indexOf(job.stage)) {
      errors.push(`${job.name} job: ${type} ${dep} is not defined in current or prior stages`);
    }
  };
  const checkNeeds = (job: Job, needs: Need[] | undefined) => {
    const local = (needs ?? []).filter((n) => !n.pipeline && !n.project);
    for (const n of local) check(job, n.job, 'need', n.optional);
    const dup = [...new Set(local.map((n) => n.job).filter((x, i, a) => a.indexOf(x) !== i))];
    if (dup.length) errors.push(`${job.name} has the following needs duplicated: ${dup.join(', ')}.`);
  };
  for (const job of cfg.jobs) {
    checkNeeds(job, job.needs);
    for (const r of job.rules ?? []) checkNeeds(job, r.needs);
    for (const d of job.dependencies ?? []) check(job, d, 'dependency');
  }
}

function checkExpression(expr: string, where: string, errors: string[]): void {
  try { parseExpression(expr); } catch { errors.push(`${where} invalid expression syntax`); }
}

function normalizeJob(
  name: string, src: Record<string, unknown>, defaults: Record<string, unknown>,
  cfg: NormalizedConfig, errors: string[], warnings: string[],
): Job {
  const raw: Record<string, unknown> = { ...src };
  for (const k of FLATTEN_KEYS) if (k in raw) raw[k] = flattenNested(raw[k]);

  const inherit = isPlainObject(raw.inherit) ? raw.inherit : {};
  const pick = (setting: unknown, key: string) =>
    setting === undefined || setting === true || (Array.isArray(setting) && setting.map(String).includes(key));
  for (const k of DEFAULT_KEYS) {
    if (!(k in raw) && k in defaults && pick(inherit.default, k)) raw[k] = defaults[k];
  }
  const inheritedVariables = Object.fromEntries(
    Object.entries(cfg.variables).filter(([k]) => pick(inherit.variables, k)),
  );

  const stage = raw.stage === undefined ? 'test' : String(raw.stage);
  if (!cfg.stages.includes(stage)) {
    errors.push(`${name} job: chosen stage ${stage} does not exist; available stages are ${cfg.stages.join(', ')}`);
  }

  const trigger = normalizeTrigger(raw.trigger);
  if (!('script' in raw) && !('run' in raw) && !trigger) {
    errors.push(`jobs:${name} config should implement the script:, run:, or trigger: keyword`);
  }

  const job: Job = {
    name,
    stage,
    variables: normalizeVariables(raw.variables, `jobs:${name}:variables`, errors, false),
    inheritedVariables,
    inheritVariables: inherit.variables === false ? false : Array.isArray(inherit.variables) ? inherit.variables.map(String) : true,
    raw,
  };
  if (raw.when !== undefined) job.when = normalizeWhen(raw.when, `jobs:${name}`, errors, 'job');
  if (raw.rules !== undefined) job.rules = normalizeRules(raw.rules, `jobs:${name}`, errors, warnings, false);
  if (raw.only !== undefined) job.only = normalizePolicy(raw.only, `jobs:${name}:only`, errors);
  if (raw.except !== undefined) job.except = normalizePolicy(raw.except, `jobs:${name}:except`, errors);
  if (job.rules && (job.only || job.except)) errors.push(`jobs:${name} config key may not be used with \`rules\`: only, except`);
  if (raw.needs !== undefined) job.needs = normalizeNeeds(raw.needs, `jobs:${name}:needs`, errors);
  if (Array.isArray(raw.dependencies)) job.dependencies = raw.dependencies.map(String);
  if (typeof raw.allow_failure === 'boolean') job.allowFailure = raw.allow_failure;
  else if (isPlainObject(raw.allow_failure)) {
    const ec = raw.allow_failure.exit_codes;
    job.allowFailure = { exit_codes: (Array.isArray(ec) ? ec : [ec]).map(Number) };
  }
  if (raw.start_in !== undefined) {
    job.startIn = String(raw.start_in);
    if (job.rules || job.when !== 'delayed') errors.push(`jobs:${name} start_in must be blank (only for when: delayed without rules)`);
  }
  if (job.when === 'delayed' && !job.startIn && !job.rules) errors.push(`jobs:${name} start in should be specified for delayed job`);
  if (trigger) job.trigger = trigger;
  if (raw.parallel !== undefined) job.parallel = raw.parallel;
  return job;
}

function normalizeWhen(v: unknown, where: string, errors: string[], ctx: 'workflow' | 'rule' | 'job'): When | undefined {
  const s = String(v) as When;
  const allowed: readonly When[] =
    ctx === 'workflow' ? ['always', 'never'] : ctx === 'job' ? WHEN_VALUES.filter((w) => w !== 'never') : WHEN_VALUES;
  if (!allowed.includes(s)) {
    errors.push(`${where} when: unknown value "${s}" (allowed: ${allowed.join(', ')})`);
    return undefined;
  }
  return s;
}

function scalar(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function normalizeVariables(v: unknown, where: string, errors: string[], global: boolean): Record<string, VarDef> {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) { errors.push(`${where} config should be a hash of key value pairs`); return {}; }
  const out: Record<string, VarDef> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (isPlainObject(raw)) {
      const d: VarDef = { value: scalar(raw.value), expand: raw.expand !== false };
      if (global && raw.description !== undefined) d.description = String(raw.description);
      if (global && Array.isArray(raw.options)) d.options = raw.options.map(String);
      out[k] = d;
    } else {
      if (typeof raw === 'boolean') errors.push(`${where}: ${k} value must be a string or number, got boolean`);
      out[k] = { value: scalar(raw), expand: true };
    }
  }
  return out;
}

function normalizePaths(v: unknown, where: string, errors: string[]): PathsClause | undefined {
  if (Array.isArray(v)) return { paths: v.map(String) };
  if (typeof v === 'string') return { paths: [v] };
  if (isPlainObject(v)) {
    const c: PathsClause = { paths: Array.isArray(v.paths) ? v.paths.map(String) : [] };
    if (v.compare_to !== undefined) c.compareTo = String(v.compare_to);
    if (v.project !== undefined) c.project = String(v.project);
    if (v.ref !== undefined) c.ref = String(v.ref);
    return c;
  }
  errors.push(`${where} should be an array of paths or a hash with paths:`);
  return undefined;
}

function normalizeRules(v: unknown, where: string, errors: string[], warnings: string[], workflow: boolean): Rule[] {
  if (!Array.isArray(v)) { errors.push(`${where}:rules config should be an array of hashes`); return []; }
  return v.map((r, i): Rule => {
    const w = `${where}:rules[${i}]`;
    if (!isPlainObject(r)) { errors.push(`${w} config should be a hash`); return {}; }
    for (const k of Object.keys(r)) {
      if (!RULE_KEYS.has(k) && !(workflow && k === 'auto_cancel')) errors.push(`${w} config contains unknown key: ${k}`);
    }
    const rule: Rule = {};
    if (r.if !== undefined) {
      if (typeof r.if !== 'string') errors.push(`${where}:rules:rule if should be a string`);
      else { rule.if = r.if; checkExpression(r.if, `${where}:rules:rule if`, errors); }
    }
    if (r.changes !== undefined) rule.changes = normalizePaths(r.changes, `${w}:changes`, errors);
    if (r.exists !== undefined) rule.exists = normalizePaths(r.exists, `${w}:exists`, errors);
    if (r.when !== undefined) rule.when = normalizeWhen(r.when, w, errors, workflow ? 'workflow' : 'rule');
    if (typeof r.allow_failure === 'boolean') rule.allow_failure = r.allow_failure;
    if (isPlainObject(r.variables)) rule.variables = Object.fromEntries(Object.entries(r.variables).map(([k, x]) => [k, scalar(x)]));
    if (r.needs !== undefined) rule.needs = normalizeNeeds(r.needs, `${w}:needs`, errors);
    if (r.start_in !== undefined) rule.start_in = String(r.start_in);
    if (typeof r.interruptible === 'boolean') rule.interruptible = r.interruptible;
    if (workflow && (rule.allow_failure !== undefined || rule.needs || rule.start_in)) {
      warnings.push(`${w}: only if/changes/exists/when/variables apply in workflow rules`);
    }
    return rule;
  });
}

function normalizeNeeds(v: unknown, where: string, errors: string[]): Need[] {
  if (isPlainObject(v) && Array.isArray(v.job)) v = v.job; // rare `needs: {job: [...]}` form
  if (!Array.isArray(v)) { errors.push(`${where} config should be an array`); return []; }
  const out: Need[] = [];
  for (const n of v) {
    if (typeof n === 'string') { out.push({ job: n, optional: false, artifacts: true }); continue; }
    if (!isPlainObject(n) || n.job === undefined) { errors.push(`${where}: each need must be a job name or a hash with job:`); continue; }
    const need: Need = { job: String(n.job), optional: n.optional === true, artifacts: n.artifacts !== false };
    if (n.pipeline !== undefined) need.pipeline = String(n.pipeline);
    if (n.project !== undefined) need.project = String(n.project);
    if (n.ref !== undefined) need.ref = String(n.ref);
    if (n.parallel !== undefined) need.parallel = n.parallel;
    out.push(need);
  }
  return out;
}

function normalizePolicy(v: unknown, where: string, errors: string[]): Policy | undefined {
  if (Array.isArray(v) || typeof v === 'string') return { refs: (Array.isArray(v) ? v : [v]).map(String) };
  if (!isPlainObject(v)) { errors.push(`${where} config should be an array or a hash`); return undefined; }
  const p: Policy = {};
  if (v.refs !== undefined) p.refs = (Array.isArray(v.refs) ? v.refs : [v.refs]).map(String);
  if (v.variables !== undefined) {
    p.variables = (Array.isArray(v.variables) ? v.variables : [v.variables]).map(String);
    for (const e of p.variables) checkExpression(e, `${where} variables`, errors);
  }
  if (v.changes !== undefined) p.changes = normalizePaths(v.changes, `${where}:changes`, errors);
  if (v.kubernetes !== undefined) p.kubernetes = String(v.kubernetes);
  return p;
}

function normalizeTrigger(v: unknown): Trigger | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return { kind: 'multi-project', project: v };
  if (!isPlainObject(v)) return undefined;
  const strategy = v.strategy === undefined ? undefined : String(v.strategy);
  if (v.include !== undefined) {
    const inc = Array.isArray(v.include) ? v.include : [v.include];
    const dynamic = inc.some((i) => isPlainObject(i) && 'artifact' in i);
    return { kind: 'child', include: v.include, dynamic, ...(strategy && { strategy }) };
  }
  return {
    kind: 'multi-project',
    project: v.project === undefined ? undefined : String(v.project),
    ...(v.branch !== undefined && { branch: String(v.branch) }),
    ...(strategy && { strategy }),
  };
}
