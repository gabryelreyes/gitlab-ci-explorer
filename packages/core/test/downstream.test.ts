import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allIncludes, buildConfig, evaluateTree, findJob, flattenJobs, makeScenario, type PipelineResult, type Scenario,
} from '../src/index.js';
import { runCli } from '../src/cli-lib.js';

const push = makeScenario('push', { branch: 'main' });
const tree = (main: string, files: Record<string, string> = {}, sc: Scenario = push): PipelineResult =>
  evaluateTree(buildConfig(main, { files, scenario: sc }), sc, { files });
const child = (r: PipelineResult, job: string) => r.jobs.find((j) => j.name === job)!.downstream!;

const CHILD = `
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "parent_pipeline"
fw: {script: make, rules: [{if: $TARGET == "esp32"}]}
always: {script: x}
`;

describe('child pipelines (trigger:include)', () => {
  it('evaluates the child config as a parent_pipeline pipeline', () => {
    const r = tree('trig: {trigger: {include: ci/child.yml}}', { 'local:ci/child.yml': CHILD });
    const d = child(r, 'trig');
    expect(d.error).toBeUndefined();
    expect(d.result!.created).toBe(true);
    expect(d.scenario!.source).toBe('parent_pipeline');
    expect(d.result!.jobs.map((j) => [j.name, j.included])).toEqual([['fw', false], ['always', true]]);
  });

  it('forwards the trigger job YAML variables (global + job + matrix) to the child', () => {
    const r = tree(`
variables: {G: g}
trig:
  variables: {LOCAL: $G-x}
  trigger: {include: c.yml}
  parallel: {matrix: [{TARGET: [stm32, esp32]}]}
`, { 'local:c.yml': CHILD });
    const esp = child(r, 'trig: [esp32]');
    expect(esp.scenario!.userVariables).toMatchObject({ G: 'g', LOCAL: 'g-x', TARGET: 'esp32' });
    expect(esp.scenario!.userVariables).not.toHaveProperty('CI_NODE_INDEX');
    expect(esp.result!.jobs.find((j) => j.name === 'fw')!.included).toBe(true);
    expect(child(r, 'trig: [stm32]').result!.jobs.find((j) => j.name === 'fw')!.included).toBe(false);
  });

  it('forward:yaml_variables: false / pipeline_variables: true', () => {
    const sc = { ...push, userVariables: { P: 'pipe', V: 'pipe' } };
    const main = (fwd: string) => `variables: {V: yaml}\ntrig: {trigger: {include: c.yml, forward: {${fwd}}}}`;
    expect(child(tree(main('yaml_variables: false'), { 'local:c.yml': CHILD }, sc), 'trig').scenario!.userVariables).toEqual({ P: 'pipe', V: 'pipe' });
    // default: YAML variables win over project/pipeline variables in the child
    expect(child(tree(main(''), { 'local:c.yml': CHILD }, sc), 'trig').scenario!.userVariables).toMatchObject({ V: 'yaml' });
    expect(child(tree(main('pipeline_variables: true'), { 'local:c.yml': CHILD }, sc), 'trig').scenario!.userVariables).toMatchObject({ V: 'pipe' });
  });

  it('missing child file: standalone, listed as an include of the trigger job', () => {
    const r = tree('trig: {trigger: {include: [{local: c.yml}, {project: g/p, file: t.yml}]}}');
    const d = child(r, 'trig');
    expect(d.result!.includes.map((i) => [i.key, i.from, i.resolved])).toEqual([['local:c.yml', 'trig', false], ['project:g/p:t.yml', 'trig', false]]);
    expect(allIncludes(r).map((i) => i.key)).toEqual(['local:c.yml', 'project:g/p:t.yml']);
  });

  it('dynamic child pipeline: artifact include keyed by job and path', () => {
    const main = `
gen: {stage: build, script: gen > out.yml, artifacts: {paths: [out.yml]}}
trig: {stage: test, trigger: {include: [{artifact: out.yml, job: gen}]}}
`;
    expect(child(tree(main), 'trig').result!.includes[0]).toMatchObject({ type: 'artifact', key: 'artifact:gen:out.yml', resolved: false });
    const r = tree(main, { 'artifact:gen:out.yml': CHILD });
    expect(child(r, 'trig').result!.jobs.map((j) => j.name)).toEqual(['fw', 'always']);
  });

  it('artifact include errors', () => {
    expect(child(tree('trig: {trigger: {include: [{artifact: o.yml}]}}'), 'trig').result!.errors)
      .toContain('Job must be provided when including configs from artifacts');
    expect(child(tree('trig: {trigger: {include: [{artifact: o.yml, job: nope}]}}'), 'trig').result!.errors)
      .toContain('Job `nope` not found in parent pipeline or does not have artifacts!');
  });

  it('trigger:include allows at most 3 entries', () => {
    const cfg = buildConfig('trig: {trigger: {include: [a.yml, b.yml, c.yml, d.yml]}}', { scenario: push });
    expect(cfg.errors).toContain('jobs:trig:trigger:include config is too long (maximum is 3)');
  });

  it('nests up to 2 levels; the third level fails', () => {
    const files = {
      'local:l1.yml': 'workflow: {rules: [{when: always}]}\nt2: {trigger: {include: l2.yml}}',
      'local:l2.yml': 't3: {trigger: {include: l3.yml}}',
      'local:l3.yml': 'deep: {script: x}',
    };
    const r = tree('t1: {trigger: {include: l1.yml}}', files);
    const l2 = child(child(r, 't1').result!, 't2');
    expect(l2.result!.created).toBe(true);
    expect(child(l2.result!, 't3').error).toMatch(/maximum depth of child pipelines/);
  });

  it('changes: in a child uses the parent pipeline\'s changed files', () => {
    const files = { 'local:c.yml': 'workflow: {rules: [{when: always}]}\nj: {script: x, rules: [{changes: [src/**]}]}' };
    const sc = { ...push, changedFiles: ['docs/a.md'] };
    expect(child(tree('trig: {trigger: {include: c.yml}}', files, sc), 'trig').result!.jobs[0]!.included).toBe(false);
  });

  it('no child when the trigger job is excluded or the parent is not created', () => {
    expect(tree('trig: {trigger: {include: c.yml}, rules: [{when: never}]}\nj: {script: x}').jobs[0]!.downstream).toBeUndefined();
  });

  it('flattenJobs / findJob address child jobs as "trigger › job"', () => {
    const r = tree('trig: {trigger: {include: c.yml}}', { 'local:c.yml': CHILD });
    expect(flattenJobs(r).map((f) => f.path)).toEqual(['trig', 'trig › fw', 'trig › always']);
    expect(findJob(r, 'trig › always')?.name).toBe('always');
  });
});

