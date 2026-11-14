// Real-world pipeline (structure of realtest/.gitlab-ci.yml) across pipeline types.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, makeScenario, type Scenario } from '../src/index.js';

const yml = readFileSync(fileURLToPath(new URL('./fixtures/realtest-repaired.yml', import.meta.url)), 'utf8');
const live = (sc: Scenario) => {
  const r = analyze(yml, sc);
  return { r, jobs: r.jobs.filter((j) => j.included).map((j) => j.name).sort() };
};
const CHECKS = ['clang_format_check', 'doxygen-job_Check_Code', 'project_init_check', 'unit_test'];

describe('realtest pipeline', () => {
  it('MR pipeline: checks + unit tests only', () => {
    const { r, jobs } = live(makeScenario('merge_request_event', { mrSource: 'feature/x' }));
    expect(r.errors).toEqual([]);
    expect(jobs).toEqual(CHECKS);
  });

  it('feature branch with open MR: no branch pipeline', () => {
    expect(live(makeScenario('push', { branch: 'feature/x', openMr: true })).r.created).toBe(false);
  });

  it('main: docs + pages + root_page', () => {
    const { r, jobs } = live(makeScenario('push', { branch: 'main' }));
    expect(r.created).toBe(true);
    expect(jobs).toEqual([...CHECKS, 'doxygen-job_generateDocumentation', 'pages', 'root_page'].sort());
    expect(r.jobs.find((j) => j.name === 'root_page')!.needs!.map((n) => n.job)).toEqual(['pages']);
  });

  it('release tag: release jobs; Confluence/Jira only when enabled', () => {
    const tag = makeScenario('tag', { tag: 'v1.2.3' });
    const off = live(tag);
    expect(off.r.created).toBe(true);
    expect(off.jobs).toEqual([...CHECKS, 'doxygen-job_generateDocumentation', 'read_release', 'release_pages', 'root_page'].sort());
    const on = live({ ...tag, userVariables: { GP_JIRA_ISSUE_ENABLE: 'true', GP_CONFLUENCE_BLOG_ENTRY_ENABLE: 'true' } });
    expect(on.jobs).toContain('create_jira_issue');
    expect(on.jobs).toContain('create_confluence_blog_entry');
  });

  it('non-release tag: no docs, Jira job excluded', () => {
    const { r, jobs } = live({ ...makeScenario('tag', { tag: 'nightly' }), userVariables: { GP_JIRA_ISSUE_ENABLE: 'true' } });
    expect(r.created).toBe(true);
    expect(jobs).toEqual(CHECKS);
  });

  it('clang format check can be disabled via variable', () => {
    const { jobs } = live({ ...makeScenario('push', { branch: 'main' }), userVariables: { GP_ENABLE_CLANG_FORMAT_CHECK: 'false' } });
    expect(jobs).not.toContain('clang_format_check');
  });
});
