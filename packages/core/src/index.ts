export * from './model.js';
export { loadCiYaml, ReferenceTag, type LoadedYaml } from './yaml/load.js';
export { normalizeConfig } from './normalize/index.js';
export { evaluateExpression, parseExpression, type ExpressionResult, type ParsedExpression } from './expr/index.js';
export * from './evaluate/index.js';
export * from './scenario/presets.js';

import type { PipelineResult } from './evaluate/index.js';
import { evaluateTree } from './downstream.js';
import { resolveConfig, type ResolveOptions } from './include/resolve.js';
import type { NormalizedConfig } from './model.js';
import { normalizeConfig } from './normalize/index.js';
import type { Scenario } from './scenario/presets.js';
import { loadCiYaml } from './yaml/load.js';

/** YAML text + provided include files + scenario (include rules/paths, pipeline inputs) → normalized config. */
export function buildConfig(yaml: string, opts: ResolveOptions & { file?: string } = {}): NormalizedConfig {
  return normalizeConfig(resolveConfig(loadCiYaml(yaml, opts.file), opts));
}

/** One-shot: YAML text + scenario → pipeline result (with child pipelines). */
export function analyze(yaml: string, scenario: Scenario, file?: string, files?: Record<string, string>): PipelineResult {
  return evaluateTree(buildConfig(yaml, { file, files, scenario }), scenario, { files });
}
export { extractGates, type Gate } from './gates.js';
export { pipelineGraph, relatives, type GraphEdge, type PipelineGraph } from './graph.js';
export { diffPipelines, type JobDiff, type JobField, type JobState, type PipelineDiff } from './diff.js';
export { resolveConfig, MAIN_FILE, type ResolveOptions, type ResolvedYaml } from './include/resolve.js';
export { validateInputs, interpolateFile, type InputSpec } from './include/interpolate.js';
export { evaluateTree, childScenario, flattenJobs, findJob, allIncludes, PATH_SEP, type FlatJob, type TreeOptions } from './downstream.js';
