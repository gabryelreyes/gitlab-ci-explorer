// Behaviours verified against GitLab source (lib/gitlab/ci/**) during review.
import { describe, expect, it } from 'vitest';
import { analyze, makeScenario, type Scenario } from '../src/index.js';
import { evaluateExpression, parseExpression } from '../src/expr/index.js';
import { fnmatch } from '../src/util/fnmatch.js';

const push = (branch = 'feature/x', extra: Partial<Scenario> = {}) => ({ ...makeScenario('push', { branch }), ...extra });
const mr = makeScenario('merge_request_event', { mrSource: 'feature/x' });
const tag = makeScenario('tag', { tag: 'v1' });
const job = (yml: string, sc: Scenario, name: string) => analyze(yml, sc).jobs.find((j) => j.name === name)!;
const errs = (yml: string, sc: Scenario = push()) => analyze(yml, sc).errors.join('\n');

describe('only/except defaults (entry/processable.rb)', () => {
  it('with workflow:rules, jobs without rules have no default only and run in MR pipelines', () => {
    const yml = 'workflow: {rules: [{when: always}]}\nj: {script: x}';
    expect(job(yml, mr, 'j').included).toBe(true);
  });
});

describe('rules:if sees raw (unexpanded) variable values (LazyHash#fetch)', () => {
  it('does not expand nested variables', () => {
    const yml = 'variables: {E: "x-$CI_COMMIT_BRANCH"}\nj: {script: x, rules: [{if: $E == "x-dev"}]}\nk: {script: x, rules: [{if: $E == "x-$CI_COMMIT_BRANCH"}]}';
    expect(job(yml, push('dev'), 'j').included).toBe(false);
    expect(job(yml, push('dev'), 'k').included).toBe(true);
  });
  it('job result still exposes expanded variables', () => {
    const yml = 'variables: {E: "x-$CI_COMMIT_BRANCH"}\nj: {script: x}';
    expect(job(yml, push('dev'), 'j').variables.E).toBe('x-dev');
  });
});

describe('regex (RubySyntax → RE2 inline flags)', () => {
  it('m is multiline (^/$ per line), s is dot-all', () => {
    expect(evaluateExpression('$A =~ /^b$/m', { A: 'a\nb' }).result).toBe(true);
    expect(evaluateExpression('$A =~ /a.b/m', { A: 'a\nb' }).result).toBe(false);
    expect(evaluateExpression('$A =~ /a.b/s', { A: 'a\nb' }).result).toBe(true);
  });
  it('\\A and \\z stay text anchors under m', () => {
    expect(evaluateExpression('$A =~ /\\Ab/m', { A: 'a\nb' }).result).toBe(false);
  });
  it('\\Z is rejected (RE2)', () => {
    expect(evaluateExpression('$A =~ /a\\Z/', { A: 'a' }).error).toBeTruthy();
  });
  it('variable holding /a/b/ is parsed greedily', () => {
    expect(evaluateExpression('$A =~ $P', { A: 'xa/by', P: '/a/b/' }).result).toBe(true);
  });
  it('one-character literal pattern is a syntax error', () => {
    expect(() => parseExpression('$A =~ /a/')).toThrow();
  });
  it('99 tokens parse, 100 are too many', () => {
    const t99 = Array.from({ length: 50 }, () => '$A').join(' || '); // 2n-1 = 99 tokens
    expect(() => parseExpression(t99)).not.toThrow();
    expect(() => parseExpression(`!${t99}`)).toThrow(/too many/i);
  });
});

describe('changes / fnmatch', () => {
  it('compare_to disables the always-true shortcuts', () => {
    const yml = 'j: {script: x, rules: [{changes: {paths: [src/*], compare_to: main}}]}';
    expect(job(yml, { ...tag, changedFiles: [] }, 'j').included).toBe(false);
  });
  it('Ruby fnmatch: ** is recursive only before /, braces, no negation', () => {
    expect(fnmatch('docs/**', 'docs/a/b')).toBe(false);
    expect(fnmatch('docs/**', 'docs/a')).toBe(true);
    expect(fnmatch('docs/**/*', 'docs/a/b')).toBe(true);
    expect(fnmatch('src/**/*.c', 'src/x.c')).toBe(true);
    expect(fnmatch('*.md', 'a/b.md')).toBe(false);
    expect(fnmatch('*.{c,h}', 'x.h')).toBe(true);
    expect(fnmatch('*', '.hidden')).toBe(true);
    expect(fnmatch('!a', 'b')).toBe(false);
    expect(fnmatch('[!a]b', 'cb')).toBe(true);
  });
  it('unknown variables in paths are kept as written', () => {
    const yml = 'j: {script: x, rules: [{changes: [$NOPE/x]}]}';
    expect(job(yml, push('f', { changedFiles: ['$NOPE/x'] }), 'j').included).toBe(true);
  });
});

