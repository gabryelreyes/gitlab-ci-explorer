export * from './model.js';
export { loadCiYaml, ReferenceTag, type LoadedYaml } from './yaml/load.js';
export { normalizeConfig } from './normalize/index.js';
export { evaluateExpression, parseExpression, type ExpressionResult, type ParsedExpression } from './expr/index.js';
export * from './evaluate/index.js';
export * from './scenario/presets.js';

import { evaluatePipeline, type PipelineResult } from './evaluate/index.js';
import { normalizeConfig } from './normalize/index.js';
import type { Scenario } from './scenario/presets.js';
import { loadCiYaml } from './yaml/load.js';

/** One-shot: YAML text + scenario → pipeline result. */
export function analyze(yaml: string, scenario: Scenario, file?: string): PipelineResult {
  return evaluatePipeline(normalizeConfig(loadCiYaml(yaml, file)), scenario);
}
export { extractGates, type Gate } from './gates.js';
export { pipelineGraph, relatives, type GraphEdge, type PipelineGraph } from './graph.js';
export { diffPipelines, type JobDiff, type JobField, type JobState, type PipelineDiff } from './diff.js';