describe('diff includes child jobs', () => {
  it('compares child jobs by path', async () => {
    const { diffPipelines } = await import('../src/index.js');
    // YAML TARGET: $T is expanded in the parent, then forwarded.
    const main = 'variables: {T: stm32, TARGET: $T}\ntrig: {trigger: {include: c.yml}}';
    const files = { 'local:c.yml': CHILD };
    const a = tree(main, files);
    const b = tree(main, files, { ...push, userVariables: { T: 'esp32' } });
    const d = diffPipelines(a, b);
    expect(d.jobs.map((j) => j.name)).toEqual(['trig', 'trig › fw', 'trig › always']);
    expect(d.jobs.find((j) => j.name === 'trig › fw')!.changes).toEqual(['included']);
  });
});

describe('parallel-child-demo fixture', () => {
  const dir = new URL('./fixtures/parallel-child-demo/', import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');
  const files = { 'local:ci/hil-child.yml': read('ci/hil-child.yml'), 'artifact:gen-hil-config:hil-generated.yml': read('hil-generated.yml') };

  it('push to main: matrix builds, per-target HIL children, dynamic child', () => {
    const r = tree(read('.gitlab-ci.yml'), files);
    expect(r.errors).toEqual([]);
    expect(r.jobs.find((j) => j.name === 'hil: [esp32]')!.needs!.map((n) => n.job)).toEqual(['build: [esp32, release]']);
    expect(child(r, 'hil: [stm32f4]').result!.jobs.filter((j) => j.included).map((j) => j.name)).toEqual(['flash', 'smoke', 'low-power']);
    expect(child(r, 'hil: [esp32]').result!.jobs.filter((j) => j.included).map((j) => j.name)).toEqual(['flash', 'smoke']);
    expect(child(r, 'flash-matrix').result!.jobs.map((j) => j.name)).toEqual(['flash-board-1', 'flash-board-2']);
  });

  it('CLI prints the child pipelines', () => {
    const f = fileURLToPath(new URL('.gitlab-ci.yml', dir));
    const out = runCli([f, '--include-dir', fileURLToPath(dir)]).out;
    expect(out).toContain('⤷ child pipeline of hil: [esp32]: CREATED');
    expect(out).toMatch(/standalone mode: .* 1 include/);
  });

describe('include:artifact producers', () => {
  it('accepts a parent job whose name contains a colon', () => {
    const main = `
gen:config: {stage: build, script: x, artifacts: {paths: [out.yml]}}
trig: {stage: test, trigger: {include: [{artifact: out.yml, job: "gen:config"}]}}
`;
    const d = child(tree(main, { 'artifact:gen:config:out.yml': CHILD }), 'trig');
    expect(d.result!.errors).toEqual([]);
    expect(d.result!.jobs.map((j) => j.name)).toEqual(['fw', 'always']);
  });

  it('rejects a parent job without artifacts', () => {
    const main = `
gen: {stage: build, script: x}
trig: {stage: test, trigger: {include: [{artifact: out.yml, job: gen}]}}
`;
    expect(child(tree(main, { 'artifact:gen:out.yml': CHILD }), 'trig').result!.errors)
      .toContain('Job \`gen\` not found in parent pipeline or does not have artifacts!');
  });
});
});
