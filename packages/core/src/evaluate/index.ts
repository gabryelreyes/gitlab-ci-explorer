// Scenario evaluation: workflow:rules → job rules / only-except → needs validation → pipeline outcome.
import { evaluateExpression } from '../expr/index.js';
import { parseSlashPattern, translateRegex } from '../expr/regex.js';
import type { IncludeRef, Job, Need, NormalizedConfig, PathsClause, Policy, Rule, Trigger, VarDef, When } from '../model.js';
import type { Scenario } from '../scenario/presets.js';
import { fnmatch } from '../util/fnmatch.js';
import { expandString, rawVariables, resolveVariables, type VarLayer } from '../vars/expand.js';

export interface ClauseTrace {
  kind: 'if' | 'changes' | 'exists' | 'refs' | 'variables' | 'kubernetes';
  /** Clause as written. */
  source: string;
  /** For `if`: expression with variable values substituted. */
  expanded?: string;
  result: boolean;
  /** Why the result is what it is when it wasn't computed from data (assumed, override, n/a). */
  note?: string;
  warnings?: string[];
  error?: string;
}

export interface RuleTrace {
  index: number;
  /** false for rules after the first match (never looked at). */
  evaluated: boolean;
  matched: boolean;
  /** Rule as written, e.g. `if: $X == "y", changes: [src/**]`. */
  text: string;
  clauses: ClauseTrace[];
  when?: When;
}

export interface JobTrace {
  mode: 'rules' | 'only/except';
  rules: RuleTrace[];
  matchedIndex?: number;
  only?: ClauseTrace[];
  except?: ClauseTrace[];
  /** only: was not written; GitLab's default (branches, tags) applied. */
  defaultOnly?: boolean;
}

export interface JobResult {
  name: string;
  stage: string;
  line?: number;
  included: boolean;
  when: When;
  allowFailure: boolean;
  /** Manual job that blocks later stages (manual && !allow_failure). */
  blocking: boolean;
  startIn?: string;
  /** Effective needs (rule override applied, optional-missing dropped); undefined => stage order. */
  needs?: Need[];
  dependencies?: string[];
  trigger?: Trigger;
  /** Effective variables visible to the job. */
  variables: Record<string, string>;
  reason: string;
  trace: JobTrace;
}

export interface WorkflowResult {
  created: boolean;
  name?: string;
  rules: RuleTrace[];
  matchedIndex?: number;
  reason: string;
  variables: Record<string, string>;
}

