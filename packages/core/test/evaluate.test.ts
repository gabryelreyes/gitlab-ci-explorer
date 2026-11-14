import { describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import { makeScenario, type Scenario } from '../src/scenario/presets.js';

const run = (yml: string, sc: Scenario) => analyze(yml, sc);
const jobOf = (yml: string, sc: Scenario, name: string) => {
  const r = run(yml, sc);
  const j = r.jobs.find((x) => x.name === name);
  if (!j) throw new Error(`no job ${name}`);
  return j;
};
const push = (branch = 'feature/x', extra: Partial<Scenario> = {}) => ({ ...makeScenario('push', { branch }), ...extra });
const mr = makeScenario('merge_request_event', { mrSource: 'feature/x', mrTarget: 'main' });
const tag = makeScenario('tag', { tag: 'v1.0.0' });
const schedule = makeScenario('schedule', { branch: 'main' });

describe('presets', () => {
  it('branch push', () => {
    const v = push('dev').variables;
    expect(v).toMatchObject({ CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'dev', CI_COMMIT_REF_NAME: 'dev', CI_DEFAULT_BRANCH: 'main' });
    expect(v.CI_COMMIT_TAG).toBeUndefined();
  });
  it('tag pipeline has no CI_COMMIT_BRANCH', () => {
    expect(tag.variables.CI_COMMIT_TAG).toBe('v1.0.0');
    expect(tag.variables.CI_COMMIT_BRANCH).toBeUndefined();
  });
  it('MR pipeline has MR vars and no CI_COMMIT_BRANCH', () => {
    expect(mr.variables).toMatchObject({
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feature/x',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main',
      CI_MERGE_REQUEST_EVENT_TYPE: 'detached',
      CI_COMMIT_REF_NAME: 'feature/x',
    });
    expect(mr.variables.CI_COMMIT_BRANCH).toBeUndefined();
  });
});

describe('workflow:rules', () => {
  const yml = `
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH
      variables: {DEPLOY_ENV: dev}
j:
  script: x
  rules:
    - if: $DEPLOY_ENV == "dev"
    - if: $CI_MERGE_REQUEST_IID
`;
  it('creates the pipeline when a rule matches; workflow vars reach job rules', () => {
    const r = run(yml, push());
    expect(r.created).toBe(true);
    expect(r.workflow.matchedIndex).toBe(2);
    expect(r.jobs[0]).toMatchObject({ included: true, when: 'on_success' });
    expect(r.jobs[0]!.trace.matchedIndex).toBe(0);
  });
  it('when: never blocks the pipeline', () => {
    const r = run(yml, push('feature/x', { variables: { ...push().variables, CI_OPEN_MERGE_REQUESTS: 'g/p!1' } }));
    expect(r.created).toBe(false);
    expect(r.workflow.matchedIndex).toBe(1);
  });
  it('no matching rule => no pipeline', () => {
    const r = run(yml, tag);
    expect(r.created).toBe(false);
    expect(r.workflow.reason).toMatch(/no workflow rule matched/i);
  });
});

describe('job rules', () => {
  it('first match wins; no match excludes; trace shows expanded expression', () => {
    const yml = `
j:
  script: x
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: manual
    - if: $CI_COMMIT_BRANCH =~ /^feature/
      when: delayed
      start_in: 5 min
    - when: never
`;
    const a = jobOf(yml, push('main'), 'j');
    expect(a).toMatchObject({ included: true, when: 'manual', allowFailure: false, blocking: true });
    const b = jobOf(yml, push('feature/y'), 'j');
    expect(b).toMatchObject({ included: true, when: 'delayed', startIn: '5 min' });
    expect(b.trace.rules[0]!.clauses[0]).toMatchObject({ kind: 'if', expanded: '"feature/y" == "main"', result: false });
    const c = jobOf(yml, tag, 'j');
    expect(c.included).toBe(false);
    expect(c.trace.matchedIndex).toBe(2);
    expect(jobOf('j: {script: x, rules: [{if: $NOPE}]}', push(), 'j')).toMatchObject({ included: false, reason: expect.stringMatching(/no rule matched/i) });
  });

  it('job-level when: manual without rules is non-blocking', () => {
    expect(jobOf('j: {script: x, when: manual}', push(), 'j')).toMatchObject({ when: 'manual', allowFailure: true, blocking: false });
  });

  it('jobs without rules/only/except default to branches+tags (not MR pipelines)', () => {
    expect(jobOf('j: {script: x}', push(), 'j').included).toBe(true);
    expect(jobOf('j: {script: x}', tag, 'j').included).toBe(true);
    expect(jobOf('j: {script: x}', mr, 'j').included).toBe(false);
  });

  it('variable precedence: job > global; user vars > yaml; rule vars applied after match', () => {
    const yml = `
variables: {LEVEL: global}
j:
  script: x
  variables: {LEVEL: job}
  rules:
    - if: $LEVEL == "job"
      variables: {LEVEL: rule}
`;
    const j = jobOf(yml, push('dev'), 'j');
    expect(j.included).toBe(true);
    expect(j.variables.LEVEL).toBe('rule');
    const u = jobOf(yml, push('dev', { userVariables: { LEVEL: 'user' } }), 'j');
    expect(u.included).toBe(false);
  });

  it('rules:needs overrides job needs', () => {
    const yml = `
a: {script: x}
b: {script: x}
c:
  script: x
  needs: [a]
  rules: [{if: $CI_COMMIT_BRANCH, needs: [b]}]
`;
    expect(jobOf(yml, push(), 'c').needs!.map((n) => n.job)).toEqual(['b']);
  });
});

describe('changes / exists', () => {
  const yml = `
j:
  script: x
  rules:
    - changes: ["src/**/*.c", Dockerfile]
k:
  script: x
  rules:
    - exists: [Cargo.toml]
`;
  it('matches changed files with globs', () => {
    expect(jobOf(yml, push('f', { changedFiles: ['src/a/b.c'] }), 'j').included).toBe(true);
    expect(jobOf(yml, push('f', { changedFiles: ['README.md'] }), 'j').included).toBe(false);
  });
  it('is assumed true without a changed-files list, and noted', () => {
    const j = jobOf(yml, push(), 'j');
    expect(j.included).toBe(true);
    expect(j.trace.rules[0]!.clauses[0]!.note).toMatch(/assumed/);
  });
  it('is always true where GitLab cannot compute changes (schedule, tag)', () => {
    expect(jobOf(yml, { ...schedule, changedFiles: [] }, 'j').included).toBe(true);
    expect(jobOf(yml, { ...tag, changedFiles: [] }, 'j').included).toBe(true);
  });
  it('honours per-clause overrides', () => {
    expect(jobOf(yml, push('f', { overrides: { 'j#0.changes': false } }), 'j').included).toBe(false);
  });
  it('exists checks the repo file list', () => {
    expect(jobOf(yml, push('f', { repoFiles: ['Cargo.toml'] }), 'k').included).toBe(true);
    expect(jobOf(yml, push('f', { repoFiles: ['go.mod'] }), 'k').included).toBe(false);
  });
});

describe('only / except', () => {
  it('refs keywords, names and regexes', () => {
    const yml = `
a: {script: x, only: [main]}
b: {script: x, only: [merge_requests]}
c: {script: x, except: [tags]}
d: {script: x, only: ['/^release-.*$/']}
e: {script: x, only: {refs: [branches], variables: ['$DEPLOY == "1"']}}
`;
    const names = (sc: Scenario) => run(yml, sc).jobs.filter((j) => j.included).map((j) => j.name);
    expect(names(push('main'))).toEqual(['a', 'c']);
    expect(names(push('release-2'))).toEqual(['c', 'd']);
    expect(names(mr)).toEqual(['b']);
    expect(names(tag)).toEqual([]);
    expect(names(push('x', { userVariables: { DEPLOY: '1' } }))).toEqual(['c', 'e']);
  });
});

describe('pipeline-level outcome', () => {
  it('needs on an excluded job is a creation error; optional needs are dropped', () => {
    const yml = `
build: {script: x, rules: [{if: $CI_COMMIT_TAG}]}
test: {script: x, needs: [build]}
lint: {script: x, needs: [{job: build, optional: true}]}
`;
    const r = run(yml, push());
    expect(r.created).toBe(false);
    expect(r.errors.join()).toMatch(/'test' job needs 'build' job, but 'build' does not exist in the pipeline/);
    expect(r.jobs.find((j) => j.name === 'lint')!.needs).toEqual([]);
  });
  it('no jobs => not created', () => {
    const r = run('j: {script: x, rules: [{when: never}]}', push());
    expect(r.created).toBe(false);
    expect(r.errors.join()).toMatch(/prevented any jobs/i);
  });
  it('only .pre/.post jobs => not created', () => {
    const r = run('p: {stage: .pre, script: x}', push());
    expect(r.created).toBe(false);
  });
  it('config errors prevent creation', () => {
    const r = run('j: {stage: nope, script: x}', push());
    expect(r.created).toBe(false);
    expect(r.errors.join()).toMatch(/chosen stage/);
  });
});