describe('needs / dependencies validation (yaml_processor.rb)', () => {
  it('optional need on an undefined job is fine', () => {
    expect(errs('a: {script: x, needs: [{job: ghost, optional: true}]}')).toBe('');
  });
  it('need in a later stage is an error', () => {
    expect(errs('a: {stage: build, script: x, needs: [b]}\nb: {stage: test, script: x}'))
      .toMatch('a job: need b is not defined in current or prior stages');
  });
  it('undefined need / dependency are errors', () => {
    expect(errs('a: {script: x, needs: [ghost]}')).toMatch('a job: undefined need: ghost');
    expect(errs('a: {script: x, dependencies: [ghost]}')).toMatch('a job: undefined dependency: ghost');
  });
  it('duplicated needs are an error', () => {
    expect(errs('a: {stage: build, script: x}\nb: {script: x, needs: [a, a]}')).toMatch('b has the following needs duplicated: a.');
  });
});

describe('allow_failure / validation', () => {
  it('allow_failure: {exit_codes} counts as false for blocking', () => {
    expect(job('j: {script: x, when: manual, allow_failure: {exit_codes: [1]}}', push(), 'j').blocking).toBe(true);
  });
  it('job-level when: never is invalid', () => {
    expect(errs('j: {script: x, when: never}')).toMatch(/when/);
  });
  it('start_in without delayed, or with rules, is invalid', () => {
    expect(errs('j: {script: x, start_in: 1 min}')).toMatch(/start_in/);
    expect(errs('j: {script: x, when: delayed, start_in: 1 min, rules: [{when: always}]}')).toMatch(/start_in/);
  });
  it('a key in both top level and default: is an error', () => {
    expect(errs('image: a\ndefault: {image: b}\nj: {script: x}')).toMatch('image is defined in top-level and `default:` entry');
  });
  it('invalid rules:if is a config error', () => {
    expect(errs('j: {script: x, rules: [{if: "$A = 1"}]}')).toMatch(/invalid expression syntax/i);
    expect(errs('j: {script: x, only: {variables: ["$A ="]}}')).toMatch(/invalid expression syntax/i);
  });
  it('workflow:auto_cancel in a workflow rule is allowed', () => {
    expect(errs('workflow: {rules: [{if: $A, auto_cancel: {on_new_commit: none}}, {when: always}]}\nj: {script: x}')).toBe('');
  });
});

describe('workflow rule variables honour inherit:variables', () => {
  it('filters workflow vars with inherit:variables: false', () => {
    const yml = `
workflow: {rules: [{variables: {W: "1"}}]}
j: {script: x, inherit: {variables: false}, rules: [{if: $W}]}
k: {script: x, rules: [{if: $W}]}`;
    expect(job(yml, push(), 'j').included).toBe(false);
    expect(job(yml, push(), 'k').included).toBe(true);
  });
});

describe('only/except refs (policy/refs.rb)', () => {
  it('source keywords: singular and pluralized; parent_pipeline is not "pipelines"', () => {
    const yml = 'a: {script: x, only: [push]}\nb: {script: x, only: [pipelines]}';
    expect(job(yml, push(), 'a').included).toBe(true);
    expect(job(yml, makeScenario('parent_pipeline'), 'b').included).toBe(false);
  });
  it('names and regexes never match in MR pipelines', () => {
    expect(job('a: {script: x, only: [feature/x]}', mr, 'a').included).toBe(false);
  });
});

describe('presets', () => {
  it('MR pipelines have CI_OPEN_MERGE_REQUESTS and CI_MERGE_REQUEST_DRAFT', () => {
    expect(mr.variables.CI_OPEN_MERGE_REQUESTS).toBe('group/project!1');
    expect(mr.variables.CI_MERGE_REQUEST_DRAFT).toBe('false');
  });
  it('tags are not protected by default', () => {
    expect(tag.variables.CI_COMMIT_REF_PROTECTED).toBe('false');
  });
});