export interface PipelineResult {
  created: boolean;
  /** Config-level errors (YAML/lint) — the pipeline can't be created for any scenario. */
  invalidConfig: boolean;
  /** include: entries; unresolved ones are reported in standalone mode. */
  includes: IncludeRef[];
  stages: string[];
  workflow: WorkflowResult;
  jobs: JobResult[];
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------- clauses

const ZERO_SHA = /^0+$/;

/** Variables as seen by clauses: `raw` for if/variables (GitLab doesn't expand nested vars there),
 *  `expanded` for paths in changes/exists. */
interface Scope { raw: Record<string, string>; expanded: Record<string, string> }
const scopeOf = (...layers: VarLayer[]): Scope => ({ raw: rawVariables(...layers), expanded: resolveVariables(...layers) });

function firstMatch(patterns: string[], files: string[], vars: Record<string, string>): string | undefined {
  const globs = patterns.map((p) => expandString(p, vars));
  return files.find((f) => globs.some((g) => fnmatch(g, f)));
}

function changesClause(c: PathsClause, id: string, s: Scope, sc: Scenario): ClauseTrace {
  const source = c.paths.join(', ') + (c.compareTo ? ` (compare_to: ${c.compareTo})` : '');
  const base = { kind: 'changes' as const, source };
  if (sc.overrides && id in sc.overrides) return { ...base, result: sc.overrides[id]!, note: 'override' };
  if (!c.compareTo) {
    // Without compare_to GitLab has no diff for these pipelines and treats changes as satisfied.
    if (sc.refType === 'tag') return { ...base, result: true, note: 'always true for tag pipelines' };
    const diffable = sc.source === 'push' || sc.source === 'merge_request_event' || sc.source === 'external_pull_request_event';
    if (!diffable) return { ...base, result: true, note: `always true for ${sc.source} pipelines` };
    if (sc.source === 'push' && ZERO_SHA.test(s.expanded.CI_COMMIT_BEFORE_SHA ?? '')) {
      return { ...base, result: true, note: 'always true for a new branch' };
    }
  }
  if (!sc.changedFiles) return { ...base, result: true, note: 'assumed true (no changed-files list given)' };
  const hit = firstMatch(c.paths, sc.changedFiles, s.expanded);
  return { ...base, result: hit !== undefined, note: hit ? `matched ${hit}` : 'no changed file matched' };
}

function existsClause(c: PathsClause, id: string, s: Scope, sc: Scenario): ClauseTrace {
  const base = { kind: 'exists' as const, source: c.paths.join(', ') + (c.project ? ` (project: ${c.project})` : '') };
  if (sc.overrides && id in sc.overrides) return { ...base, result: sc.overrides[id]!, note: 'override' };
  if (c.project) return { ...base, result: true, note: 'assumed true (exists:project not checked)' };
  if (!sc.repoFiles) return { ...base, result: true, note: 'assumed true (no repo file list given)' };
  const hit = firstMatch(c.paths, sc.repoFiles, s.expanded);
  return { ...base, result: hit !== undefined, note: hit ? `found ${hit}` : 'no file matched' };
}

function ifClause(expr: string, vars: Record<string, string>, sc: Scenario): ClauseTrace {
  const r = evaluateExpression(expr, vars, sc.inputs ?? {});
  const t: ClauseTrace = { kind: 'if', source: expr, expanded: r.expanded, result: r.result };
  if (r.warnings.length) t.warnings = r.warnings;
  if (r.error) t.error = r.error;
  return t;
}

/** First-match rule evaluation. */
export function ruleText(r: Rule): string {
  const parts: string[] = [];
  if (r.if !== undefined) parts.push(`if: ${r.if}`);
  if (r.changes) parts.push(`changes: [${r.changes.paths.join(', ')}]`);
  if (r.exists) parts.push(`exists: [${r.exists.paths.join(', ')}]`);
  return parts.join(', ') || '(no conditions)';
}

function evaluateRules(rules: Rule[], prefix: string, s: Scope, sc: Scenario) {
  const traces: RuleTrace[] = [];
  let matched: { rule: Rule; index: number } | undefined;
  rules.forEach((rule, index) => {
    if (matched) { traces.push({ index, evaluated: false, matched: false, text: ruleText(rule), clauses: [], when: rule.when }); return; }
    const clauses: ClauseTrace[] = [];
    if (rule.if !== undefined) clauses.push(ifClause(rule.if, s.raw, sc));
    if (rule.changes) clauses.push(changesClause(rule.changes, `${prefix}#${index}.changes`, s, sc));
    if (rule.exists) clauses.push(existsClause(rule.exists, `${prefix}#${index}.exists`, s, sc));
    const ok = clauses.every((c) => c.result);
    traces.push({ index, evaluated: true, matched: ok, text: ruleText(rule), clauses, when: rule.when });
    if (ok) matched = { rule, index };
  });
  return { traces, matched };
}

// ---------------------------------------------------------------------------- only / except

/** ActiveSupport String#pluralize for the pipeline source names that occur. */
const pluralize = (s: string) => (/(s|sh|ch|x)$/.test(s) ? `${s}es` : `${s}s`);

/** Build::Policy::Refs#satisfied_by? */
function refMatches(pattern: string, sc: Scenario, vars: Record<string, string>): { result: boolean; note?: string } {
  const [p, path] = ((i) => (i < 0 ? [pattern, undefined] : [pattern.slice(0, i), pattern.slice(i + 1)]))(pattern.indexOf('@'));
  if (path !== undefined && path !== vars.CI_PROJECT_PATH) return { result: false, note: `project ${path} ≠ ${vars.CI_PROJECT_PATH}` };
  if (sc.refType === 'tag' && p === 'tags') return { result: true };
  if (sc.refType === 'branch' && p === 'branches') return { result: true };
  const source = sc.source.replace(/_event$/, '');
  if (p === source || p === pluralize(source)) return { result: true };
  if (sc.refType === 'mr') return { result: false }; // names/regexes only checked for branch/tag pipelines
  const re = parseSlashPattern(p);
  if (re) {
    const t = translateRegex(re[0], re[1]);
    return t.re ? { result: t.re.test(sc.ref) } : { result: false, note: t.error };
  }
  return { result: p === sc.ref };
}

function policyClauses(p: Policy, id: string, s: Scope, sc: Scenario): ClauseTrace[] {
  const vars = s.raw;
  const out: ClauseTrace[] = [];
  if (p.refs) {
    const hits = p.refs.map((r) => ({ r, ...refMatches(r, sc, vars) }));
    const hit = hits.find((h) => h.result);
    out.push({
      kind: 'refs', source: p.refs.join(', '), result: !!hit,
      note: hit ? `matched ${hit.r} (ref ${sc.ref})` : `ref ${sc.ref}, source ${sc.source}`,
    });
  }
  if (p.variables) {
    const evals = p.variables.map((e) => ifClause(e, vars, sc));
    out.push({
      kind: 'variables', source: p.variables.join(' | '), result: evals.some((e) => e.result),
      expanded: evals.map((e) => e.expanded).join(' | '),
    });
  }
  if (p.changes) out.push(changesClause(p.changes, `${id}.changes`, s, sc));
  if (p.kubernetes) out.push({ kind: 'kubernetes', source: p.kubernetes, result: true, note: 'assumed true (deprecated)' });
  return out;
}

// ---------------------------------------------------------------------------- jobs


interface Draft extends JobResult { declaredNeeds?: Need[] }

/** inherit:variables filter (also applied to workflow rule variables, see chain/seed.rb). */
function inheritFilter<T>(vars: Record<string, T>, inherit: Job['inheritVariables']): Record<string, T> {
  if (inherit === true) return vars;
  if (inherit === false) return {};
  return Object.fromEntries(Object.entries(vars).filter(([k]) => inherit.includes(k)));
}

const RULES_FAILURE = 'Pipeline will not run for the selected trigger. ' +
  'The rules configuration prevented any jobs from being added to the pipeline.';

function evaluateJob(job: Job, sc: Scenario, wfVars: Record<string, string>, hasWorkflowRules: boolean): Draft {
  const layers = (ruleVars?: Record<string, string>): VarLayer[] =>
    [sc.variables, job.inheritedVariables, inheritFilter(wfVars, job.inheritVariables), job.variables, ruleVars, sc.userVariables];
  const scope = scopeOf(...layers());
  const draft: Draft = {
    name: job.name, stage: job.stage, line: job.line, included: false, when: job.when ?? 'on_success',
    allowFailure: false, blocking: false, variables: scope.expanded, reason: '', trace: { mode: 'rules', rules: [] },
  };
  if (job.trigger) draft.trigger = job.trigger;
  if (job.dependencies) draft.dependencies = job.dependencies;
  let rule: Rule | undefined;

  if (job.rules) {
    const { traces, matched } = evaluateRules(job.rules, job.name, scope, sc);
    draft.trace = { mode: 'rules', rules: traces, matchedIndex: matched?.index };
    if (!matched) {
      draft.when = 'never';
      draft.reason = 'no rule matched';
    } else {
      rule = matched.rule;
      draft.when = rule.when ?? job.when ?? 'on_success';
      draft.reason = draft.when === 'never' ? `rule #${matched.index} → when: never` : `rule #${matched.index} matched`;
    }
  } else if (!job.only && !job.except && hasWorkflowRules) {
    // workflow:rules removes the only/except defaults (entry/processable.rb)
    draft.trace = { mode: 'only/except', rules: [], only: [], except: [] };
    draft.reason = 'no rules (workflow:rules disables the only default)';
  } else {
    const defaultOnly = !job.only && !hasWorkflowRules;
    const onlyPolicy = job.only ?? (defaultOnly ? { refs: ['branches', 'tags'] } : undefined);
    const only = onlyPolicy ? policyClauses(onlyPolicy, `${job.name}#only`, scope, sc) : [];
    const except = job.except ? policyClauses(job.except, `${job.name}#except`, scope, sc) : [];
    draft.trace = { mode: 'only/except', rules: [], only, except, defaultOnly };
    const onlyOk = only.every((c) => c.result);
    const exceptHit = except.some((c) => c.result);
    if (!onlyOk) { draft.when = 'never'; draft.reason = defaultOnly ? 'no rules: default only (branches, tags) not met' : 'only: not satisfied'; }
    else if (exceptHit) { draft.when = 'never'; draft.reason = 'except: matched'; }
    else draft.reason = defaultOnly && !job.except ? 'no rules (default: branches, tags)' : 'only/except satisfied';
  }

  draft.included = draft.when !== 'never';
  if (rule?.variables) draft.variables = resolveVariables(...layers(rule.variables));
  // Entry::Job#ignored?: allow_failure: {exit_codes} counts as false; default true only for job-level manual.
  const staticAllowFailure = job.allowFailure === undefined ? job.when === 'manual' : job.allowFailure === true;
  draft.allowFailure = rule?.allow_failure ?? staticAllowFailure;
  draft.blocking = draft.included && draft.when === 'manual' && !draft.allowFailure;
  if (draft.when === 'delayed') draft.startIn = rule?.start_in ?? job.startIn;
  draft.declaredNeeds = rule?.needs ?? job.needs;
  return draft;
}

// ---------------------------------------------------------------------------- pipeline

export function evaluatePipeline(cfg: NormalizedConfig, sc: Scenario): PipelineResult {
  const errors = [...cfg.errors];
  const warnings = [...cfg.warnings];

  // workflow
  const wfLayers: VarLayer[] = [sc.variables, cfg.variables, sc.userVariables];
  const workflow: WorkflowResult = { created: true, rules: [], reason: 'no workflow:rules', variables: {}, name: cfg.workflow.name };
  if (cfg.workflow.rules) {
    const { traces, matched } = evaluateRules(cfg.workflow.rules, 'workflow', scopeOf(...wfLayers), sc);
    workflow.rules = traces;
    workflow.matchedIndex = matched?.index;
    if (!matched) { workflow.created = false; workflow.reason = 'no workflow rule matched → no pipeline'; }
    else if (matched.rule.when === 'never') { workflow.created = false; workflow.reason = `workflow rule #${matched.index} → when: never`; }
    else { workflow.reason = `workflow rule #${matched.index} matched`; workflow.variables = matched.rule.variables ?? {}; }
    if (!workflow.created) errors.push('Pipeline filtered out by workflow rules.');
  }
  if (workflow.name) {
    const wfVarDefs: Record<string, VarDef> = Object.fromEntries(Object.entries(workflow.variables).map(([k, v]) => [k, { value: v, expand: true }]));
    workflow.name = expandString(workflow.name, resolveVariables(sc.variables, cfg.variables, wfVarDefs, sc.userVariables));
  }

  const hasWorkflowRules = cfg.workflow.rules !== undefined;
  const drafts = cfg.jobs.map((j) => evaluateJob(j, sc, workflow.variables, hasWorkflowRules));
  const included = new Set(drafts.filter((d) => d.included).map((d) => d.name));

  // Static needs/dependencies checks live in normalize; here: jobs excluded by rules.
  const jobs: JobResult[] = drafts.map(({ declaredNeeds, ...d }) => {
    if (declaredNeeds) {
      d.needs = declaredNeeds.filter((n) => {
        if (n.pipeline || n.project) return true; // cross-pipeline: not checked
        if (included.has(n.job)) return true;
        if (!n.optional && d.included && cfg.jobs.some((j) => j.name === n.job)) {
          errors.push(`'${d.name}' job needs '${n.job}' job, but '${n.job}' does not exist in the pipeline. ` +
            'This might be because of the only, except, or rules keywords. To need a job that sometimes does not exist in the pipeline, use needs:optional.');
        }
        return false;
      });
    }
    if (d.included && d.dependencies) {
      for (const dep of d.dependencies) if (!included.has(dep)) warnings.push(`${d.name}: dependency ${dep} is not in the pipeline`);
    }
    return d;
  });

  let created = workflow.created && errors.length === 0;
  if (created) {
    const live = jobs.filter((j) => j.included);
    if (live.length === 0) {
      created = false;
      errors.push(RULES_FAILURE);
    } else if (live.every((j) => j.stage === '.pre' || j.stage === '.post')) {
      created = false;
      errors.push(`${RULES_FAILURE} (only .pre/.post jobs left)`);
    }
  }
  return {
    created, invalidConfig: cfg.errors.length > 0, includes: cfg.includes,
    stages: cfg.stages, workflow, jobs, errors, warnings,
  };
}
