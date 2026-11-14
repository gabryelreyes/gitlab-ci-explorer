import { describe, expect, it } from 'vitest';
import { buildConfig, evaluatePipeline, makeScenario } from '../src/index.js';

const push = makeScenario('push', { branch: 'main' });
const cfgOf = (y: string) => buildConfig(y, { scenario: push });
const names = (y: string) => cfgOf(y).jobs.map((j) => j.name);
const run = (y: string) => evaluatePipeline(cfgOf(y), push);

describe('parallel: N', () => {
  it('expands to "name i/N" with CI_NODE_INDEX/CI_NODE_TOTAL', () => {
    const cfg = cfgOf('t: {script: x, parallel: 3}');
    expect(cfg.errors).toEqual([]);
    expect(cfg.jobs.map((j) => j.name)).toEqual(['t 1/3', 't 2/3', 't 3/3']);
    expect(cfg.jobs[1]!.parallel).toEqual({ group: 't', instance: 2, total: 3 });
    expect(run('t: {script: x, parallel: 3}').jobs[2]!.variables).toMatchObject({ CI_NODE_INDEX: '3', CI_NODE_TOTAL: '3' });
  });

  it('validates the number', () => {
    expect(cfgOf('t: {script: x, parallel: 0}').errors).toContain('jobs:t:parallel config must be greater than or equal to 1');
    expect(cfgOf('t: {script: x, parallel: 201}').errors).toContain('jobs:t:parallel config must be less than or equal to 200');
    expect(cfgOf('t: {script: x, parallel: 1.5}').errors).toContain('jobs:t:parallel config must be an integer');
    expect(cfgOf('t: {script: x, parallel: abc}').errors).toContain('jobs:t:parallel should be an integer or a hash');
  });

  it('trigger jobs cannot use a number', () => {
    expect(cfgOf('t: {trigger: {include: c.yml}, parallel: 2}').errors).toContain('jobs:t:parallel config cannot use "parallel: <number>".');
  });
});

describe('parallel:matrix', () => {
  const y = `
build:
  script: make
  variables: {OPT: O2, TARGET: yaml}
  parallel:
    matrix:
      - TARGET: [stm32, esp32]
        MODE: [debug, release]
      - TARGET: host
`;
  it('expands the product of each entry in order; name lists the values', () => {
    expect(names(y)).toEqual([
      'build: [stm32, debug]', 'build: [stm32, release]', 'build: [esp32, debug]', 'build: [esp32, release]', 'build: [host]',
    ]);
  });

  it('matrix values become job variables (override YAML) and are usable in rules', () => {
    const r = run(`${y.replace('script: make', 'script: make\n  rules: [{if: $TARGET == "host", when: manual}, {when: on_success}]')}`);
    const host = r.jobs.find((j) => j.name === 'build: [host]')!;
    expect(host.variables).toMatchObject({ TARGET: 'host', OPT: 'O2', CI_NODE_INDEX: '5', CI_NODE_TOTAL: '5' });
    expect(host.when).toBe('manual');
    expect(r.jobs.find((j) => j.name === 'build: [stm32, debug]')!.when).toBe('on_success');
  });

  it('numbers are stringified', () => {
    expect(names('t: {script: x, parallel: {matrix: [{V: [1, 2.5]}]}}')).toEqual(['t: [1]', 't: [2.5]']);
  });

  it('validates the matrix', () => {
    expect(cfgOf('t: {script: x, parallel: {matrix: {A: 1}}}').errors).toContain('jobs:t:parallel:matrix config should be an array of hashes');
    expect(cfgOf('t: {script: x, parallel: {matrix: [{}]}}').errors).toContain('jobs:t:parallel:matrix:variables config requires at least 1 items');
    expect(cfgOf('t: {script: x, parallel: {matrix: [{A: {b: 1}}]}}').errors)
      .toContain('jobs:t:parallel:matrix:variables config should be a hash of key value pairs, value can be an array');
    expect(cfgOf('t: {script: x, parallel: {foo: 1}}').errors).toContain('jobs:t:parallel config contains unknown keys: foo');
    const big = `t: {script: x, parallel: {matrix: [{A: [${Array.from({ length: 15 }, (_, i) => i).join(',')}], B: [${Array.from({ length: 14 }, (_, i) => i).join(',')}]}]}}`;
    expect(cfgOf(big).errors).toContain('jobs:t:parallel:matrix config generates too many jobs (maximum is 200)');
  });
});

describe('needs / dependencies on parallel jobs', () => {
  const base = `
stages: [build, test]
build:
  stage: build
  script: x
  parallel: {matrix: [{TARGET: [a, b], MODE: [dbg, rel]}]}
`;
  it('a plain need expands to every instance', () => {
    const cfg = cfgOf(`${base}t: {stage: test, script: x, needs: [build], dependencies: [build]}`);
    expect(cfg.errors).toEqual([]);
    const t = cfg.jobs.find((j) => j.name === 't')!;
    expect(t.needs!.map((n) => n.job)).toEqual(['build: [a, dbg]', 'build: [a, rel]', 'build: [b, dbg]', 'build: [b, rel]']);
    expect(t.dependencies).toEqual(t.needs!.map((n) => n.job));
  });

  it('needs:parallel:matrix selects instances', () => {
    const cfg = cfgOf(`${base}t: {stage: test, script: x, needs: [{job: build, parallel: {matrix: [{TARGET: a, MODE: [dbg, rel]}]}}]}`);
    expect(cfg.jobs.find((j) => j.name === 't')!.needs!.map((n) => n.job)).toEqual(['build: [a, dbg]', 'build: [a, rel]']);
  });

  it('$[[ matrix.X ]] in needs uses the needing job\'s own matrix values', () => {
    const cfg = cfgOf(`${base}t:
  stage: test
  script: x
  parallel: {matrix: [{TARGET: [a, b]}]}
  needs: [{job: build, parallel: {matrix: [{TARGET: '$[[ matrix.TARGET ]]', MODE: rel}]}}]
`);
    expect(cfg.errors).toEqual([]);
    expect(cfg.jobs.find((j) => j.name === 't: [b]')!.needs!.map((n) => n.job)).toEqual(['build: [b, rel]']);
  });

  it('unknown matrix variable in needs', () => {
    const cfg = cfgOf(`${base}t:
  stage: test
  script: x
  parallel: {matrix: [{TARGET: [a]}]}
  needs: [{job: build, parallel: {matrix: [{TARGET: '$[[ matrix.NOPE ]]'}]}}]
`);
    expect(cfg.errors).toContain("t: [a] job: 'NOPE' does not exist in matrix configuration");
  });

  it('a need naming the wrong value order is undefined (names must match)', () => {
    const cfg = cfgOf(`${base}t: {stage: test, script: x, needs: [{job: build, parallel: {matrix: [{MODE: dbg, TARGET: a}]}}]}`);
    expect(cfg.errors).toContain('t job: undefined need: build: [dbg, a]');
  });

  it('a need on an instance excluded by rules is reported per instance', () => {
    const r = run(`${base.replace('script: x\n  parallel', 'script: x\n  rules: [{if: $TARGET == "b", when: never}, {when: on_success}]\n  parallel')}t: {stage: test, script: x, needs: [build]}`);
    expect(r.jobs.find((j) => j.name === 't')!.missingNeeds).toEqual(['build: [b, dbg]', 'build: [b, rel]']);
  });
});
