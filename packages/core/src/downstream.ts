// Child pipelines (trigger:include): each included trigger job gets its downstream pipeline evaluated.
// Bridge#yaml_for_downstream → `{include: <trigger:include>}`; source parent_pipeline; YAML variables
// forwarded per trigger:forward (Variables::Downstream::Generator); max 2 nested levels.
import { evaluatePipeline, type JobResult, type PipelineResult } from './evaluate/index.js';
import { resolveConfig } from './include/resolve.js';
import type { IncludeRef, NormalizedConfig } from './model.js';
import { normalizeConfig } from './normalize/index.js';
import type { Scenario } from './scenario/presets.js';

/** CreateDownstreamPipelineService::MAX_NESTED_CHILDREN */
const MAX_NESTED_CHILDREN = 2;
export const PATH_SEP = ' › ';

export interface TreeOptions { files?: Record<string, string> }

export function childScenario(parent: Scenario, job: JobResult): Scenario {
  const fwd = job.trigger?.forward ?? {};
  const yaml = fwd.yaml_variables === false ? {} : (job.yamlVariables ?? {});
  const user = parent.userVariables ?? {};
  return {
    ...parent,
    kind: 'parent_pipeline',
    source: 'parent_pipeline',
    variables: { ...parent.variables, CI_PIPELINE_SOURCE: 'parent_pipeline' },
    // Project/group variables still apply; forwarded variables become the child's pipeline variables.
    userVariables: { ...user, ...yaml, ...(fwd.pipeline_variables ? user : {}) },
    inputs: undefined,
    diffSource: parent.diffSource ?? parent.source,
  };
}

/** Config of the child pipeline triggered by `job`. */
export function childConfig(job: JobResult, sc: Scenario, parentJobs: string[], opts: TreeOptions, label = job.name): NormalizedConfig {
  const main = { body: { include: job.trigger!.include }, lines: {}, errors: [], warnings: [] };
  return normalizeConfig(resolveConfig(main, { files: opts.files, scenario: sc, label, parentJobs }));
}

/** evaluatePipeline + downstream child pipelines of included trigger jobs. */
export function evaluateTree(cfg: NormalizedConfig, sc: Scenario, opts: TreeOptions = {}, depth = 0, prefix = ''): PipelineResult {
  const r = evaluatePipeline(cfg, sc);
  if (!r.created) return r;
  const running = r.jobs.filter((j) => j.included).map((j) => j.name);
  for (const j of r.jobs) {
    if (!j.included || j.trigger?.kind !== 'child') continue;
    if (depth >= MAX_NESTED_CHILDREN) { j.downstream = { error: 'You reached the maximum depth of child pipelines' }; continue; }
    const csc = childScenario(sc, j);
    const path = prefix + j.name;
    j.downstream = { scenario: csc, result: evaluateTree(childConfig(j, csc, running, opts, path), csc, opts, depth + 1, path + PATH_SEP) };
  }
  return r;
}

export interface FlatJob { path: string; job: JobResult; /** Its pipeline was created (all ancestors too). */ created: boolean; depth: number }

/** Jobs of the pipeline and its children; child jobs are addressed `trigger › job`. */
export function flattenJobs(r: PipelineResult, prefix = '', created = r.created, depth = 0): FlatJob[] {
  return r.jobs.flatMap((job) => {
    const path = prefix + job.name;
    const self: FlatJob = { path, job, created: created && r.created, depth };
    const d = job.downstream?.result;
    return d ? [self, ...flattenJobs(d, path + PATH_SEP, created && r.created && job.included, depth + 1)] : [self];
  });
}

export function findJob(r: PipelineResult, path: string | undefined): JobResult | undefined {
  return path === undefined ? undefined : flattenJobs(r).find((f) => f.path === path)?.job;
}

/** Includes of the pipeline and all child pipelines (a child's own entries have `from` = trigger job path). */
export function allIncludes(r: PipelineResult): IncludeRef[] {
  return [...r.includes, ...r.jobs.flatMap((j) => (j.downstream?.result ? allIncludes(j.downstream.result) : []))];
}
