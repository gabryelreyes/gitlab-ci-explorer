import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildConfig, evaluatePipeline, makeScenario, type Scenario } from '../src/index.js';

const push = makeScenario('push', { branch: 'main' });
const build = (main: string, files: Record<string, string> = {}, scenario: Scenario = push) => buildConfig(main, { files, scenario });
const job = (cfg: ReturnType<typeof build>, name: string) => cfg.jobs.find((j) => j.name === name);

describe('include: merging', () => {
  it('merges a local include; the including file wins and arrays are replaced', () => {
    const cfg = build('include: ci/a.yml\nvariables: {A: main}\nj: {script: [main]}', {
      'local:ci/a.yml': 'variables: {A: inc, B: inc}\nj: {script: [inc, inc2], stage: build}\nk: {script: [k]}',
    });
    expect(cfg.errors).toEqual([]);
    expect(cfg.variables).toMatchObject({ A: { value: 'main' }, B: { value: 'inc' } });
    expect(job(cfg, 'j')).toMatchObject({ raw: { script: ['main'] }, stage: 'build' });
    expect(job(cfg, 'k')).toBeDefined();
    expect(cfg.includes).toMatchObject([{ type: 'local', key: 'local:ci/a.yml', resolved: true, from: '.gitlab-ci.yml' }]);
  });

  it('later includes override earlier ones', () => {
    const cfg = build('include: [a.yml, b.yml]', { 'local:a.yml': 'j: {script: [a]}', 'local:b.yml': 'j: {script: [b]}' });
    expect(job(cfg, 'j')?.raw.script).toEqual(['b']);
  });

  it('resolves extends and !reference across files after merging', () => {
    const cfg = build('include: /t.yml\nj: {extends: .t, script: [!reference [.s, script]]}', {
      'local:t.yml': '.t: {stage: deploy}\n.s: {script: [from-include]}',
    });
    expect(cfg.errors).toEqual([]);
    expect(job(cfg, 'j')).toMatchObject({ stage: 'deploy', raw: { script: ['from-include'] } });
  });

  it('processes nested includes; the nested file is merged first', () => {
    const cfg = build('include: a.yml', { 'local:a.yml': 'include: b.yml\nj: {script: [a]}', 'local:b.yml': 'j: {script: [b], stage: build}' });
    expect(job(cfg, 'j')).toMatchObject({ raw: { script: ['a'] }, stage: 'build' });
    expect(cfg.includes.map((i) => [i.key, i.from])).toEqual([['local:a.yml', '.gitlab-ci.yml'], ['local:b.yml', 'a.yml']]);
  });

  it('keeps going in standalone mode when a file is not provided', () => {
    const cfg = build('include: [missing.yml, a.yml]\nj: {script: [x]}', { 'local:a.yml': 'k: {script: [k]}' });
    expect(cfg.errors).toEqual([]);
    expect(cfg.includes.map((i) => i.resolved)).toEqual([false, true]);
    expect(job(cfg, 'k')).toBeDefined();
    expect(cfg.warnings[0]).toMatch(/Standalone mode .*1 include\(s\) not provided.*local:missing\.yml/);
  });

  it('expands one project include per file with a stable key', () => {
    const cfg = build("include: {project: 'Grp/Tools', ref: v1, file: [/a.yml, b.yml]}");
    expect(cfg.includes.map((i) => [i.key, i.target])).toEqual([
      ['project:grp/tools:a.yml', 'Grp/Tools:a.yml@v1'],
      ['project:grp/tools:b.yml', 'Grp/Tools:b.yml@v1'],
    ]);
  });

  it('resolves local includes inside a project file in that project', () => {
    const cfg = build('include: {project: g/p, file: a.yml}', { 'project:g/p:a.yml': 'include: b.yml', 'project:g/p:b.yml': 'k: {script: [k]}' });
    expect(cfg.includes.map((i) => i.key)).toEqual(['project:g/p:a.yml', 'project:g/p:b.yml']);
    expect(job(cfg, 'k')).toBeDefined();
  });

  it('detects remote URLs in the string form and component addresses', () => {
    const cfg = build('include: [https://x.example/ci.yml, {component: gitlab.example.com/g/c/lint@1.0}, {template: Jobs/SAST.gitlab-ci.yml}]');
    expect(cfg.includes.map((i) => [i.type, i.key])).toEqual([
      ['remote', 'remote:https://x.example/ci.yml'],
      ['component', 'component:gitlab.example.com/g/c/lint@1.0'],
      ['template', 'template:Jobs/SAST.gitlab-ci.yml'],
    ]);
  });

  it('matches local wildcards against provided files', () => {
    const cfg = build("include: 'ci/**/*.yml'", { 'local:ci/a.yml': 'a: {script: [a]}', 'local:ci/sub/b.yml': 'b: {script: [b]}', 'local:other.yml': 'c: {script: [c]}' });
    expect(cfg.jobs.map((j) => j.name).sort()).toEqual(['a', 'b']);
  });
});

