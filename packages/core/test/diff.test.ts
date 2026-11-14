import { describe, expect, it } from 'vitest';
import { analyze, diffPipelines } from '../src/index.js';
import { makeScenario } from '../src/scenario/presets.js';

const main = makeScenario('push', { branch: 'main' });
const feat = makeScenario('push', { branch: 'feature/x' });
const tag = makeScenario('tag', { tag: 'v1.0.0' });
const diff = (yml: string, a = main, b = feat) => diffPipelines(analyze(yml, a), analyze(yml, b));
const row = (d: ReturnType<typeof diffPipelines>, name: string) => d.jobs.find((j) => j.name === name)!;

describe('diffPipelines', () => {
  it('reports no changes for identical scenarios', () => {
    const d = diff('a: {script: x}', main, main);
    expect(d.changed).toBe(0);
    expect(row(d, 'a').changes).toEqual([]);
  });

  it('reports a job that runs on one side only as an "included" change', () => {
    const d = diff('a: {script: x, rules: [{if: $CI_COMMIT_BRANCH == "main"}]}\nb: {script: x}');
    expect(row(d, 'a')).toMatchObject({ changes: ['included'], a: { included: true }, b: { included: false } });
    expect(row(d, 'b').changes).toEqual([]);
    expect(d.changed).toBe(1);
  });

  it('compares when / blocking only for jobs that run on both sides', () => {
    const d = diff('a: {script: x, rules: [{if: $CI_COMMIT_BRANCH == "main", when: manual}, {when: on_success}]}');
    expect(row(d, 'a').changes).toEqual(expect.arrayContaining(['when', 'blocking']));
    expect(row(d, 'a').changes).not.toContain('included');
  });

  it('detects changed needs (stage order vs explicit list)', () => {
    const yml = 'stages: [b, t]\nx: {stage: b, script: x}\na: {stage: t, script: x, rules: [{if: $CI_COMMIT_BRANCH == "main", needs: [x]}, {when: on_success}]}';
    const d = diff(yml);
    expect(row(d, 'a')).toMatchObject({ changes: ['needs'], a: { needs: ['x'] }, b: { needs: undefined } });
  });

  it('treats every job as not running when that side creates no pipeline', () => {
    const yml = 'workflow: {rules: [{if: $CI_COMMIT_TAG}]}\na: {script: x}';
    const d = diff(yml, tag, main);
    expect(d.created).toEqual([true, false]);
    expect(row(d, 'a')).toMatchObject({ changes: ['included'], b: { included: false } });
  });
});
