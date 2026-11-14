import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli-lib.js';

const fx = fileURLToPath(new URL('./fixtures/embedded.yml', import.meta.url));
const cli = (...args: string[]) => runCli([fx, ...args]);

describe('cli', () => {
  it('MR pipeline: table with when/notes and workflow outcome', () => {
    const r = cli('--preset', 'mr', '--mr-source', 'feat/x');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CREATED/);
    expect(r.out).toMatch(/build:fw\s+on_success/);
    expect(r.out).toMatch(/hil-tests\s+manual/);
    expect(r.out).toMatch(/deploy:prod\s+—\s+excluded/);
  });

  it('feature branch with open MR: no pipeline', () => {
    const r = cli('--branch', 'feat/x', '--open-mr');
    expect(r.out).toMatch(/NOT CREATED/);
    expect(r.out).toMatch(/workflow rule #1/);
  });

  it('tag pipeline surfaces the needs error', () => {
    const r = cli('--preset', 'tag', '--tag', 'v1.2.3');
    expect(r.out).toMatch(/NOT CREATED/);
    expect(r.out).toMatch(/'unit-tests' job needs 'build:fw' job/);
  });

  it('--set overrides gate variables; --trace prints expanded rules', () => {
    const r = cli('--branch', 'main', '--set', 'RUN_HIL=true', '--trace');
    expect(r.out).toMatch(/hil-tests\s+on_success/);
    expect(r.out).toContain('"true" == "true"');
  });

  it('--changed feeds changes: clauses', () => {
    const r = cli('--preset', 'tag', '--tag', 'v1.2.3', '--trace');
    expect(r.out).toMatch(/always true for tag pipelines/);
  });

  it('--gates lists gate variables', () => {
    const r = cli('--gates');
    expect(r.out).toMatch(/RUN_HIL.*"true"/);
  });

  it('--matrix shows jobs x presets', () => {
    const r = cli('--matrix');
    expect(r.out.split('\n')[0]).toMatch(/push:main.*mr.*tag.*schedule/);
    expect(r.out).toMatch(/nightly-cleanup/);
  });

  it('--json emits the full result', () => {
    const j = JSON.parse(cli('--json').out);
    expect(j.result.created).toBe(true);
    expect(j.scenario.variables.CI_COMMIT_BRANCH).toBe('main');
  });

  it('usage error on missing file', () => {
    expect(runCli([]).code).toBe(2);
  });

describe('cli --matrix regressions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gce-'));
  const write = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };

  it('--tag does not turn the schedule/web columns into tag pipelines', () => {
    const f = write('tag.yml', 'b: {script: x, rules: [{if: $CI_COMMIT_BRANCH}]}\nt: {script: x, rules: [{if: $CI_COMMIT_TAG}]}\n');
    const rows = runCli([f, '--matrix', '--tag', 'v2']).out.split('\n').map((l) => l.trim().split(/\s+/));
    const col = (name: string) => rows[0]!.indexOf(name);
    const row = (name: string) => rows.find((r) => r[0] === name)!;
    for (const c of ['schedule', 'web']) {
      expect(row('b')[col(c)]).toBe('●');
      expect(row('t')[col(c)]).toBe('·');
    }
    expect(row('t')[col('tag')]).toBe('●');
  });

  it('lists the union of jobs when include:rules differ per column', () => {
    const inc = write('sched.yml', 'only-sched: {script: x}\n');
    const f = write('union.yml', 'include:\n  - local: sched.yml\n    rules:\n      - if: $CI_PIPELINE_SOURCE == "schedule"\nalways: {script: x}\n');
    const r = runCli([f, '--matrix', '--include', `local:sched.yml=${inc}`]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^only-sched\s+–\s+–\s+–\s+–\s+●\s+–$/m);
    expect(r.out).toMatch(/^always\s+●\s+●\s+·(\s+●){3}$/m);
  });
});
});