describe('include: variables and rules', () => {
  it('expands predefined/user variables in include paths, not YAML variables', () => {
    const sc = { ...push, userVariables: { FLAVOR: 'fw' } };
    const cfg = build('variables: {Y: yaml}\ninclude: [ci/$CI_COMMIT_REF_NAME-$FLAVOR.yml, ci/$Y.yml]', {}, sc);
    expect(cfg.includes.map((i) => i.file)).toEqual(['ci/main-fw.yml', 'ci/.yml']);
  });

  it('skips includes whose rules do not match', () => {
    const yml = 'include:\n  - local: a.yml\n    rules: [{if: $CI_COMMIT_TAG}]\n  - local: b.yml\n    rules: [{if: $CI_COMMIT_BRANCH, when: never}]\n  - local: c.yml\n    rules: [{if: $CI_COMMIT_BRANCH, when: always}]';
    const files = { 'local:a.yml': 'a: {script: [a]}', 'local:b.yml': 'b: {script: [b]}', 'local:c.yml': 'c: {script: [c]}' };
    const cfg = build(yml, files);
    expect(cfg.jobs.map((j) => j.name)).toEqual(['c']);
    expect(cfg.includes.map((i) => !!i.skipped)).toEqual([true, true, false]);
    expect(build(yml, files, makeScenario('tag', { tag: 'v1' })).jobs.map((j) => j.name).sort()).toEqual(['a']);
  });

  it('rejects unsupported include rule keys and when values', () => {
    const cfg = build('include: [{local: a.yml, rules: [{if: $X, when: manual, needs: [x]}]}]');
    expect(cfg.errors).toEqual(expect.arrayContaining(['include:rule config contains unknown keys: needs', 'include:rule when unknown value: manual']));
  });
});

describe('include: errors', () => {
  it('limits the total number of includes to 150', () => {
    const cfg = build('include: a.yml', { 'local:a.yml': 'include: a.yml\nj: {script: [x]}' });
    expect(cfg.errors).toContain('Maximum of 150 nested includes are allowed!');
  });

  it('requires a YAML extension', () => {
    expect(build('include: ci/a.txt').errors).toContain('Included file `ci/a.txt` does not have YAML extension!');
  });

  it('rejects a local include inside a remote file', () => {
    const cfg = build('include: https://x.example/a.yml', { 'remote:https://x.example/a.yml': 'include: b.yml' });
    expect(cfg.errors).toContain('Local file `b.yml` does not have project!');
  });

  it('reports entries without a valid subkey or with several', () => {
    expect(build('include: [{foo: x}]').errors[0]).toMatch(/does not have a valid subkey for include/);
    expect(build('include: [{local: a.yml, remote: https://x/a.yml}]').errors[0]).toMatch(/^Each include must use only one of/);
    expect(build('include: [1]').errors).toContain('Each include must be a hash or a string');
  });

  it('rejects an empty included file', () => {
    expect(build('include: a.yml', { 'local:a.yml': '  \n' }).errors).toContain('Local file `a.yml` is empty!');
  });
});

