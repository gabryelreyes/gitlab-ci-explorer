import { describe, expect, it } from 'vitest';
import { analyze, pipelineGraph, relatives, type GraphEdge } from '../src/index.js';
import { makeScenario } from '../src/scenario/presets.js';

const push = makeScenario('push', { branch: 'main' });
const graphOf = (yml: string) => pipelineGraph(analyze(yml, push));
const e = (from: string, to: string, kind: GraphEdge['kind']) => ({ from, to, kind });
const pick = (edges: GraphEdge[]) => edges.map(({ from, to, kind }) => ({ from, to, kind }));

const S = 'stages: [build, test, deploy]\n';

describe('pipelineGraph', () => {
  it('draws one edge per explicit need', () => {
    const g = graphOf(`${S}a: {stage: build, script: x}\nb: {stage: test, script: x, needs: [a]}`);
    expect(pick(g.edges)).toEqual([e('a', 'b', 'needs')]);
  });

  it('stage-order jobs link only to the previous stage when that stage waits for everything before it', () => {
    const g = graphOf(`${S}a: {stage: build, script: x}\nb: {stage: test, script: x}\nc: {stage: deploy, script: x}`);
    expect(pick(g.edges)).toEqual([e('a', 'b', 'stage'), e('b', 'c', 'stage')]);
  });

  it('keeps the stage edge to an earlier job that a needs-job skipped', () => {
    const g = graphOf(`${S}a: {stage: build, script: x}\nb: {stage: test, script: x, needs: []}\nc: {stage: deploy, script: x}`);
    expect(pick(g.edges)).toEqual(expect.arrayContaining([e('a', 'c', 'stage'), e('b', 'c', 'stage')]));
    expect(g.edges.filter((x) => x.to === 'b')).toEqual([]);
  });

  it('supports needs within the same stage', () => {
    const g = graphOf(`${S}a: {stage: build, script: x}\nb: {stage: build, script: x, needs: [a]}`);
    expect(pick(g.edges)).toEqual([e('a', 'b', 'needs')]);
  });

  it('marks a need on an excluded job as missing and gives excluded jobs no stage edges', () => {
    const g = graphOf(`${S}a: {stage: build, script: x, rules: [{when: never}]}\nb: {stage: test, script: x, needs: [a]}\nc: {stage: deploy, script: x}`);
    expect(pick(g.edges)).toEqual(expect.arrayContaining([e('a', 'b', 'missing'), e('b', 'c', 'stage')]));
    expect(g.edges.some((x) => x.from === 'a' && x.kind !== 'missing')).toBe(false);
  });

  it('carries need options and ignores cross-pipeline needs', () => {
    const g = graphOf(`${S}a: {stage: build, script: x}\nb: {stage: test, script: x, needs: [{job: a, artifacts: false}, {pipeline: $PARENT_PIPELINE_ID, job: p}]}`);
    expect(g.edges).toEqual([{ from: 'a', to: 'b', kind: 'needs', artifacts: false, optional: false }]);
  });
});

describe('relatives', () => {
  it('returns all upstream and downstream jobs through needs and stage order', () => {
    const g = graphOf(`${S}a: {stage: build, script: x}\nz: {stage: build, script: x}\nb: {stage: test, script: x, needs: [a]}\nc: {stage: deploy, script: x}`);
    const r = relatives(g, 'b');
    expect([...r.up].sort()).toEqual(['a']);
    expect([...r.down].sort()).toEqual(['c']);
    expect([...relatives(g, 'c').up].sort()).toEqual(['a', 'b', 'z']);
  });

  it('does not follow missing edges', () => {
    const g = graphOf(`${S}a: {stage: build, script: x, rules: [{when: never}]}\nb: {stage: test, script: x, needs: [a]}`);
    expect(relatives(g, 'b').up.size).toBe(0);
  });
});
