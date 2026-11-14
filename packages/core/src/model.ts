// Normalized CI configuration model (output of normalize/, input of the evaluator).

export type When = 'on_success' | 'on_failure' | 'manual' | 'delayed' | 'always' | 'never';
export const WHEN_VALUES: readonly When[] = ['on_success', 'on_failure', 'manual', 'delayed', 'always', 'never'];

export interface VarDef {
  value: string;
  /** false => `$X` inside value is not expanded. */
  expand: boolean;
  description?: string;
  options?: string[];
}

export interface Need {
  job: string;
  optional: boolean;
  artifacts: boolean;
  /** needs:pipeline (parent-pipeline artifacts). */
  pipeline?: string;
  /** needs:project (cross-project; Premium). */
  project?: string;
  ref?: string;
  parallel?: unknown;
}

export interface PathsClause {
  paths: string[];
  /** changes:compare_to */
  compareTo?: string;
  /** exists:project / exists:ref */
  project?: string;
  ref?: string;
}

export interface Rule {
  if?: string;
  changes?: PathsClause;
  exists?: PathsClause;
  when?: When;
  allow_failure?: boolean;
  variables?: Record<string, string>;
  needs?: Need[];
  start_in?: string;
  interruptible?: boolean;
}

/** Legacy only/except policy. */
export interface Policy {
  refs?: string[];
  variables?: string[];
  changes?: PathsClause;
  kubernetes?: string;
}

export interface Trigger {
  kind: 'child' | 'multi-project';
  /** Child pipeline include(s); `dynamic` when generated from an artifact. */
  include?: unknown;
  dynamic?: boolean;
  project?: string;
  branch?: string;
  strategy?: string;
  /** trigger:forward (defaults: yaml_variables true, pipeline_variables false). */
  forward?: { yaml_variables?: boolean; pipeline_variables?: boolean };
}

export interface ParallelInfo {
  /** Job name as written. */
  group: string;
  /** 1-based (CI_NODE_INDEX). */
  instance: number;
  /** CI_NODE_TOTAL */
  total: number;
  /** parallel:matrix values of this instance. */
  matrix?: Record<string, string>;
}

export interface Job {
  name: string;
  stage: string;
  line?: number;
  when?: When;
  rules?: Rule[];
  only?: Policy;
  except?: Policy;
  /** undefined => stage ordering; [] => starts immediately. */
  needs?: Need[];
  dependencies?: string[];
  allowFailure?: boolean | { exit_codes: number[] };
  startIn?: string;
  /** Job-level `variables:`. */
  variables: Record<string, VarDef>;
  /** Global variables after `inherit:variables` filtering. */
  inheritedVariables: Record<string, VarDef>;
  /** `inherit:variables` as written (also filters workflow rule variables). */
  inheritVariables: boolean | string[];
  trigger?: Trigger;
  /** Instance of a `parallel:` job (expanded by the normalizer). */
  parallel?: ParallelInfo;
  /** Fully merged job hash (after extends, !reference, default). */
  raw: Record<string, unknown>;
}

export interface Workflow {
  name?: string;
  rules?: Rule[];
}

export type IncludeType = 'local' | 'project' | 'remote' | 'template' | 'component' | 'artifact';

/** One `include:` entry (one per file for include:project with a file list). */
export interface IncludeRef {
  type: IncludeType;
  /** Display form, e.g. `grp/templates:ci.yml@v2`. */
  target: string;
  /** Path inside its repository (local/project), URL, template name or component file. */
  file: string;
  /** Lookup key in the user-provided file store, e.g. `local:ci/a.yml`, `project:grp/tpl:ci.yml`. */
  key: string;
  /** File that declared this include (`.gitlab-ci.yml` or the parent's target). */
  from: string;
  /** Content was provided (uploaded/pasted) and merged. */
  resolved: boolean;
  /** Not included for this scenario (include:rules), with the reason. */
  skipped?: string;
  error?: string;
  inputs?: Record<string, unknown>;
  /** Local wildcard pattern (matched against provided local files). */
  wildcard?: boolean;
}

export interface NormalizedConfig {
  /** Every include: entry; unresolved ones mean jobs/templates may be missing. */
  includes: IncludeRef[];
  stages: string[];
  variables: Record<string, VarDef>;
  workflow: Workflow;
  jobs: Job[];
  header?: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}