describe('spec:inputs', () => {
  const header = "spec:\n  inputs:\n    env: {default: dev, options: [dev, prod]}\n    replicas: {type: number, default: 1}\n    debug: {type: boolean, default: false}\n    tags: {type: array, default: [a, b]}\n---\n";

  it('interpolates pipeline inputs (typed for whole values, text otherwise)', () => {
    const body = 'deploy-$[[ inputs.env ]]:\n  script: ["echo $[[ inputs.env ]]"]\n  variables: {N: "$[[ inputs.replicas ]]", D: "x$[[ inputs.debug ]]", T: "x$[[ inputs.tags ]]"}\n  tags: $[[ inputs.tags ]]\n  rules:\n    - if: $CI_COMMIT_BRANCH == "$[[ inputs.env ]]"';
    const cfg = build(header + body, {}, { ...push, inputs: { env: 'prod', replicas: '3' } });
    expect(cfg.errors).toEqual([]);
    const j = job(cfg, 'deploy-prod')!;
    expect(j.raw.script).toEqual(['echo prod']);
    expect(j.variables).toMatchObject({ N: { value: '3' }, D: { value: 'xfalse' }, T: { value: 'x["a", "b"]' } });
    expect(j.raw?.tags).toEqual(['a', 'b']);
    expect(j.rules?.[0]?.if).toBe('$CI_COMMIT_BRANCH == "prod"');
  });

  it('validates pipeline inputs against the spec', () => {
    const errs = (inputs: Record<string, unknown>, h = header) => build(`${h}j: {script: [x]}`, {}, { ...push, inputs }).errors;
    expect(errs({ env: 'qa' })[0]).toBe('`.gitlab-ci.yml`: `env` input: `qa` cannot be used because it is not in the list of allowed options');
    expect(errs({ replicas: 'many' })[0]).toBe('`.gitlab-ci.yml`: `replicas` input: provided value is not a number');
    expect(errs({ nope: 1 })[0]).toBe('`.gitlab-ci.yml`: unknown input arguments: nope');
    expect(errs({}, 'spec:\n  inputs:\n    region:\n---\n')[0]).toBe('`.gitlab-ci.yml`: `region` input: required value has not been provided');
    expect(errs({ v: 'abc' }, "spec:\n  inputs:\n    v: {regex: '^\\d+$'}\n---\n")[0]).toBe('`.gitlab-ci.yml`: `v` input: provided value does not match required RegEx pattern');
    expect(errs({}, 'spec:\n  inputs:\n    v: {type: list}\n---\n')[0]).toBe('`.gitlab-ci.yml`: header:spec:inputs:v input type unknown value: list');
  });

  it('passes include:inputs to the included file only', () => {
    const cfg = build('include: [{local: t.yml, inputs: {stage: deploy}}]', {
      'local:t.yml': 'spec:\n  inputs:\n    stage:\n---\nj:\n  stage: $[[ inputs.stage ]]\n  script: [x]',
    });
    expect(cfg.errors).toEqual([]);
    expect(job(cfg, 'j')?.stage).toBe('deploy');
  });

  it('reports include inputs for a file without spec, and unknown interpolations', () => {
    expect(build('include: [{local: t.yml, inputs: {a: 1}}]', { 'local:t.yml': 'j: {script: [x]}' }).errors)
      .toContain('`t.yml`: Given inputs not defined in the `spec` section of the included configuration file');
    expect(build('include: t.yml', { 'local:t.yml': 'spec:\n  inputs:\n    a: {default: x}\n---\nj: {script: ["$[[ inputs.b ]]"]}' }).errors)
      .toContain('`t.yml`: unknown interpolation provided: `b` in `inputs.b`');
  });

  it('leaves $[[ ]] untouched in files without a spec header', () => {
    expect(job(build('j: {script: ["$[[ inputs.a ]]"]}'), 'j')?.raw.script).toEqual(['$[[ inputs.a ]]']);
  });

  it('supports interpolation functions', () => {
    const h = "spec:\n  inputs:\n    s: {default: 'hello world'}\n---\n";
    const cfg = build(`${h}j: {script: ["$[[ inputs.s | truncate(0,5) ]]", "$[[ inputs.s | posix_escape ]]", "$[[ inputs.s | foo ]]"]}`);
    expect(cfg.errors[0]).toMatch(/no function matching `foo`/);
    const ok = build(`${h}j: {script: ["$[[ inputs.s | truncate(0,5) ]]", "$[[ inputs.s | posix_escape ]]"]}`);
    expect(job(ok, 'j')?.raw.script).toEqual(['hello', 'hello\\ world']);
  });

  it('evaluates pipeline inputs per scenario in the pipeline', () => {
    const yml = `${header}j:\n  script: [x]\n  rules: [{if: '"$[[ inputs.env ]]" == "prod"'}]`;
    const run = (env: string) => evaluatePipeline(build(yml, {}, { ...push, inputs: { env } }), push).jobs[0]!.included;
    expect([run('prod'), run('dev')]).toEqual([true, false]);
  });
});

describe('inputs-demo fixture', () => {
  const dir = new URL('./fixtures/inputs-demo/', import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, dir), 'utf8');
  const files = { 'local:ci/build.yml': read('ci/build.yml'), 'local:ci/hil.yml': read('ci/hil.yml'), 'project:grp/ci-templates:release.yml': read('release.yml') };
  const names = (inputs: Record<string, unknown>, sc: Scenario = push) =>
    evaluatePipeline(build(read('.gitlab-ci.yml'), files, { ...sc, inputs }), sc).jobs.filter((j) => j.included).map((j) => j.name).sort();

  it('builds the selected target and adds HIL only when asked', () => {
    expect(names({})).toEqual(['build:stm32f4', 'unit-tests']);
    expect(names({ target: 'esp32', run_hil: 'true' })).toEqual(['build:esp32', 'hil-tests', 'unit-tests']);
    expect(names({}, makeScenario('tag', { tag: 'v1.2.3' }))).toEqual(['build:stm32f4', 'release', 'unit-tests']);
  });
});
